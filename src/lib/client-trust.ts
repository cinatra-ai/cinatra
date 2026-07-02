/**
 * Client-trust helpers for the web shell.
 *
 * These are pure, framework-free functions that centralize the trust
 * boundaries the app enforces on untrusted client-supplied input:
 *  - which cross-frame message origins may command the embedded shell,
 *  - which `?section=` identifiers are safe to interpolate into an inline
 *    <style> selector,
 *  - whether internal error details may be shown to the current audience.
 *
 * Keeping the decisions here (rather than inline in components) makes each
 * boundary independently unit-testable without a DOM.
 */

/**
 * Parse a configured list of trusted embedding origins.
 *
 * Source: `NEXT_PUBLIC_CINATRA_EMBED_ORIGINS` (comma- or whitespace-separated).
 * Because it is a `NEXT_PUBLIC_*` variable it is inlined into the client bundle
 * at build time, so cross-origin embedders are declared when the image is
 * built. Same-origin embedding never needs configuration (see the shell, which
 * always trusts `window.location.origin`).
 *
 * Each entry is canonicalized through `new URL(value).origin`, which:
 *  - lowercases scheme/host and drops any path/query/trailing slash, and
 *  - rejects malformed entries and schemeless hosts (e.g. `"a.com"` throws),
 * so only well-formed origins survive. Duplicates and the opaque `"null"`
 * origin are dropped.
 */
export function parseAllowedEmbedOrigins(
  raw: string | undefined | null,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const token = part.trim();
    if (!token) continue;
    let origin: string;
    try {
      origin = new URL(token).origin;
    } catch {
      // Skip malformed / schemeless entries rather than trusting them.
      continue;
    }
    if (!origin || origin === "null") continue;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * Whether a cross-frame message `origin` is on the trusted allowlist.
 *
 * Exact origin match only — never a prefix/substring test, so a lookalike
 * such as `https://trusted.example.evil.com` can never satisfy an allowlist
 * entry of `https://trusted.example`. The opaque `"null"` origin (sandboxed
 * frames, `data:`/`file:` documents) and empty/undefined origins are always
 * rejected.
 */
export function isTrustedEmbedOrigin(
  origin: string | undefined | null,
  allowed: readonly string[],
): boolean {
  if (!origin || origin === "null") return false;
  return allowed.includes(origin);
}

/**
 * Sanitize a `?section=` identifier before it is interpolated into an inline
 * <style> selector.
 *
 * Returns the value only when it is a short, plain identifier
 * (`[A-Za-z0-9_-]`, 1–64 chars); otherwise `null`. This prevents a crafted
 * value from breaking out of the `[data-section="…"]` selector and injecting
 * arbitrary style rules. Callers treat `null` as "no usable section" and fail
 * closed (they must not fall through to rendering everything on a value that
 * was supplied-but-invalid).
 */
export function sanitizeEmbedSection(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/**
 * Whether internal error details (name / message / stack) may be shown to the
 * current audience. Suppressed in production so end users never see internal
 * file paths or logic; the opaque error digest is shown regardless so support
 * can still correlate a report.
 */
export function shouldExposeErrorDetails(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== "production";
}
