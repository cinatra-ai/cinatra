"use server";

// ---------------------------------------------------------------------------
// /notifications v2 — pagination server action (cinatra#2380, S2).
//
// Resolves the viewer, then delegates the bounded union-feed walk + known-
// total pagination to `feed-window.ts` (`loadFeedWindow`) — the S2 landing
// replaces the v1 "Load more" keyset append with numbered, known-total pages
// (§VII). The server page (`page.tsx`) calls `loadFeedWindow` directly for the
// first paint (page 1, chip "all"); this action is the client's path for every
// subsequent filter-tab or page change.
// ---------------------------------------------------------------------------

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import type { ApprovalViewer } from "@/lib/approvals/sources/types";

import { loadFeedWindow, type FeedWindowResult } from "./feed-window";
import type { FilterChip } from "./feed-view-model";

const EMPTY_WINDOW: FeedWindowResult = {
  pageItems: [],
  page: 1,
  pageCount: 1,
  total: 0,
  needsActionCount: 0,
  unreadCount: 0,
  inProgressCount: 0,
  feedIsEmpty: true,
  degraded: false,
  capped: false,
  newestNotification: null,
};

/**
 * Fetch the numbered page `page` (1-indexed) of the unified feed narrowed to
 * `chip`. Returns an empty, non-degraded window for an unauthenticated caller
 * (the page itself is behind the sign-in gate; this defends a direct action
 * invocation). An org-less session degrades to notifications-only (no
 * approval sources) via the E5 `sources: []` injection seam — the same
 * policy the server page uses.
 */
export async function fetchFeedWindow(
  chip: FilterChip,
  page: number,
): Promise<FeedWindowResult> {
  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  if (!userId) return EMPTY_WINDOW;

  const orgId = session?.session?.activeOrganizationId ?? null;
  const viewer: ApprovalViewer = {
    userId,
    orgId: orgId ?? "",
    isAdmin: isPlatformAdmin(session),
  };

  return loadFeedWindow(viewer, {
    chip,
    page,
    // No active org → notifications-only (no approval sources) so an
    // org-less session still gets its per-user notifications rather than a
    // doomed fetch.
    ...(orgId ? {} : { deps: { sources: [] } }),
  });
}
