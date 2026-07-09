// -----------------------------------------------------------------------------
// flashHref — pure URL builder for the codes-only flash protocol.
//
// A mutating "use server" action redirects back to a destination carrying an
// outcome CODE (`?notice=<code>` / `?error=<code>`); the SearchParamToast island
// at the mount site maps that code to a STATIC, server-trusted message — never
// toasting URL-derived text (which would let a crafted `?error=<spoofed link>`
// inject a toast). This helper builds that redirect target.
//
// PURE: no `redirect()` wrapper and no `next` dependency (this package has no
// `next`). The caller passes the result to its own framework `redirect()`.
//
// - Preserves any existing query string and hash already on `base`.
// - Drops undefined keys (only the provided flash codes are written).
// - Uses `set()` (not `append()`), so re-issuing a code REPLACES a stale one
//   rather than leaving a duplicate that `searchParams.get()` would read first.
// -----------------------------------------------------------------------------

export type FlashParams = {
  /** Success/neutral outcome code (maps to a static success toast). */
  notice?: string;
  /** Failure outcome code (maps to a static error toast). */
  error?: string;
};

// Sentinel origin used only to satisfy the WHATWG URL parser for relative
// targets (the common case, e.g. "/setup/name"); it is stripped from the
// result for relative inputs.
const SENTINEL_ORIGIN = "http://flashhref.invalid";
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Build a redirect target carrying the codes-only flash protocol params.
 *
 * @param base An absolute-path target (e.g. "/setup/name") or a full URL. Any
 *   existing query/hash is preserved.
 * @param params The flash codes to write; undefined keys are omitted.
 */
export function flashHref(base: string, params: FlashParams = {}): string {
  const isAbsolute = ABSOLUTE_URL.test(base);
  const url = new URL(base, SENTINEL_ORIGIN);

  if (params.notice !== undefined) url.searchParams.set("notice", params.notice);
  if (params.error !== undefined) url.searchParams.set("error", params.error);

  // For a full URL, return it whole; for a relative target, strip the sentinel
  // origin and return path + query + hash so the redirect stays same-origin.
  return isAbsolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}
