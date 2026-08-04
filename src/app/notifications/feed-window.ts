import "server-only";

// ---------------------------------------------------------------------------
// /notifications v2 — known-total, backfilled pagination (cinatra#2380, S2).
//
// The union feed (unified-feed.ts, E5) is a keyset stream with no cheap
// server-side COUNT: approvals are read-time federated (small N, fully
// fetched every call) and notifications are keyset-paged. §VII of the
// ratified design (app-notifications.html v0.1.2) nonetheless requires a
// KNOWN total — numbered pages + an "X of N" caption, like every other list
// — so this module WALKS the union stream, accumulating raw pages via
// repeated `loadUnifiedFeedPage` calls, until it has gathered the ENTIRE feed
// (cursor exhausted) or hit a bounded safety cap. The walked set is then
// collapsed (job dedup) and filtered by the active tab (`paginateFeed`,
// feed-view-model.ts) and sliced into the requested 25-row page — the pinned
// transformation order: fetch segments (keyset) → collapse → active-tab
// filter → paginate the FILTERED, POST-COLLAPSE rows.
//
// A sparse filtered page (e.g. the "Unread" tab when most rows are read)
// BACKFILLS automatically for free: the walk keeps pulling segments until the
// cap or exhaustion regardless of which tab is active, so a tab that matches
// few rows still sees its true, complete count rather than a partial one
// bounded by the FIRST raw batch.
//
// The safety cap exists because this walk is O(feed size) per request (every
// filter/page change re-walks): a viewer with a very long history is bounded
// rather than the request growing unboundedly. `capped: true` on the return
// signals the walk hit the cap before exhausting the stream — the caller
// treats the reported total as a floor, not a promise, in that rare case
// (tracked as a known limitation; the epic's S3 live-hardening pass is where
// a materialized/paginated total would replace this walk if a real deployment
// ever needs one).
// ---------------------------------------------------------------------------

import {
  loadUnifiedFeedPage,
  type UnifiedFeedCursor,
  type UnifiedFeedItem,
} from "@/app/configuration/approvals/unified-feed";
import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";
import type { UnifiedFeedDeps } from "@/app/configuration/approvals/unified-feed";

import {
  buildFeedRowVMs,
  paginateFeed,
  type FeedWindowVM,
  type FilterChip,
} from "./feed-view-model";

/** Rows requested per WALK batch (larger than the render page so a typical
 *  feed resolves in one or two round trips to the union merge). */
export const FEED_FETCH_BATCH_SIZE = 60;
/** Hard cap on raw union rows walked in one request. */
const FEED_WALK_MAX_ITEMS = 1200;
/** Hard cap on round trips, independent of item count (defends a pathological
 *  many-tiny-batches case). */
const FEED_WALK_MAX_BATCHES = 24;

export interface FeedWindowResult extends FeedWindowVM {
  /** True when the union half is incomplete (an approval source failed) — the
   *  §VI degraded line + retry, never shown alongside the pager (§VII). */
  degraded: boolean;
  /** True when the walk stopped on the safety cap rather than exhausting the
   *  feed — `total`/`pageCount` are a floor, not an exact count, in this case. */
  capped: boolean;
  /** The viewer's single newest notification across the WHOLE feed (not just
   *  the current chip/page) — the mark-all-read watermark boundary
   *  (cinatra#1557), correct regardless of which page/tab is active since the
   *  walk always starts from the top. Null when the viewer has no
   *  notifications at all. */
  newestNotification: { id: string; createdAt: string } | null;
}

/**
 * Walk the ENTIRE reachable union feed for `viewer` (bounded), then slice the
 * requested `chip`/`page`. Every filter/page change re-walks from the start —
 * the union has no stable server-side offset to resume from, and approvals are
 * re-fetched in full on every call regardless (E5's existing contract).
 */
export async function loadFeedWindow(
  viewer: ApprovalViewer,
  args: {
    chip: FilterChip;
    page: number;
    deps?: UnifiedFeedDeps;
  },
): Promise<FeedWindowResult> {
  let cursor: UnifiedFeedCursor | null = null;
  const raw: UnifiedFeedItem[] = [];
  let degraded = false;
  let capped = false;

  for (let batch = 0; batch < FEED_WALK_MAX_BATCHES; batch++) {
    const page = await loadUnifiedFeedPage(viewer, {
      limit: FEED_FETCH_BATCH_SIZE,
      cursor,
      deps: args.deps,
    });
    raw.push(...page.items);
    degraded = page.degraded;
    cursor = page.nextCursor;

    if (!cursor) break; // exhausted (or degraded — a degraded page never carries a cursor)
    if (raw.length >= FEED_WALK_MAX_ITEMS) {
      capped = true;
      break;
    }
    if (batch === FEED_WALK_MAX_BATCHES - 1) capped = true;
  }

  const vms = buildFeedRowVMs(raw);
  const window = paginateFeed(vms, args.chip, args.page);

  // The union merge order is createdAt DESC (unified-feed.ts), and the walk
  // always starts at cursor=null, so the FIRST notification-kind VM — if the
  // walk gathered any raw items at all — is genuinely the viewer's newest
  // notification, independent of `capped` (capping only ever truncates the
  // TAIL of the walk, never the head).
  const newestNotificationVm = vms.find((v) => v.kind === "notification");
  const newestNotification =
    newestNotificationVm && newestNotificationVm.kind === "notification"
      ? { id: newestNotificationVm.notification.id, createdAt: newestNotificationVm.createdAt }
      : null;

  return { ...window, degraded, capped, newestNotification };
}
