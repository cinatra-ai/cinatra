"use server";

// ---------------------------------------------------------------------------
// /notifications v2 — pagination server action (cinatra#1557, E7).
//
// Loads one more page of the unified feed (E5) from an opaque cursor token, maps
// it to the serializable view-model, and returns it to the client feed. The
// keyset + degraded contract is E5's: a degraded page carries `degraded: true`
// and NO next cursor, so the client re-requests the SAME cursor to REPLACE the
// partial segment rather than paging forward past an incomplete approval half.
// ---------------------------------------------------------------------------

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  loadUnifiedFeedPage,
  decodeUnifiedFeedCursor,
  encodeUnifiedFeedCursor,
} from "@/app/configuration/approvals/unified-feed";
import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";

import { buildFeedRowVMs, FEED_PAGE_SIZE, type FeedPageVM } from "./feed-view-model";

/**
 * Fetch the next page after `cursorToken` (null → first page). Returns an empty,
 * non-degraded page for an unauthenticated caller (the page itself is behind the
 * sign-in gate; this defends a direct action invocation). When the viewer has no
 * active organization the approval half is skipped (notifications-only) via the
 * E5 `sources: []` injection seam — the same policy the server page uses.
 */
export async function loadMoreUnifiedFeed(
  cursorToken: string | null,
): Promise<FeedPageVM> {
  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  if (!userId) return { items: [], nextCursor: null, degraded: false };

  const orgId = session?.session?.activeOrganizationId ?? null;
  const viewer: ApprovalViewer = {
    userId,
    orgId: orgId ?? "",
    isAdmin: isPlatformAdmin(session),
  };

  const page = await loadUnifiedFeedPage(viewer, {
    limit: FEED_PAGE_SIZE,
    cursor: decodeUnifiedFeedCursor(cursorToken),
    // No active org → notifications-only (no approval sources) so an org-less
    // session still gets its per-user notifications rather than a doomed fetch.
    ...(orgId ? {} : { deps: { sources: [] } }),
  });

  return {
    items: buildFeedRowVMs(page.items),
    nextCursor: page.nextCursor ? encodeUnifiedFeedCursor(page.nextCursor) : null,
    degraded: page.degraded,
  };
}
