// URL-addressable restore modal helpers.
//
// Pure string helpers extracted from <RestoreModal> so the idempotent +
// back-button-safe URL behaviour is unit-testable without rendering a client
// component (the repo's vitest runs in a node environment without RTL).

/**
 * Return the pathname+query with the `openRestore` param removed. Used when
 * the restore modal closes so the deep-link query doesn't linger (closing
 * clears it; the modal does NOT reopen on back/forward unless the URL still
 * asks for it). `search` is the raw `location.search` (with or without the
 * leading "?"); the result omits "?" entirely when no params remain.
 */
export function stripOpenRestoreParam(pathname: string, search: string): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  if (!params.has("openRestore")) {
    const existing = params.toString();
    return existing ? `${pathname}?${existing}` : pathname;
  }
  params.delete("openRestore");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
