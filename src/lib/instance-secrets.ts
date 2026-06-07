// -----------------------------------------------------------------------------
// AES-256-GCM encrypt/decrypt helper for the `instance_identity` metadata row
// (Verdaccio token + password ciphertexts).
//
// Design:
//   - 256-bit key sourced from `process.env.CINATRA_ENCRYPTION_KEY` (hex 64 chars
//     OR base64). `getKey()` validates length === 32 bytes; throws otherwise.
//   - 12-byte random IV per encryption (GCM standard). Never reuse.
//   - 16-byte auth tag is concatenated to the ciphertext before base64 packing
//     so the on-the-wire shape is `{ ciphertext: base64(enc || tag), iv: base64 }`.
//   - decryptSecret reverses the packaging, sets the auth-tag on the decipher,
//     and `final()` throws if the tag does not authenticate the ciphertext.
//
// Threat-model touchpoints:
//   - Missing or wrong-length keys are guarded by getKey().
//   - IV reuse is prevented by randomBytes(IV_BYTES) per encrypt, never cached.
//   - Auth-tag bypass is prevented because setAuthTag → final() rejects tampered
//     input.
//   - Eager key loading is avoided because getKey() runs INSIDE function bodies;
//     the module top level has no side effects.
//   - AAD swap protection: when an `aad` argument is supplied, encryptSecret
//     binds the ciphertext to that context string via cipher.setAAD(...).
//     decryptSecret with the matching aad authenticates the binding via
//     decipher.setAAD(...) before decipher.final(). This prevents an attacker
//     who can mutate the metadata row from swapping tokenCiphertext/IV with
//     passwordCiphertext/IV (or vice versa) and having the decryption succeed
//     silently. Callers SHOULD pass distinct aad values per field
//     ("vendor.token", "vendor.password") so swapped fields raise on final().
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const ALGO = "aes-256-gcm" as const;
const IV_BYTES = 12; // GCM-recommended IV length
const KEY_BYTES = 32; // 256-bit key
const AUTH_TAG_BYTES = 16; // GCM tag length

// -----------------------------------------------------------------------------
// Key resolution
// -----------------------------------------------------------------------------

function getKey(): Buffer {
  const raw = process.env.CINATRA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CINATRA_ENCRYPTION_KEY env var is required for instance-secrets encryption.");
  }
  // Disambiguate hex from base64 by validating that all 64 characters are hex
  // digits, NOT just by length. A length-only heuristic mis-decodes a 64-char
  // base64 string (whose alphabet partially overlaps hex for digits) as hex,
  // silently producing a different 32-byte key than the operator intended.
  // Buffer.from(raw, "hex") also truncates at the first non-hex character,
  // so a 64-char string with one trailing non-hex char would decode to <32 bytes
  // (caught later by the length check, but emitting a confusing "got N bytes"
  // error rather than a "not hex" error).
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    buf = Buffer.from(raw, "base64");
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`CINATRA_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}).`);
  }
  return buf;
}

// -----------------------------------------------------------------------------
// Public API — encryptSecret / decryptSecret
// -----------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 plaintext string using AES-256-GCM.
 *
 * @param plaintext UTF-8 string to encrypt.
 * @param aad      Optional context-binding string. When supplied the
 *                 ciphertext is bound to this context via `cipher.setAAD`,
 *                 and decryption MUST pass the same aad or the auth tag
 *                 will fail. Pass `"vendor.token"` / `"vendor.password"` from
 *                 the call site so a metadata-row swap of token↔password fields
 *                 cannot produce a successful decryption of the wrong field.
 * @returns `{ ciphertext, iv }` — both base64 strings. The 16-byte GCM auth
 *   tag is concatenated to the ciphertext before base64 packing.
 * @throws when `CINATRA_ENCRYPTION_KEY` is missing or the wrong length.
 */
export function encryptSecret(
  plaintext: string,
  aad?: string,
): { ciphertext: string; iv: string } {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  const packed = Buffer.concat([enc, tag]).toString("base64");
  return { ciphertext: packed, iv: iv.toString("base64") };
}

/**
 * Decrypt an output of {@link encryptSecret} back to its UTF-8 plaintext.
 *
 * @param input  `{ ciphertext, iv }` produced by {@link encryptSecret}.
 * @param aad    Optional aad string. MUST match what was passed to
 *               {@link encryptSecret}; otherwise `decipher.final()` raises.
 * @throws when `CINATRA_ENCRYPTION_KEY` is missing/wrong-length, OR when the
 *   ciphertext / auth-tag / aad has been tampered with (GCM authenticates
 *   the entire blob plus the aad — `decipher.final()` raises on mismatch).
 */
export function decryptSecret(
  input: { ciphertext: string; iv: string },
  aad?: string,
): string {
  const key = getKey();
  const iv = Buffer.from(input.iv, "base64");
  const packed = Buffer.from(input.ciphertext, "base64");
  // Last AUTH_TAG_BYTES bytes are the auth tag; remainder is the ciphertext.
  const tag = packed.subarray(packed.length - AUTH_TAG_BYTES);
  const enc = packed.subarray(0, packed.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
