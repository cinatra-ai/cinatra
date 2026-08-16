// ---------------------------------------------------------------------------
// /notifications v2 — feed view-model (cinatra#1557, E7).
//
// Pure, framework-free mapping from E5's `UnifiedFeedItem` (server data layer,
// `src/lib/approvals/unified-feed.ts`) to a SERIALIZABLE row
// view-model the client feed renders. Kept `server-only`-free so BOTH the
// server page (initial paint) and `feed-window.ts`'s bounded union-feed walk
// (cinatra#2380, S2 — the `loadFeedWindow`/`fetchFeedWindow` known-total
// pagination path) reuse one mapper, and so the client can import the TYPES
// (erased at build) and the pure filter/derivation/pagination helpers.
//
// Why a view-model rather than the raw row: `ApprovalRow.raw` is adapter-private
// (and possibly non-serializable), so we PICK only the public, serializable
// fields an approval row needs across the server→client boundary and drop
// `raw`. Notifications are already a pure serializable shape (`AppNotification`)
// and pass through whole so the client can reuse the `flyout-state` helpers for
// the collapse/unread/in-progress derivations.
//
// The §II eligibility contract ("Needs action" = rows the VIEWER can actually
// decide, not raw pendingness) is computed HERE, server-side, per row, and
// carried as `actionable` + `decideKind`. See {@link isApprovalActionable}.
// ---------------------------------------------------------------------------

import { configurationHrefForViewer } from "@/lib/configuration-href";
import type { UnifiedFeedItem } from "@/lib/approvals/unified-feed";
import type { AppNotification } from "@cinatra-ai/notifications/types";
import type { RowEligibility } from "@/lib/approvals/sources/types";
import {
  AGENT_SOURCE_ID,
  PROMOTION_SOURCE_ID,
  WORKFLOW_SOURCE_ID,
} from "@/lib/approvals/sources/source-ids";
import {
  collapseByJobId,
  getInProgressItems,
  getUnreadItems,
  isRunningProgressNotification,
} from "@cinatra-ai/notifications/client";

// Stable PUBLIC approval-source ids. Hardcoded (not imported) so this module
// stays server-only-free and unit-testable without dragging the heavy source
// runtimes (`marketplace-shared` / `host-port-grants.contract` are `server-only`
// and pull the marketplace-mcp / host-port runtimes). These strings are the
// same stable keys `canonicalSourceKey`/the registry key on; a drift would break
// the E5 dedup tests too. Source of truth:
//   • host-port-grants.contract.ts        → HOST_PORT_GRANTS_SOURCE_ID
//   • marketplace-shared.ts               → the two moderation ids
const HOST_PORT_GRANTS_SOURCE_ID = "extension-host-port-grants";
const MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID = "marketplace-submission-moderation";
const MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID = "marketplace-vendor-app-moderation";

/**
 * Rendered rows per page (design@0.1.2 §VII "Pagination — 25 per page"),
 * counted over the FILTERED, POST-COLLAPSE rendered rows — never over raw
 * fetched rows. Down from the v1 "Load more" page size of 30. The server-side
 * fetch batch size used to WALK the underlying keyset union until a page's
 * worth of filtered rows is available is a separate, larger constant (see
 * {@link ./feed-window.ts}'s `FEED_FETCH_BATCH_SIZE`) — never conflate the two.
 */
export const FEED_PAGE_SIZE = 25;

/**
 * The inline decide affordance an ACTIONABLE approval row renders in its
 * trailing slot. `none` = no inline decide (a non-eligible / read-only row).
 * The mapping is by source; the four marketplace *moderation* sources share the
 * moderate affordance, and the two marketplace *self* sources (my-submissions /
 * vendor-app-status) never produce an actionable row on this surface (they are
 * `mine`-direction, §II "awaiting others").
 */
export type ApprovalDecideKind =
  | "agent"
  | "host-port"
  | "promotion"
  | "marketplace-moderate"
  | "none";

/** Serializable approval-row view-model (no `raw`). */
export interface ApprovalRowVM {
  sourceId: string;
  rowId: string;
  title: string;
  subtitle?: string;
  /** Source-native status token (kept for reference; the surface renders an
   *  eligibility-driven pill, not this token — §II). */
  status: string;
  href?: string;
  version?: string;
  eligibility?: RowEligibility;
  direction: "inbox" | "mine";
  /** §II: the viewer can actually decide this row — drives the Needs-action
   *  chip, the eligibility pill, and whether an inline decide renders. */
  actionable: boolean;
  /** Which inline decide to render when `actionable`; `none` otherwise. */
  decideKind: ApprovalDecideKind;
}

export type FeedRowVM =
  | {
      key: string;
      kind: "notification";
      createdAt: string;
      notification: AppNotification;
    }
  | {
      key: string;
      kind: "approval";
      createdAt: string;
      approval: ApprovalRowVM;
    };

/** One page of the feed, cursor pre-encoded to an opaque token for the client. */
export interface FeedPageVM {
  items: FeedRowVM[];
  /** Opaque next-page cursor token; null when exhausted OR degraded. */
  nextCursor: string | null;
  /** True when the approval half is incomplete (§VI degraded line + retry). */
  degraded: boolean;
}

/** The inline decide affordance for a source (independent of eligibility). */
export function approvalDecideKind(sourceId: string): ApprovalDecideKind {
  switch (sourceId) {
    case AGENT_SOURCE_ID:
      return "agent";
    case HOST_PORT_GRANTS_SOURCE_ID:
      return "host-port";
    case PROMOTION_SOURCE_ID:
      // One shared source for every row-scope promotion flow (#1560); an inbox
      // row's subject type rides its id — the generic promotion decide affordance
      // forwards the CAS `version` so the subject backend's edit-after-view guard
      // holds across memory (#1381) / artifact (#1437) / … alike.
      return "promotion";
    case MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID:
    case MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID:
      return "marketplace-moderate";
    default:
      return "none";
  }
}

/**
 * §II — "Needs action" is eligibility, not raw pendingness. A row is actionable
 * (the viewer can actually decide it) iff:
 *   • it is an INBOX row (the viewer's to decide) — the E5 layer only surfaces
 *     an inbox row when the source's `appliesTo(inbox)` passed for THIS viewer
 *     (agent inbox is admin-only, marketplace moderation is moderator-gated…),
 *     so an inbox row's mere presence already implies the viewer can participate;
 *   • it is NOT the read-only workflow-legacy passthrough (`inboxActionable:false`);
 *   • the source exposes a known inline decide affordance;
 *   • the source's OPTIONAL row eligibility (#1045, marketplace only) does not
 *     explicitly deny EVERY offered decision. When the marketplace hands back
 *     `can_approve:false` AND `can_reject:false`, the viewer cannot actually
 *     decide the row, so it is NOT "Needs action" — it renders its status pill
 *     with no inline action, exactly like an own-request. Unknown hints
 *     (`undefined`) leave the row actionable; action-time enforcement at the
 *     source stays authoritative.
 * A `mine`-direction row (an approval the viewer requested and awaits others on)
 * is not actionable here UNLESS the source itself computed `decidableOwn`
 * (cinatra#2599) — e.g. the agent-creation single-admin self-approval
 * exception, where the "others" the row would otherwise await don't exist.
 * That is a GRANT signal only the owning source can compute; everything else
 * below (decide-kind / denied eligibility) still gates the row same as inbox.
 */
export function isApprovalActionable(
  sourceId: string,
  direction: "inbox" | "mine",
  eligibility?: RowEligibility,
  decidableOwn?: boolean,
): boolean {
  if (direction !== "inbox" && !decidableOwn) return false;
  if (sourceId === WORKFLOW_SOURCE_ID) return false;
  if (approvalDecideKind(sourceId) === "none") return false;
  if (
    eligibility &&
    eligibility.can_approve === false &&
    eligibility.can_reject === false
  ) {
    return false;
  }
  return true;
}

/**
 * Map an E5 `UnifiedFeedItem[]` to the serializable feed view-model.
 *
 * `viewerIsAdmin` is the epic's aligned-affordances rule applied at RENDER
 * (cinatra#2701, epic #2699 S2): `/configuration` is admin-only, so an href
 * pointing there is dropped from the view-model for a non-admin viewer and the
 * row falls back to its existing href-less species — the approval card without
 * its whole-card link, the notification card with its mark-read activation.
 *
 * Doing it HERE, on the way out, is what covers rows that were written before
 * the epic: an author's decision notification persisted months ago still holds
 * `/configuration/agents/approvals/<id>` in the database, and the stored value
 * is deliberately left alone. Nothing dead-ends because nothing renders it.
 *
 * Defaults to `false` so a caller that forgets the argument suppresses rather
 * than leaks — no overload of this can offer a link it should not.
 */
export function buildFeedRowVMs(
  items: UnifiedFeedItem[],
  viewerIsAdmin = false,
): FeedRowVM[] {
  const out: FeedRowVM[] = [];
  for (const item of items) {
    if (item.kind === "notification" && item.notification) {
      const href = configurationHrefForViewer(item.notification.href, viewerIsAdmin);
      out.push({
        key: `notification:${item.notification.id}`,
        kind: "notification",
        createdAt: item.createdAt,
        notification:
          href === item.notification.href
            ? item.notification
            : { ...item.notification, href },
      });
    } else if (item.kind === "approval" && item.approval) {
      const { row, direction } = item.approval;
      const actionable = isApprovalActionable(row.sourceId, direction, row.eligibility, row.decidableOwn);
      out.push({
        key: `approval:${item.sourceKey}:${item.id}`,
        kind: "approval",
        createdAt: item.createdAt,
        approval: {
          sourceId: row.sourceId,
          rowId: row.id,
          title: row.title,
          subtitle: row.subtitle,
          status: row.status,
          href: configurationHrefForViewer(row.href, viewerIsAdmin),
          version: row.version,
          eligibility: row.eligibility,
          direction,
          actionable,
          decideKind: actionable ? approvalDecideKind(row.sourceId) : "none",
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client-side filter derivation (§III). Pure — reuses the `flyout-state`
// helpers over the NOTIFICATION subset so the single chronological VM list is
// filtered in place (never re-ordered, never split into a second list).
// ---------------------------------------------------------------------------

export type FilterChip = "all" | "needs-action" | "unread" | "in-progress";

export interface FeedDerivation {
  needsActionCount: number;
  unreadCount: number;
  inProgressCount: number;
  /** Keys visible under each chip. Approvals are never in `unread`/`inProgress`;
   *  notifications are never in `needsAction`. `all` collapses running+terminal
   *  notification duplicates by job (approvals always shown). */
  allKeys: Set<string>;
  needsActionKeys: Set<string>;
  unreadKeys: Set<string>;
  inProgressKeys: Set<string>;
}

function notificationsOf(vms: FeedRowVM[]): AppNotification[] {
  const out: AppNotification[] = [];
  for (const v of vms) if (v.kind === "notification") out.push(v.notification);
  return out;
}

/**
 * Derive the chip counts and the per-chip visible-key sets over the loaded VM
 * list. `pathname` is the current route (the page itself, `/notifications`), so
 * the Unread count stays consistent with the flyout's mark-read-on-navigate
 * semantics.
 */
export function deriveFeed(vms: FeedRowVM[], pathname?: string): FeedDerivation {
  const notifs = notificationsOf(vms);
  const collapsed = collapseByJobId(notifs);
  const collapsedIds = new Set(collapsed.map((n) => n.id));
  const unreadIds = new Set(getUnreadItems(collapsed, pathname).map((n) => n.id));
  const inProgressIds = new Set(getInProgressItems(notifs).map((n) => n.id));

  const allKeys = new Set<string>();
  const needsActionKeys = new Set<string>();
  const unreadKeys = new Set<string>();
  const inProgressKeys = new Set<string>();

  for (const v of vms) {
    if (v.kind === "approval") {
      allKeys.add(v.key);
      if (v.approval.actionable) needsActionKeys.add(v.key);
      continue;
    }
    const id = v.notification.id;
    if (collapsedIds.has(id)) allKeys.add(v.key);
    if (unreadIds.has(id)) unreadKeys.add(v.key);
    if (inProgressIds.has(id)) inProgressKeys.add(v.key);
  }

  return {
    needsActionCount: needsActionKeys.size,
    unreadCount: unreadIds.size,
    inProgressCount: inProgressIds.size,
    allKeys,
    needsActionKeys,
    unreadKeys,
    inProgressKeys,
  };
}

/** The visible-key set for a chip. */
export function keysForChip(d: FeedDerivation, chip: FilterChip): Set<string> {
  switch (chip) {
    case "needs-action":
      return d.needsActionKeys;
    case "unread":
      return d.unreadKeys;
    case "in-progress":
      return d.inProgressKeys;
    default:
      return d.allKeys;
  }
}

/** Whether a notification row should render its unread read-dot (§II: read-state
 *  is a notifications-only concept; running rows are auto-read). */
export function notificationIsUnread(n: AppNotification): boolean {
  return !n.readAt && !isRunningProgressNotification(n);
}

// ---------------------------------------------------------------------------
// §VII Pagination — known-total, 25/page over the filtered, post-collapse rows.
// ---------------------------------------------------------------------------

/** One numbered page of the feed for a given filter tab. `page` is 1-indexed
 *  and CLAMPED to `[1, pageCount]` (a stale/out-of-range request — e.g. a tab
 *  switch that shrinks the row count — never yields an empty page 7 of 3). */
export interface FeedWindowVM {
  pageItems: FeedRowVM[];
  page: number;
  pageCount: number;
  /** Rows in `chip`'s filtered, post-collapse set — the pager's "N" (§VII: a
   *  known total, like every other list — never the unknown-total variant). */
  total: number;
  needsActionCount: number;
  unreadCount: number;
  inProgressCount: number;
  /** True when the WHOLE feed (every chip, unfiltered) is empty — the §V
   *  universal "No notifications" state. A chip that merely matches zero rows
   *  while the feed itself is non-empty is a different, non-universal empty
   *  ("nothing needs action right now"). */
  feedIsEmpty: boolean;
}

/**
 * Slice ONE fully-walked, ordered VM list (every row the union feed holds, or
 * as many as the server's bounded walk could gather — see `feed-window.ts`)
 * into the requested page for `chip`. Pure — the walk/backfill (fetching
 * enough keyset segments to cover the request) is the server's job; this
 * function only counts and slices what it is handed, so it is exercised
 * directly by unit tests without a DB.
 */
export function paginateFeed(
  vms: FeedRowVM[],
  chip: FilterChip,
  page: number,
  pageSize: number = FEED_PAGE_SIZE,
): FeedWindowVM {
  const derivation = deriveFeed(vms, CURRENT_PATHNAME_UNUSED);
  const visibleKeys = keysForChip(derivation, chip);
  const visible = vms.filter((v) => visibleKeys.has(v.key));
  const total = visible.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = visible.slice(start, start + pageSize);
  return {
    pageItems,
    page: safePage,
    pageCount,
    total,
    needsActionCount: derivation.needsActionCount,
    unreadCount: derivation.unreadCount,
    inProgressCount: derivation.inProgressCount,
    feedIsEmpty: derivation.allKeys.size === 0,
  };
}

// `deriveFeed`'s `pathname` param only affects the flyout's mark-read-on-
// navigate Unread derivation for the CURRENT route; the feed page always
// derives against itself, so this is a fixed constant rather than a param
// threaded through every caller of `paginateFeed`.
const CURRENT_PATHNAME_UNUSED = "/notifications";
