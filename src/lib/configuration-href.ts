/**
 * ONE rule for every `/configuration` href a DATA producer emits
 * (cinatra#2701, epic #2699 S2).
 *
 * `/configuration` is the platform-admin area end to end (S1, #2700): the
 * segment layout, every page, and every server action behind them refuse a
 * non-admin session. So a link into `/configuration` handed to a non-admin is
 * an affordance that can only bounce. This module is the shared predicate the
 * producers use to withhold such an href from a non-admin — the render-time
 * half of the same rule lives in `@/components/viewer-admin-context`.
 *
 * Deliberately PURE and free of `server-only` so the notifications feed
 * view-model (which the client imports) and the server-side producers (the
 * approvals MCP output, the notification-row writer) can share one implementation.
 *
 * It is NOT an authorization boundary and must never be mistaken for one — the
 * gates S1 installed are. This only decides whether an affordance is offered.
 */

/** True when `href` addresses the admin-only `/configuration` segment. */
export function isConfigurationHref(href: string | null | undefined): boolean {
  if (typeof href !== "string") return false;
  // Only same-origin, root-relative paths can reach the segment; an absolute
  // URL or a `/configurations…` sibling is not it.
  return href === "/configuration" || href.startsWith("/configuration/") ||
    href.startsWith("/configuration?") || href.startsWith("/configuration#");
}

/**
 * The href this viewer should be offered: the original for a platform admin,
 * `undefined` for everyone else when it points into `/configuration`.
 *
 * Returning `undefined` (rather than a substitute destination) is deliberate:
 * every consumer already has a no-href rendering — the notifications feed's
 * href-less card species, the approvals actions menu without its Details link,
 * the MCP row without the field. A substitute would invent a destination the
 * epic never decided on.
 */
export function configurationHrefForViewer(
  href: string | null | undefined,
  viewerIsAdmin: boolean,
): string | undefined {
  if (typeof href !== "string" || href.length === 0) return undefined;
  if (viewerIsAdmin) return href;
  return isConfigurationHref(href) ? undefined : href;
}
