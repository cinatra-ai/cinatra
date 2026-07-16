// Host-side ADMISSION verification of a dynamically-loaded renderer CLIENT
// bundle's Ed25519 signature (epic #1620 M1 Slice A — cinatra#1630, plan §3.1).
//
// The publish-time builder (`scripts/extensions/build-client-renderer-bundle.mjs`)
// signs the canonical payload (the exact admitted tuple + the bundle integrity)
// with the producer's private key; THIS module verifies that signature against
// the host's configured trust root at EVERY load/admission — re-evaluated, not
// only at install (plan §3.1 "re-evaluated at EVERY boot/load"). It reuses the
// SAME trust root as `extension-signature.ts`
// (`CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS`, base64 SPKI DER) and the SAME
// require-signatures flag (`CINATRA_EXTENSION_REQUIRE_SIGNATURES`), so a single
// key governance surface covers both server tarballs and client bundles.
//
// Never throws — a verdict is a boolean/undefined, exactly like
// `resolveSignatureVerdict`. Pure over its inputs + env.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import {
  loadTrustedPublicKeys,
  signaturesRequired,
  type TrustedPublicKey,
} from "@/lib/extension-signature";
import {
  buildClientBundleSignaturePayload,
  type ClientBundleSignatureFields,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

/**
 * STRICT canonical base64 of a 64-byte Ed25519 signature (mirrors
 * `extension-signature.ts`): Node's permissive `Buffer.from(b64)` would accept
 * trailing junk / non-canonical renderings, so a tampered transport could
 * verify. A signature admits exactly ONE rendering.
 */
export function isStrictEd25519SignatureB64(b64: string): boolean {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(b64)) return false;
  const decoded = Buffer.from(b64, "base64");
  return decoded.length === 64 && decoded.toString("base64") === b64;
}

/** Verify a base64 Ed25519 signature over the client-bundle payload against ONE
 * base64 SPKI-DER public key. Strictly Ed25519 (an RSA key/sig pair must not
 * verify under `crypto.verify(null, …)`). Never throws. */
export function verifyClientBundleAgainstKey(
  fields: ClientBundleSignatureFields,
  signatureB64: string,
  publicKeyDerB64: string,
): boolean {
  try {
    if (!isStrictEd25519SignatureB64(signatureB64)) return false;
    const key = createPublicKey({
      key: Buffer.from(publicKeyDerB64, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return cryptoVerify(
      null,
      Buffer.from(buildClientBundleSignaturePayload(fields), "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

/** True iff the signature verifies against ANY configured trusted key. */
export function verifyClientBundleSignature(
  fields: ClientBundleSignatureFields,
  signatureB64: string,
  trustedKeys: readonly TrustedPublicKey[],
): boolean {
  return trustedKeys.some((k) => verifyClientBundleAgainstKey(fields, signatureB64, k.publicKeyDerB64));
}

/**
 * The admission verdict for a client bundle (plan §3.1). Fail-closed: a client
 * bundle EXECUTES in the host page, so — unlike the additive tarball verdict —
 * it must NOT ride an `undefined` "unsigned when not required" path when the
 * bundle carries no valid signature and signatures are required, and it never
 * returns `true` without a real verification.
 *   - signature verifies against a trusted key                → true
 *   - signature present + does NOT verify (tamper/wrong key)  → false
 *   - no trusted key configured, OR no/invalid signature      → required ? false : undefined
 * The RUNTIME registry's `admitAndActivate.verify` treats anything other than
 * `true` as fail-closed for a dynamic (in-page) renderer.
 */
export function resolveClientBundleSignatureVerdict(
  fields: ClientBundleSignatureFields,
  input: { signature?: string | null },
  deps: { trustedKeys?: readonly TrustedPublicKey[]; required?: boolean } = {},
): boolean | undefined {
  const trustedKeys = deps.trustedKeys ?? loadTrustedPublicKeys();
  const required = deps.required ?? signaturesRequired();
  const sig = input.signature?.trim();
  if (!sig) return required ? false : undefined;
  if (trustedKeys.length === 0) return required ? false : undefined;
  return verifyClientBundleSignature(fields, sig, trustedKeys);
}

/** The boolean the runtime registry consumes (a dynamic renderer requires a
 * genuine verification — `undefined` is treated as unverified, fail-closed). */
export function isClientBundleSignatureVerified(
  fields: ClientBundleSignatureFields,
  input: { signature?: string | null },
  deps: { trustedKeys?: readonly TrustedPublicKey[]; required?: boolean } = {},
): boolean {
  return resolveClientBundleSignatureVerdict(fields, input, deps) === true;
}
