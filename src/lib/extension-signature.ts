// Ed25519 extension signing — the host-side trust-root verification (turning
// the `signatureVerified` seam into a real mechanism).
//
// WHAT IS SIGNED: a canonical payload binding the package IDENTITY + the TARBALL
// integrity — `packageName`, `version`, and the sha512 SRI of the tarball bytes
// (the same `integrity` the materializer verifies BEFORE extraction). The signed
// artifact is the extension TARBALL only (model-B: the host SDK is the trust root
// inside the TCB, verified by ABI-range, never signed).
//
// KEYS: Ed25519. The PUBLIC key(s) are the host's configured trust root
// (`CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS`, base64 SPKI DER, comma-separated —
// public keys are NOT secrets). The PRIVATE key is the producer's signing key
// (store the private signing key in a secret manager, never in the repo/CI/logs).
// The canonical signed payload format (see `buildSignaturePayload` below) is
// mirrored by the publisher/broker signer.
//
// POLICY (`resolveSignatureVerdict`) keeps `classifyExtensionTrust` unchanged —
// it returns the additive `signatureVerified` factor:
//   - signature present + verifies against a trusted key      → true  (trust signal)
//   - signature present + does NOT verify (tamper/wrong key)  → false (REFUSE — red flag)
//   - signature present but NO trusted key configured         → required ? false : undefined
//   - no signature                                            → required ? false : undefined
// `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true` makes a verified signature
// MANDATORY for in-process activation; default off (additive — today's verdict
// is unchanged for unsigned first-party installs).
//
// PROTOCOL v2 (cinatra#181 — library dependency closure): a v2 payload binds
// packageName + version + integrity + `closureHash` (the sha512 over the
// canonical MATERIALIZATION PLAN bytes — see
// `src/lib/extension-materialization-plan-core.ts`), or the literal `none`
// for a closure-less package. Because the v1 scheme line is EMBEDDED in the
// payload but never transmitted, v2 adds an explicit TRANSPORT marker: the
// packument's `dist.cinatraSignature` value is `"v2:" + base64sig` for v2 and
// bare base64 for v1; any OTHER prefix is refused (fail-closed forward
// refusal — never strip-and-retry). DOWNGRADE REFUSAL (hard, never
// `undefined`): when the host computed a closureHash (a plan is present),
// ONLY a v2 signature binding that exact recomputed hash verifies — absent
// signature, no trusted key, v1 signature, invalid v2, and v2 binding `none`
// are all hard `false`, so a closure package can never reach ANY trusted tier
// (incl. trusted-bootstrap) without a verified v2 binding. Closure-less
// packages keep v1 semantics byte-for-byte (the `closureHash` input defaults
// to null at untouched call sites); a v2 signature binding `none` is also
// accepted for them. The committed fixtures under
// `src/lib/__tests__/fixtures/materialization-plan/` pin the exact payload +
// transport bytes for the publish-time signer.

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
} from "node:crypto";

export const SIGNATURE_SCHEME = "cinatra-extension-signature/v1";
export const SIGNATURE_SCHEME_V2 = "cinatra-extension-signature/v2";

/** Transport prefix marking a v2 signature in `dist.cinatraSignature`. */
export const SIGNATURE_TRANSPORT_PREFIX_V2 = "v2:";

/** The literal closureHash payload line for a closure-less v2 signature. */
export const CLOSURE_HASH_NONE = "none";

export type GeneratedSigningKeyPair = {
  /** base64 SPKI DER — the host trust root (public, NOT secret). */
  publicKeyDerB64: string;
  /** base64 PKCS8 DER — the producer's signing key (SECRET; held by the publisher, never in the repo). */
  privateKeyPkcs8DerB64: string;
  keyId: string;
};

/** Generate an Ed25519 signing keypair (the publisher's keygen uses the same shapes). */
export function generateExtensionSigningKeyPair(): GeneratedSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDerB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateKeyPkcs8DerB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { publicKeyDerB64, privateKeyPkcs8DerB64, keyId: publicKeyId(publicKeyDerB64) };
}

export type ExtensionSignatureFields = {
  packageName: string;
  version: string;
  /** The sha512 SRI of the tarball bytes (e.g. `sha512-…`). */
  integrity: string;
};

/**
 * Canonical signed payload. Newline-delimited, fixed field order — bound to the
 * scheme version so a future format change is a new scheme, not a silent break.
 * MUST stay byte-identical to the publisher's signer (the canonical Ed25519 payload format).
 */
export function buildSignaturePayload(f: ExtensionSignatureFields): string {
  return `${SIGNATURE_SCHEME}\n${f.packageName}\n${f.version}\n${f.integrity}`;
}

export type ExtensionSignatureFieldsV2 = ExtensionSignatureFields & {
  /**
   * The 128-hex sha512 over the canonical materialization-plan bytes, or null
   * for a closure-less package (serialized as the literal `none`).
   */
  closureHash: string | null;
};

/**
 * Canonical v2 payload (cinatra#181): UTF-8, LF-separated, NO trailing
 * newline, exactly 5 lines:
 *   `cinatra-extension-signature/v2\n<packageName>\n<version>\n<integrity>\n<closureHash|none>`
 * MUST stay byte-identical to the publisher's signer — the committed
 * `payload-v2.bytes` fixture is normative.
 */
export function buildSignaturePayloadV2(f: ExtensionSignatureFieldsV2): string {
  return `${SIGNATURE_SCHEME_V2}\n${f.packageName}\n${f.version}\n${f.integrity}\n${f.closureHash ?? CLOSURE_HASH_NONE}`;
}

export type ParsedSignatureTransport =
  | { scheme: "v1"; signatureB64: string }
  | { scheme: "v2"; signatureB64: string }
  | { scheme: "unknown"; prefix: string };

/**
 * Parse the transmitted `dist.cinatraSignature` value: bare base64 (no `:`)
 * = v1 (the pre-#181 shape); `"v2:" + base64` = v2; any OTHER prefix =
 * `unknown` and the verdict is a hard refusal (fail-closed forward refusal —
 * a host must never strip an unrecognized prefix and retry as v1).
 */
export function parseSignatureTransport(raw: string): ParsedSignatureTransport {
  const value = raw.trim();
  const sep = value.indexOf(":");
  if (sep === -1) return { scheme: "v1", signatureB64: value };
  if (value.startsWith(SIGNATURE_TRANSPORT_PREFIX_V2)) {
    return { scheme: "v2", signatureB64: value.slice(SIGNATURE_TRANSPORT_PREFIX_V2.length) };
  }
  return { scheme: "unknown", prefix: value.slice(0, sep) };
}

/** A short, stable id for a public key (sha256 of its SPKI DER, first 16 hex). */
export function publicKeyId(publicKeyDerB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyDerB64, "base64")).digest("hex").slice(0, 16);
}

/** Sign the canonical payload with a base64 PKCS8-DER Ed25519 private key → base64 signature. */
export function signExtension(fields: ExtensionSignatureFields, privateKeyPkcs8DerB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8DerB64, "base64"), format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, Buffer.from(buildSignaturePayload(fields), "utf8"), key);
  return sig.toString("base64");
}

/**
 * Sign the canonical V2 payload → the TRANSPORT value (`"v2:" + base64`).
 * The publisher's signer mirrors these exact bytes (fixture-pinned).
 */
export function signExtensionV2(fields: ExtensionSignatureFieldsV2, privateKeyPkcs8DerB64: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8DerB64, "base64"), format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, Buffer.from(buildSignaturePayloadV2(fields), "utf8"), key);
  return `${SIGNATURE_TRANSPORT_PREFIX_V2}${sig.toString("base64")}`;
}

/** Verify a base64 Ed25519 signature against ONE base64 SPKI-DER public key. Never throws. */
export function verifyAgainstKey(
  fields: ExtensionSignatureFields,
  signatureB64: string,
  publicKeyDerB64: string,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyDerB64, "base64"), format: "der", type: "spki" });
    // Strictly Ed25519 — `crypto.verify(null, …)` would otherwise also accept an
    // RSA key+sig pair, so a misconfigured RSA trust root must not verify.
    if (key.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(null, Buffer.from(buildSignaturePayload(fields), "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * STRICT v2 signature-transport base64 (review r0 finding 2): exactly the
 * canonical base64 of a 64-byte Ed25519 signature — Node's permissive
 * `Buffer.from(b64)` would otherwise accept trailing junk / non-canonical
 * renderings that decode to the same bytes, so "v2:<sig>junk" could verify.
 * A v2 transport value admits exactly ONE rendering per signature.
 */
function isStrictEd25519SignatureB64(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(b64)) return false;
  const decoded = Buffer.from(b64, "base64");
  return decoded.length === 64 && decoded.toString("base64") === b64;
}

/** v2 variant of `verifyAgainstKey` — same key handling, v2 payload bytes,
 *  STRICT signature-base64 (non-canonical/tampered transport never verifies). */
export function verifyAgainstKeyV2(
  fields: ExtensionSignatureFieldsV2,
  signatureB64: string,
  publicKeyDerB64: string,
): boolean {
  try {
    if (!isStrictEd25519SignatureB64(signatureB64)) return false;
    const key = createPublicKey({ key: Buffer.from(publicKeyDerB64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(null, Buffer.from(buildSignaturePayloadV2(fields), "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export type TrustedPublicKey = { keyId: string; publicKeyDerB64: string };

/**
 * The host's configured trust-root public keys, from
 * `CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS` (comma-separated base64 SPKI DER).
 * Invalid entries are skipped. Empty when unset.
 */
export function loadTrustedPublicKeys(env: Record<string, string | undefined> = process.env): TrustedPublicKey[] {
  const raw = env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS?.trim();
  if (!raw) return [];
  const out: TrustedPublicKey[] = [];
  for (const part of raw.split(",")) {
    const b64 = part.trim();
    if (!b64) continue;
    try {
      // Trust ONLY Ed25519 SPKI public keys — skip anything else (an RSA key
      // would otherwise verify an RSA signature under `crypto.verify(null, …)`).
      const k = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
      if (k.asymmetricKeyType !== "ed25519") continue;
      out.push({ keyId: publicKeyId(b64), publicKeyDerB64: b64 });
    } catch {
      // skip an unparseable configured key (fail-safe: it simply isn't trusted)
    }
  }
  return out;
}

/** Whether a verified signature is MANDATORY for in-process activation. */
export function signaturesRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.CINATRA_EXTENSION_REQUIRE_SIGNATURES === "true";
}

/** True iff the signature verifies against ANY configured trusted key. */
export function verifyExtensionSignature(
  fields: ExtensionSignatureFields,
  signatureB64: string,
  trustedKeys: readonly TrustedPublicKey[],
): boolean {
  return trustedKeys.some((k) => verifyAgainstKey(fields, signatureB64, k.publicKeyDerB64));
}

/** True iff the v2 signature verifies against ANY configured trusted key. */
export function verifyExtensionSignatureV2(
  fields: ExtensionSignatureFieldsV2,
  signatureB64: string,
  trustedKeys: readonly TrustedPublicKey[],
): boolean {
  return trustedKeys.some((k) => verifyAgainstKeyV2(fields, signatureB64, k.publicKeyDerB64));
}

/**
 * Resolve the additive `signatureVerified` factor for `classifyExtensionTrust`.
 * See the policy table in the module header. Pure over its inputs + env.
 */
export function resolveSignatureVerdict(
  input: ExtensionSignatureFields & {
    signature?: string | null;
    /**
     * The HOST-RECOMPUTED closureHash when the package carries a
     * materialization plan; null/omitted = closure-less (v1 semantics
     * unchanged at untouched call sites). NEVER caller-trusted plan metadata —
     * always the hash the host derived from the parsed plan itself.
     */
    closureHash?: string | null;
  },
  deps: { trustedKeys?: readonly TrustedPublicKey[]; required?: boolean } = {},
): boolean | undefined {
  const trustedKeys = deps.trustedKeys ?? loadTrustedPublicKeys();
  const required = deps.required ?? signaturesRequired();
  const closureHash = input.closureHash ?? null;
  const sig = input.signature?.trim();

  // PLAN PRESENT — the downgrade-refusal matrix (cinatra#181): the verdict is
  // NEVER `undefined`, so a closure package can never ride the
  // trusted-bootstrap path. ONLY a v2 signature binding the RECOMPUTED
  // closureHash verifies; absent signature, no trusted key, a v1 signature,
  // an unknown transport prefix, an invalid v2, and a v2 binding `none` are
  // all hard refusals (the last two fall out of payload mismatch).
  if (closureHash !== null) {
    // Shape gate (review r0 finding 3): a non-null closureHash must be the
    // 128-lowercase-hex sha512 the host recomputed — anything else (e.g. a
    // caller accidentally passing the literal "none", uppercase hex, a
    // truncated hash) is a HARD refusal, never a silent fall-through to the
    // closure-less branch where a v2-`none` signature would verify.
    if (!/^[0-9a-f]{128}$/.test(closureHash)) return false;
    if (!sig) return false;
    const parsed = parseSignatureTransport(sig);
    if (parsed.scheme !== "v2") return false; // v1 downgrade / unknown prefix
    if (trustedKeys.length === 0) return false; // cannot validate => refuse (plan present)
    return verifyExtensionSignatureV2({ ...input, closureHash }, parsed.signatureB64, trustedKeys);
  }

  // PLAN ABSENT — v1 semantics byte-for-byte, plus: a v2 signature binding
  // `none` is accepted, and an UNKNOWN transport prefix is a hard refusal
  // (never strip-and-retry).
  if (sig) {
    const parsed = parseSignatureTransport(sig);
    if (parsed.scheme === "unknown") return false; // fail-closed forward refusal
    if (trustedKeys.length === 0) return required ? false : undefined; // can't validate
    if (parsed.scheme === "v2") {
      return verifyExtensionSignatureV2({ ...input, closureHash: null }, parsed.signatureB64, trustedKeys);
    }
    return verifyExtensionSignature(input, parsed.signatureB64, trustedKeys); // true | false (false even if !required)
  }
  return required ? false : undefined; // no signature
}
