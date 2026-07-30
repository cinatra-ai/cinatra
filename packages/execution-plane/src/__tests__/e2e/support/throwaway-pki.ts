/**
 * Throwaway execution-plane PKI for the service-boundary E2E battery
 * (exec-plane L5, epic cinatra#1705).
 *
 * Mints a fresh CA and a fresh set of leaves ON EVERY RUN, in-process, with
 * `node:crypto` and nothing else — no npm dependency, no `openssl` subprocess,
 * and NOTHING COMMITTED. A committed test certificate is a real credential with
 * a real private key sitting in a public repository, and it expires, which is
 * how a security battery quietly turns into a skipped one.
 *
 * WHY THE DER IS HAND-ROLLED. `node:crypto` can generate keys and sign bytes but
 * it cannot ISSUE a certificate (`X509Certificate` only parses). So this module
 * encodes the TBSCertificate itself. That is not incidental cost — it is what
 * makes the NEGATIVE arms of the battery possible: `mtls.ts` authorizes on
 * "exactly one URI SAN, byte-equal, plus the direction-appropriate EKU", and
 * proving that requires certificates a normal issuance path will not produce —
 * two URI SANs, no extendedKeyUsage at all, a role SAN for a different service,
 * a leaf from a foreign CA, an already-expired validity window. Every one of
 * those is one option away here.
 *
 * Ed25519 throughout (signature OID 1.3.101.112): TLS 1.3 — which `mtls.ts`
 * pins as its floor — negotiates it directly, and the algorithm identifier
 * carries no parameters, so the encoding stays small enough to audit by eye.
 *
 * The material is REAL. These certificates complete real handshakes against the
 * real `https.Server` the broker and worker build. Nothing here fakes a
 * handshake, and nothing here is trusted by anything outside the run that
 * created it.
 */

import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal DER
// ---------------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

const derSequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const derBoolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const derOctetString = (value: Buffer): Buffer => tlv(0x04, value);
const derUtf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, "utf8"));
const derExplicit = (index: number, value: Buffer): Buffer => tlv(0xa0 | index, value);

/** `[6] IMPLICIT IA5String` — the uniformResourceIdentifier GeneralName. */
const derUriGeneralName = (uri: string): Buffer => tlv(0x86, Buffer.from(uri, "ascii"));

/** DER INTEGER: minimal, and never accidentally negative. */
function derInteger(value: number | Buffer): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    if (value === 0) return tlv(0x02, Buffer.from([0]));
    const out: number[] = [];
    let v = value;
    while (v > 0) {
      out.unshift(v & 0xff);
      v = Math.floor(v / 256);
    }
    bytes = Buffer.from(out);
  } else {
    bytes = value;
  }
  let start = 0;
  while (start + 1 < bytes.length && bytes[start] === 0x00) start += 1;
  bytes = bytes.subarray(start);
  // A leading high bit would read as a negative integer; pad it.
  if ((bytes[0] as number) & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(0x02, bytes);
}

/** BIT STRING with no unused trailing bits (signatures, keys). */
const derBitString = (value: Buffer): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([0x00]), value]));

/** BIT STRING carrying NAMED bits (KeyUsage), with the unused-bit count. */
function derNamedBits(bits: readonly number[]): Buffer {
  const highest = Math.max(...bits);
  const byteCount = Math.floor(highest / 8) + 1;
  const data = Buffer.alloc(byteCount);
  for (const bit of bits) {
    const index = Math.floor(bit / 8);
    data[index] = (data[index] as number) | (0x80 >> bit % 8);
  }
  const unused = byteCount * 8 - (highest + 1);
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), data]));
}

function derOid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => Number(p));
  const first = (parts[0] as number) * 40 + (parts[1] as number);
  const out: number[] = [first];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let value = part;
    do {
      chunk.unshift(value & 0x7f);
      value = Math.floor(value / 128);
    } while (value > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] as number) | 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** `YYMMDDHHMMSSZ` — UTCTime is valid for every year this battery can run in. */
function derUtcTime(at: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const text =
    `${pad(at.getUTCFullYear() % 100)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const OID_COMMON_NAME = "2.5.4.3";
const OID_ED25519 = "1.3.101.112";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EXT_KEY_USAGE = "2.5.29.37";

/** The two EKU purposes `mtls.ts` enforces, by their RFC 5280 OIDs. */
export const OID_EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
export const OID_EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

const ED25519_ALGORITHM = derSequence(derOid(OID_ED25519));

function commonName(cn: string): Buffer {
  return derSequence(derSet(derSequence(derOid(OID_COMMON_NAME), derUtf8String(cn))));
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return derSequence(
    derOid(oid),
    ...(critical ? [derBoolean(true)] : []),
    derOctetString(value),
  );
}

function toPem(der: Buffer, label: string): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

export type ExecCertificate = {
  certPem: string;
  keyPem: string;
};

export type ExecCertificateAuthority = ExecCertificate & {
  /** Signing key, kept as a `KeyObject` so it never round-trips through a file. */
  key: KeyObject;
  subject: Buffer;
};

type IssueOptions = {
  commonName: string;
  /**
   * URI SANs, byte-exact. An EMPTY array issues a certificate with no
   * subjectAltName extension at all (the `no_uri_san` arm); two entries issue
   * the ambiguous multi-identity credential (the `ambiguous_uri_san` arm).
   */
  uriSans: readonly string[];
  /**
   * EKU purposes. An EMPTY array omits the extendedKeyUsage extension entirely —
   * an UNRESTRICTED credential, which `mtls.ts` refuses (`missing_eku`) precisely
   * because it could be replayed in the opposite direction.
   */
  ekus: readonly string[];
  notBefore: Date;
  notAfter: Date;
};

function issue(
  ca: ExecCertificateAuthority,
  options: IssueOptions,
): ExecCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const extensions: Buffer[] = [
    extension(OID_BASIC_CONSTRAINTS, true, derSequence()),
    extension(OID_KEY_USAGE, true, derNamedBits([0])), // digitalSignature
  ];
  if (options.uriSans.length > 0) {
    extensions.push(
      extension(
        OID_SUBJECT_ALT_NAME,
        false,
        derSequence(...options.uriSans.map((uri) => derUriGeneralName(uri))),
      ),
    );
  }
  if (options.ekus.length > 0) {
    extensions.push(
      extension(OID_EXT_KEY_USAGE, false, derSequence(...options.ekus.map((o) => derOid(o)))),
    );
  }
  const tbs = derSequence(
    derExplicit(0, derInteger(2)), // v3
    derInteger(randomBytes(12)),
    ED25519_ALGORITHM,
    ca.subject,
    derSequence(derUtcTime(options.notBefore), derUtcTime(options.notAfter)),
    commonName(options.commonName),
    spki,
    derExplicit(3, derSequence(...extensions)),
  );
  const signature = sign(null, tbs, ca.key);
  const certificate = derSequence(tbs, ED25519_ALGORITHM, derBitString(signature));
  return {
    certPem: toPem(certificate, "CERTIFICATE"),
    keyPem: (privateKey.export({ format: "pem", type: "pkcs8" }) as string) ?? "",
  };
}

/** Mint a self-signed CA. Every run gets its own; nothing outside trusts it. */
export function createThrowawayCa(commonNameText: string): ExecCertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const subject = commonName(commonNameText);
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const now = Date.now();
  const tbs = derSequence(
    derExplicit(0, derInteger(2)),
    derInteger(randomBytes(12)),
    ED25519_ALGORITHM,
    subject,
    derSequence(
      derUtcTime(new Date(now - 60 * 60 * 1000)),
      derUtcTime(new Date(now + 24 * 60 * 60 * 1000)),
    ),
    subject,
    spki,
    derExplicit(
      3,
      derSequence(
        extension(OID_BASIC_CONSTRAINTS, true, derSequence(derBoolean(true))),
        // keyCertSign + cRLSign
        extension(OID_KEY_USAGE, true, derNamedBits([5, 6])),
      ),
    ),
  );
  const signature = sign(null, tbs, privateKey);
  const certificate = derSequence(tbs, ED25519_ALGORITHM, derBitString(signature));
  return {
    key: privateKey,
    subject,
    certPem: toPem(certificate, "CERTIFICATE"),
    keyPem: (privateKey.export({ format: "pem", type: "pkcs8" }) as string) ?? "",
  };
}

export type LeafOverrides = {
  /** Replace the URI SAN set outright (wrong role, two identities, or none). */
  uriSans?: readonly string[];
  /** Replace the EKU set outright (an empty array omits the extension). */
  ekus?: readonly string[];
  /** Issue an ALREADY-EXPIRED leaf. */
  expired?: boolean;
  /** Issue a NOT-YET-VALID leaf. */
  notYetValid?: boolean;
};

/** The four execution-plane service roles, as `mtls.ts` names them. */
export type ExecRole = "app-client" | "broker-client" | "broker-server" | "worker-server";

const SERVER_ROLES: readonly ExecRole[] = ["broker-server", "worker-server"];

/**
 * Issue one leaf for `role` on `instance`, defaulting to exactly the credential
 * `mtls.ts` would authorize: a single `cinatra-exec://<instance>/<role>` URI SAN
 * plus the direction-appropriate EKU. Every override exists to build a
 * credential that must be REFUSED.
 */
export function issueExecLeaf(
  ca: ExecCertificateAuthority,
  instance: string,
  role: ExecRole,
  overrides: LeafOverrides = {},
): ExecCertificate {
  const now = Date.now();
  const notBefore = overrides.notYetValid
    ? new Date(now + 24 * 60 * 60 * 1000)
    : overrides.expired
      ? new Date(now - 48 * 60 * 60 * 1000)
      : new Date(now - 60 * 60 * 1000);
  const notAfter = overrides.expired
    ? new Date(now - 24 * 60 * 60 * 1000)
    : overrides.notYetValid
      ? new Date(now + 48 * 60 * 60 * 1000)
      : new Date(now + 24 * 60 * 60 * 1000);
  const defaultEku = SERVER_ROLES.includes(role) ? OID_EKU_SERVER_AUTH : OID_EKU_CLIENT_AUTH;
  return issue(ca, {
    commonName: `cinatra-exec ${role}`,
    uriSans: overrides.uriSans ?? [`cinatra-exec://${instance}/${role}`],
    ekus: overrides.ekus ?? [defaultEku],
    notBefore,
    notAfter,
  });
}
