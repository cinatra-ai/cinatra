import "server-only";

// The SHARED SEAL for the island's two capabilities (enablers 0.6 and 0.12 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// WHY A SHARED SEAL AND NOT TWO COPIES. The island credential
// (`review-island-credential.ts`) and the capture capability
// (`capture-capability.ts`) are already the same construction written twice, and
// this slice adds two more bearers of exactly that shape: the byte capability
// (0.6) and the data capability (0.12). A fifth and sixth hand-rolled AES-GCM
// codec is how one of them eventually forgets an expiry ceiling or a field
// bound. So the CRYPTOGRAPHY lives here once and each capability declares only
// what it seals, what its ceiling is, and — decisively — ITS OWN KEY LABEL.
//
// KEY SEPARATION IS THE WHOLE POINT. Every capability derives its key from the
// app secret through its own label, so a byte capability can never be opened as
// a data capability, a lifecycle card ref, an island credential or a capture
// capability, even though all of them hang off one secret. Two capabilities
// sharing a codec and NOT sharing a key is the property this module exists to
// make structural rather than remembered.
//
// FAIL-CLOSED ON KEY TROUBLE. No secret, a rotated key, tampered bytes, a
// non-JSON plaintext, an out-of-bounds field, an expiry past the ceiling: all
// `null`. Every serving path turns every `null` into the same refusal, so
// nothing here is an oracle.
//
// PURE-ish LEAF: `node:crypto` only — no store, no route, no React — so a
// surface that MINTS a capability does not drag a serving path's store graph
// behind it (the `lifecycle-card-ref` precedent).

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** Bound on every sealed id field, enforced on BOTH sides so a hostile
 *  plaintext cannot expand on decode either. */
export const SEALED_FIELD_MAX = 128;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Ceiling on any encoded capability. A longer query value is not one of ours. */
export const SEALED_CAPABILITY_MAX_LENGTH = 1024;

export interface SealedCapabilitySpec {
  /** THIS capability's key-derivation label. Changing it rotates every
   *  outstanding capability of this kind, and nothing else. */
  keyLabel: string;
  /** The longest life this kind of capability may ever carry, in seconds. Read
   *  as the default life, as the ceiling a mint will not exceed, and as the
   *  ceiling a sealed expiry may not overshoot on verify. ONE definition. */
  ttlSeconds: number;
}

function derivedKey(keyLabel: string): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(keyLabel).digest();
}

/** An opened capability: its sealed fields, and its own expiry. The fields are
 *  kept in their own record so a field can never collide with `expiresAt`. */
export interface OpenedCapability {
  fields: Record<string, string>;
  expiresAt: number;
}

/** A bounded, non-empty id string. */
export function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SEALED_FIELD_MAX;
}

/**
 * Seal a payload record. The record's values must all be bounded id strings —
 * the expiry is added here as `x` and is the only number.
 *
 * Returns `null` when a field is out of bounds, when no key is available, when
 * the requested life exceeds the spec's ceiling, or when the encoded form would
 * exceed the URL budget: a surface that cannot express a capability renders
 * nothing rather than a broken address.
 */
export function sealCapability(
  spec: SealedCapabilitySpec,
  fields: Record<string, string>,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string | null {
  const values = Object.values(fields);
  if (values.length === 0 || !values.every((v) => isBoundedId(v))) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  const ttl = options?.ttlSeconds ?? spec.ttlSeconds;
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) return null;
  // A caller may only ever SHORTEN a capability's life. Accepting a longer ttl
  // would let one careless surface hand out an address that outlives the
  // authorization that minted it.
  if (ttl > spec.ttlSeconds) return null;

  const key = derivedKey(spec.keyLabel);
  if (!key) return null;

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = JSON.stringify({ ...fields, x: now + ttl });
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const encoded = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return encoded.length <= SEALED_CAPABILITY_MAX_LENGTH ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Open a sealed capability and check its own expiry against the SERVER clock.
 *
 * `null` for anything that is not a live one of ours — forged, tampered, sealed
 * under another label, sealed under a rotated key, missing a required field, or
 * expired are all the same answer, because a serving path must not distinguish
 * them.
 *
 * THIS IS NOT THE AUTHORIZATION. It proves this host minted the address and
 * that the address has not expired. Every binding it seals is still re-checked
 * live afterwards.
 */
export function openCapability(
  spec: SealedCapabilitySpec,
  encoded: string | null | undefined,
  requiredFields: readonly string[],
  options?: { nowSeconds?: number },
): OpenedCapability | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length === 0 || encoded.length > SEALED_CAPABILITY_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const key = derivedKey(spec.keyLabel);
  if (!key) return null;

  let parsed: unknown;
  try {
    const raw = Buffer.from(encoded, "base64url");
    // CANONICAL ENCODING ONLY. base64url decoding is lenient: a trailing
    // character that does not complete a byte is silently dropped, so
    // `<capability>x` would decode to the SAME bytes and pass the AEAD. The
    // ciphertext is still authenticated either way, but a bearer that has more
    // than one spelling is a bearer whose single-use ledger and whose logs can
    // be desynchronised by a character. One address, one string.
    if (raw.toString("base64url") !== encoded) return null;
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    parsed = JSON.parse(
      Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"),
    );
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of requiredFields) {
    const value = record[field];
    if (!isBoundedId(value)) return null;
    out[field] = value;
  }
  const exp = record.x;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  // Inclusive-exclusive, so a capability is dead the instant its second arrives.
  if (now >= exp) return null;
  // A life beyond the ceiling was not minted by this codec at this version.
  if (exp - now > spec.ttlSeconds) return null;

  return { fields: out, expiresAt: exp };
}
