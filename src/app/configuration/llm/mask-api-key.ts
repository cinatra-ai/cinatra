// ---------------------------------------------------------------------------
// Server-side API-key masking for the LLM config surface (cinatra#1690).
//
// The connected key is shown masked (prefix + last 4, e.g. `sk-…AbCd`) so a
// user can tell WHICH key is in use and whether an update landed — without
// the full secret ever reaching the client. Pure and unit-tested; keep every
// render path on this helper so nobody inlines a slice of the raw key.
// ---------------------------------------------------------------------------

/** Reveal-nothing placeholder for short/degenerate keys. */
const FULLY_MASKED = "••••••••";

/**
 * Mask an API key for display: first 3 characters + `…` + last 4. Keys
 * shorter than 20 characters (no real provider key is) are fully masked —
 * revealing 7 of, say, 12 characters would leak most of the secret.
 * Returns null for missing/whitespace-only input so callers can skip the row.
 */
export function maskApiKey(key: string | null | undefined): string | null {
  const k = (key ?? "").trim();
  if (!k) return null;
  if (k.length < 20) return FULLY_MASKED;
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}
