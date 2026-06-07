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
// (owner custody; store in Infisical, NEVER in the repo/CI/logs). The signer is
// `scripts/extension-signer.mjs` (zero-dep; keep its payload format in sync
// with `buildSignaturePayload`).
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

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
} from "node:crypto";

export const SIGNATURE_SCHEME = "cinatra-extension-signature/v1";

export type GeneratedSigningKeyPair = {
  /** base64 SPKI DER — the host trust root (public, NOT secret). */
  publicKeyDerB64: string;
  /** base64 PKCS8 DER — the producer's signing key (SECRET; owner custody / Infisical). */
  privateKeyPkcs8DerB64: string;
  keyId: string;
};

/** Generate an Ed25519 signing keypair (the owner's `extension-signer.mjs keygen` uses the same shapes). */
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
 * MUST stay byte-identical to `scripts/extension-signer.mjs`.
 */
export function buildSignaturePayload(f: ExtensionSignatureFields): string {
  return `${SIGNATURE_SCHEME}\n${f.packageName}\n${f.version}\n${f.integrity}`;
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

/**
 * Resolve the additive `signatureVerified` factor for `classifyExtensionTrust`.
 * See the policy table in the module header. Pure over its inputs + env.
 */
export function resolveSignatureVerdict(
  input: ExtensionSignatureFields & { signature?: string | null },
  deps: { trustedKeys?: readonly TrustedPublicKey[]; required?: boolean } = {},
): boolean | undefined {
  const trustedKeys = deps.trustedKeys ?? loadTrustedPublicKeys();
  const required = deps.required ?? signaturesRequired();
  const sig = input.signature?.trim();
  if (sig) {
    if (trustedKeys.length === 0) return required ? false : undefined; // can't validate
    return verifyExtensionSignature(input, sig, trustedKeys); // true | false (false even if !required)
  }
  return required ? false : undefined; // no signature
}
