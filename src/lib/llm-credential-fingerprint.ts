import "server-only";

/**
 * HOST-OWNED, KEYED credential fingerprints for LLM providers (cinatra#2388,
 * epic #2385 S3).
 *
 * The provider-commit state machine needs to answer ONE question durably:
 * "is the credential the commitment was earned under still the credential that
 * is configured?" — without ever persisting the credential, and without
 * persisting anything an offline attacker could dictionary-attack.
 *
 * So the stored value is a VERSIONED, HOST-SECRET-KEYED digest:
 *
 *   `cfv1:` + HMAC-SHA256(hostKey, "llm-credential-fingerprint|v1|<provider>|<key>")
 *
 *  - KEYED (HMAC with the host's `CINATRA_ENCRYPTION_KEY`), never a bare hash:
 *    an unkeyed digest of an API key is an offline-crackable oracle. Neither
 *    raw credentials nor unkeyed digests are ever persisted, returned, or
 *    logged by this module.
 *  - VERSIONED (`cfv1:` prefix) so a future derivation change makes every old
 *    stored fingerprint an honest MISMATCH instead of a silent false match.
 *  - PROVIDER-BOUND (the provider id is in the preimage) so the same key pasted
 *    into two connectors never yields a cross-provider match.
 *
 * FAIL-CLOSED SEMANTICS. The reader distinguishes three outcomes because the
 * state machine treats them differently:
 *
 *   readable              — a credential exists and was digested.
 *   absent                — the connector answered authoritatively: no key.
 *                           (Detects deletion/rotation: never matches a stored
 *                           fingerprint.)
 *   unreadable            — the connector is missing, exposes no key reader,
 *                           threw, or the host secret is unavailable. NEVER
 *                           matches anything ("unreadable connector/credential
 *                           ⇒ fail-closed mismatch"), and — distinctly — tells
 *                           the lazy receipt migration to leave the instance
 *                           unbackfilled rather than wrongly complete.
 */

import { createHmac } from "node:crypto";

import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";

export const CREDENTIAL_FINGERPRINT_VERSION_PREFIX = "cfv1:";

export type LiveCredentialFingerprint =
  | { status: "readable"; fingerprint: string }
  | { status: "absent" }
  | {
      status: "unreadable";
      reason:
        | "connector-unavailable"
        | "no-credential-reader"
        | "credential-read-failed"
        | "host-secret-unavailable";
    };

/** The host HMAC key, or null when unavailable (⇒ unreadable, fail closed). */
function readHostSecret(): string | null {
  const raw = process.env.CINATRA_ENCRYPTION_KEY?.trim();
  return raw && raw.length >= 32 ? raw : null;
}

/**
 * Derive the keyed fingerprint for a raw credential. Exposed for the commit
 * machine's tests only — production callers use the live reader below. The raw
 * credential is consumed and never stored; the return value is safe to persist.
 */
export function deriveKeyedCredentialFingerprint(
  provider: string,
  rawCredential: string,
  hostSecret: string,
): string {
  const digest = createHmac("sha256", hostSecret)
    .update(`llm-credential-fingerprint|v1|${provider}|${rawCredential}`)
    .digest("hex");
  return `${CREDENTIAL_FINGERPRINT_VERSION_PREFIX}${digest}`;
}

/**
 * Read the LIVE configured credential for `provider` through the connector's
 * own async configured-connection surface and return its keyed fingerprint.
 *
 * `surfaceOverride` exists for tests; production callers omit it and the
 * surface resolves through the live capability registry.
 */
export async function readLiveCredentialFingerprint(
  provider: string,
  surfaceOverride?: { getConfiguredAPIKey?: () => Promise<string | null> } | null,
): Promise<LiveCredentialFingerprint> {
  const surface =
    surfaceOverride !== undefined ? surfaceOverride : getLlmProviderSurface(provider);
  if (!surface) {
    return { status: "unreadable", reason: "connector-unavailable" };
  }
  if (typeof surface.getConfiguredAPIKey !== "function") {
    // A connector that exposes no credential reader cannot be fingerprinted —
    // that is an UNREADABLE surface, not an authoritative "no key".
    return { status: "unreadable", reason: "no-credential-reader" };
  }
  const hostSecret = readHostSecret();
  if (!hostSecret) {
    return { status: "unreadable", reason: "host-secret-unavailable" };
  }
  let rawKey: string | null;
  try {
    rawKey = await surface.getConfiguredAPIKey();
  } catch {
    // The thrown error may echo credential material — it is deliberately not
    // logged or propagated from here.
    return { status: "unreadable", reason: "credential-read-failed" };
  }
  if (!rawKey || rawKey.trim().length === 0) {
    return { status: "absent" };
  }
  return {
    status: "readable",
    fingerprint: deriveKeyedCredentialFingerprint(provider, rawKey, hostSecret),
  };
}

/**
 * Does the LIVE credential still match a STORED fingerprint?
 *
 * True ONLY when a stored fingerprint exists, the live read succeeded, and the
 * two digests are equal. Every other combination — no stored value, absent
 * credential, unreadable surface — is a MISMATCH (fail closed): a commitment
 * whose credential cannot be re-verified must reopen the key flow, never coast.
 */
export function liveCredentialFingerprintMatches(
  stored: string | null | undefined,
  live: LiveCredentialFingerprint,
): boolean {
  if (!stored) return false;
  if (live.status !== "readable") return false;
  // Version discipline: both sides must carry the current prefix — an old
  // derivation's value never silently matches a new one.
  if (!stored.startsWith(CREDENTIAL_FINGERPRINT_VERSION_PREFIX)) return false;
  return stored === live.fingerprint;
}
