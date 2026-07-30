/**
 * Throwaway X.509 PKI for the execution-plane service tests.
 *
 * WHY HAND-ROLLED. The acceptance criteria need a real TLS 1.3 handshake with a
 * real CA, real client certificates, real URI subjectAltNames and real
 * extendedKeyUsage extensions — and the lane may add NO npm dependency. Shelling
 * out to the `openssl` CLI would make a REQUIRED test depend on a binary that is
 * not guaranteed in every runner/base image, so this module encodes the
 * certificates itself with `node:crypto` plus ~150 lines of DER. Everything here
 * is test-only: it is never imported by `src/service/*` and never shipped.
 *
 * Keys are P-256 (fast to generate — the whole suite mints a handful) and
 * certificates are signed `ecdsa-with-SHA256`; `crypto.sign` already emits the
 * DER ECDSA signature X.509 expects.
 *
 * Extensions emitted: basicConstraints (critical), extendedKeyUsage,
 * subjectAltName with `uniformResourceIdentifier` entries — the three the
 * authorization matrix in `mtls.ts` actually reads.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal DER
// ---------------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octetString = (content: Buffer): Buffer => tlv(0x04, content);
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
const explicit = (index: number, content: Buffer): Buffer => tlv(0xa0 | index, content);
/**
 * `GeneralName ::= CHOICE { ... uniformResourceIdentifier [6] IA5String ... }`
 * uses an IMPLICIT tag: the context tag REPLACES the IA5String tag, it does not
 * wrap it. Emitting a nested IA5String here makes OpenSSL read the tag+length
 * bytes as part of the URI text, which silently breaks byte-exact SAN matching.
 */
const uriGeneralName = (uri: string): Buffer => tlv(0x86, Buffer.from(uri, "ascii"));

function integer(value: number | Buffer): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    const out: number[] = [];
    let remaining = value;
    do {
      out.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    } while (remaining > 0);
    bytes = Buffer.from(out);
  } else {
    bytes = value;
  }
  // A leading high bit would read as negative in DER.
  if ((bytes[0] as number) & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(0x02, bytes);
}

function bitString(content: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => Number(p));
  const first = (parts[0] as number) * 40 + (parts[1] as number);
  const bytes: number[] = [first];
  for (const part of parts.slice(2)) {
    if (part < 0x80) {
      bytes.push(part);
      continue;
    }
    const chunk: number[] = [];
    let remaining = part;
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    chunk[chunk.length - 1] = (chunk[chunk.length - 1] as number) & 0x7f;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const OID_COMMON_NAME = "2.5.4.3";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

/** RDNSequence with a single CN. Never read for authorization — display only. */
function distinguishedName(commonName: string): Buffer {
  return seq(set(seq(objectIdentifier(OID_COMMON_NAME), utf8String(commonName))));
}

function utcTime(date: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, "0");
  const value =
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(value, "ascii"));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return seq(
    objectIdentifier(oid),
    ...(critical ? [boolean(true)] : []),
    octetString(value),
  );
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// Certificate minting
// ---------------------------------------------------------------------------

export type TestKeyPair = { publicKey: KeyObject; privateKey: KeyObject };

export type MintedCertificate = {
  certPem: string;
  keyPem: string;
  certDer: Buffer;
};

export type MintOptions = {
  commonName: string;
  /** URI subjectAltName entries — the identities `mtls.ts` authorizes on. */
  uris?: string[];
  /** Extended-key-usage OIDs. Omit to emit NO EKU extension (unrestricted). */
  extendedKeyUsage?: string[];
  isCa?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  serial?: number;
};

function newKeyPair(): TestKeyPair {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function mintCertificate(
  subject: MintOptions,
  subjectKey: TestKeyPair,
  issuer: { commonName: string; privateKey: KeyObject },
): MintedCertificate {
  const notBefore = subject.notBefore ?? new Date(Date.now() - 60_000);
  const notAfter = subject.notAfter ?? new Date(Date.now() + 24 * 3600_000);
  const spki = subjectKey.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const signatureAlgorithm = seq(objectIdentifier(OID_ECDSA_SHA256));

  const extensions: Buffer[] = [
    extension(
      OID_BASIC_CONSTRAINTS,
      true,
      // BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, ... }
      subject.isCa ? seq(boolean(true)) : seq(),
    ),
  ];
  if (subject.extendedKeyUsage && subject.extendedKeyUsage.length > 0) {
    extensions.push(
      extension(
        OID_EXT_KEY_USAGE,
        false,
        seq(...subject.extendedKeyUsage.map((oid) => objectIdentifier(oid))),
      ),
    );
  }
  if (subject.uris && subject.uris.length > 0) {
    extensions.push(
      extension(
        OID_SUBJECT_ALT_NAME,
        false,
        seq(...subject.uris.map((uri) => uriGeneralName(uri))),
      ),
    );
  }

  const tbs = seq(
    explicit(0, integer(2)), // v3
    integer(subject.serial ?? Math.floor(Math.random() * 0x7fffffff) + 1),
    signatureAlgorithm,
    distinguishedName(issuer.commonName),
    seq(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(subject.commonName),
    spki,
    explicit(3, seq(...extensions)),
  );

  const signature = sign("sha256", tbs, issuer.privateKey);
  const certDer = seq(tbs, signatureAlgorithm, bitString(signature));
  return {
    certDer,
    certPem: pem("CERTIFICATE", certDer),
    keyPem: (subjectKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString(),
  };
}

export type TestCa = {
  caPem: string;
  /** Issue a leaf certificate under this CA. */
  issue(options: Omit<MintOptions, "isCa">): MintedCertificate;
};

/** Create a throwaway self-signed CA. Nothing persists past the test process. */
export function createTestCa(commonName = "cinatra-exec-test-ca"): TestCa {
  const caKeys = newKeyPair();
  const ca = mintCertificate(
    { commonName, isCa: true },
    caKeys,
    { commonName, privateKey: caKeys.privateKey },
  );
  return {
    caPem: ca.certPem,
    issue: (options) =>
      mintCertificate({ ...options, isCa: false }, newKeyPair(), {
        commonName,
        privateKey: caKeys.privateKey,
      }),
  };
}

/** Sanity helper: a PEM key round-trips through node:crypto. */
export function assertUsableKey(keyPem: string): void {
  createPrivateKey(keyPem);
}
