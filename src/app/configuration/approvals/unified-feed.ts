import "server-only";

// ---------------------------------------------------------------------------
// Unified notifications + pending-approvals data layer (cinatra#1555, E5).
//
// Feeds ONE chronological `/notifications` list (E7) that merge-sorts the two
// disjoint queues the epic (#1549) unifies:
//
//   • notifications — one Postgres table, genuinely DB-paged (keyset seek over
//     `packages/notifications` via `listNotificationsKeysetForUserId`);
//   • pending approvals — the read-time-federated `ApprovalSource` registry
//     (KEPT design decision: approvals are NOT materialized as rows). Small N,
//     so the full pending set is fetched per source on every page call.
//
// This is a TWO-TIER merge, not one SQL query. The union order and its cursor
// are defined here; the two halves keep their own storage.
//
// ── Order ──────────────────────────────────────────────────────────────────
// `createdAt DESC, sourceKey ASC, id DESC` (newest first; deterministic ties).
// The primary key is compared by EPOCH (millisecond), NOT raw string, so two
// spellings of the same instant (`…01:00+01:00` vs `…00:00Z`) tie correctly and
// the in-memory order agrees with the SQL seek boundary (which truncates the
// notification column to milliseconds). `sourceKey` is a NEW concept (it exists
// nowhere else in the codebase): the second-tier partition key of a feed row —
//   • an approval row → its CANONICAL source key ({@link canonicalSourceKey}):
//     the two marketplace moderation↔self pairs collapse onto one stable key so
//     the cursor position of a deduped row never depends on which mirror won;
//   • a notification  → the constant {@link NOTIFICATION_SOURCE_KEY}.
// So the cross-stream tie-break at an equal instant is fully defined: order by
// `sourceKey` (a notification, key `"notifications"`, sorts after most approval
// sources and before `workflow-legacy-passthrough`), then by `id` descending.
//
// ── Pending-only predicate ───────────────────────────────────────────────────
// A decided/invalidated approval must LEAVE the list on the next fetch. This is
// a SOURCE contract, not a status allowlist here: every source's `fetchInbox`
// is already pending-only at the data layer (server-side status filter /
// `approvalAwaitsDecision` / an org-scoped pending listing), and `fetchMine` is
// normalized to pending by calling it with `{ status: PENDING_MINE_STATUS }`
// (only the agent source interprets it — the exact call #1555 specifies instead
// of patching that source; the marketplace `fetchMine`s self-filter to pending;
// the local sources return an empty `fetchMine`). The union deliberately does
// NOT re-filter by status string: the source status vocabularies are
// heterogeneous (agent `proposed`, marketplace `pending`/`applied`, …), so a
// hardcoded allowlist would drop legitimate pending rows.
//
// ── Union + dedup ───────────────────────────────────────────────────────────
// Dedup is an EXPLICIT pairing, not a blind cross-registry `(sourceId,id)`
// check: the only collision-capable pairs are the two marketplace
// moderation↔self pairs, which describe the SAME underlying row under DIFFERENT
// `sourceId`s but the SAME shared id (`submission_id` / `application_id`). Both
// are reachable only for a viewer whose org holds BOTH the admin/moderator
// credential AND the instance's own vendor/instance credential. The Inbox
// (actionable) row wins. The deduped row's FULL cursor tuple is stable
// regardless of which mirror fetched it: `sourceKey` is the canonical namespace
// ({@link canonicalSourceKey}), `id` is the shared underlying id, and BOTH
// adapters of a pair emit the SAME `createdAt` at the source layer (the
// submission pair from the marketplace `submitted_at`; the vendor-application
// pair from the shared LOCAL `resolveOwnVendorApplicationCreatedAt`, since the
// self-status endpoint has no applied timestamp). So a transient failure of one
// mirror between pages cannot move the row's cursor position. All other sources
// — including agent-creation-requests, whose Inbox explicitly excludes the
// viewer's own rows — can never collide.
// ---------------------------------------------------------------------------

import {
  listNotificationsKeysetForUserId,
  type NotificationsKeysetBefore,
} from "@/lib/notifications";
import type { AppNotification } from "@/lib/notifications";

import { availableSources } from "./sources/registry";
import {
  MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID,
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID,
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID,
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID,
} from "./sources/marketplace-shared";
import type {
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Direction,
} from "./sources/types";

// The constant `sourceKey` every notification row carries in the merge. Distinct
// from any approval source key (those are hyphenated family ids / marketplace
// namespaces) so a notification and an approval never share a `(sourceKey, id)`
// identity.
export const NOTIFICATION_SOURCE_KEY = "notifications";

// Canonical dedup namespaces for the two collision-capable marketplace pairs.
const MARKETPLACE_SUBMISSION_KEY = "marketplace-submission";
const MARKETPLACE_VENDOR_APPLICATION_KEY = "marketplace-vendor-application";

// The `status` opt handed to every source's `fetchMine`. Only the agent-creation
// source interprets it (narrowing its "Your requests" window to in-flight
// proposals); the marketplace `fetchMine`s ignore opts and self-filter to
// pending. #1555 specifies this over patching the agent source.
export const PENDING_MINE_STATUS = "proposed";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** One row of the unified feed. `notification` XOR `approval` is populated per
 *  `kind`; the three top-level fields are the merge/cursor keys. `createdAt` is
 *  ALWAYS a canonical UTC millisecond ISO string ({@link canonicalizeInstant}). */
export interface UnifiedFeedItem {
  kind: "notification" | "approval";
  /** Canonical UTC ISO (ms) — primary sort key (compared by epoch). */
  createdAt: string;
  /** Second-tier sort/partition key — see {@link canonicalSourceKey} / {@link NOTIFICATION_SOURCE_KEY}. */
  sourceKey: string;
  /** Row id — third-tier sort key + dedup identity within a `sourceKey`. */
  id: string;
  notification?: AppNotification;
  approval?: { row: ApprovalRow; direction: Direction };
}

/** Opaque keyset position: the last item returned on the previous page. */
export interface UnifiedFeedCursor {
  createdAt: string;
  sourceKey: string;
  id: string;
}

export interface UnifiedFeedPage {
  items: UnifiedFeedItem[];
  /** Null when the feed is exhausted OR when the page is `degraded` (an
   *  incomplete approval snapshot yields no sound keyset cursor — see below). */
  nextCursor: UnifiedFeedCursor | null;
  /** True when at least one pending-approval source failed to load, so the
   *  approval half of this page is INCOMPLETE. A degraded page still returns the
   *  rows that DID load (notifications + the surviving sources, correctly
   *  ordered) but NEVER a `nextCursor`: a keyset cursor derived from a partial
   *  snapshot is unsound (it would permanently filter the failed source's
   *  above-cursor rows out of later pages once it recovers). The caller shows the
   *  partial page + a retry affordance and re-requests the SAME cursor —
   *  REPLACING this partial segment with the retry's result — rather than paging
   *  forward or appending. */
  degraded: boolean;
}

/** Injectable seams so the merge is unit-testable without a DB or the real
 *  registry. Production callers omit `deps`. */
export interface UnifiedFeedDeps {
  /** Override the source list (default: `availableSources(viewer)`). */
  sources?: ApprovalSource[];
  /** Override the notifications keyset reader (default: the host facade). */
  listNotifications?: (args: {
    userId: string;
    limit: number;
    before?: NotificationsKeysetBefore;
  }) => AppNotification[];
}

export interface LoadUnifiedFeedOptions {
  limit?: number;
  cursor?: UnifiedFeedCursor | null;
  deps?: UnifiedFeedDeps;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Canonicalize any timestamp to UTC millisecond ISO (`…Z`) so that (a) the
 * in-memory comparator and the SQL seek boundary agree on equal instants
 * expressed with different offsets, and (b) all cursor timestamps are a single
 * representation Postgres parses identically via `::timestamptz`. An
 * unparseable value is returned unchanged (the comparator then sorts it last).
 */
export function canonicalizeInstant(value: string): string {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
}

/**
 * Total order over feed positions: `createdAt DESC, sourceKey ASC, id DESC`.
 * The primary key compares by EPOCH (ms) — not raw string — so canonical and
 * non-canonical spellings of the same instant tie. An unparseable `createdAt`
 * sorts last (oldest). Returns < 0 when `a` sorts BEFORE `b` (nearer the top).
 */
export function compareUnifiedDesc(
  a: { createdAt: string; sourceKey: string; id: string },
  b: { createdAt: string; sourceKey: string; id: string },
): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const ea = Number.isFinite(ta) ? ta : -Infinity;
  const eb = Number.isFinite(tb) ? tb : -Infinity;
  if (ea !== eb) return ea > eb ? -1 : 1;
  if (a.sourceKey !== b.sourceKey) return a.sourceKey < b.sourceKey ? -1 : 1;
  if (a.id !== b.id) return a.id > b.id ? -1 : 1;
  return 0;
}

/** An item is on a LATER page than the cursor iff the cursor sorts strictly
 *  before it. */
function isAfterCursor(cursor: UnifiedFeedCursor, item: UnifiedFeedItem): boolean {
  return compareUnifiedDesc(cursor, item) < 0;
}

function cursorOf(item: UnifiedFeedItem): UnifiedFeedCursor {
  return { createdAt: item.createdAt, sourceKey: item.sourceKey, id: item.id };
}

/**
 * Translate a union cursor into the notification-stream seek boundary. The
 * notification stream is homogeneous (`sourceKey === NOTIFICATION_SOURCE_KEY`),
 * so the cross-stream tie reduces to a comparison of the cursor's `sourceKey`
 * against the notification key — see {@link NotificationsKeysetBefore}.
 */
export function notificationBoundFromCursor(
  cursor: UnifiedFeedCursor,
): NotificationsKeysetBefore {
  const createdAt = canonicalizeInstant(cursor.createdAt);
  if (cursor.sourceKey === NOTIFICATION_SOURCE_KEY) {
    return { boundary: "row", createdAt, id: cursor.id };
  }
  // Cursor is an approval. At its instant, notifications sort AFTER it when the
  // notification key is greater (its own `sourceKey` is smaller) ⇒ every
  // equal-instant notification is still ahead (inclusive); otherwise none
  // remain (exclusive).
  return cursor.sourceKey < NOTIFICATION_SOURCE_KEY
    ? { boundary: "createdAtInclusive", createdAt }
    : { boundary: "createdAtExclusive", createdAt };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/**
 * Canonical source key for an approval row. The two marketplace moderation↔self
 * pairs describe the SAME underlying row under DIFFERENT `sourceId`s, so they
 * map to ONE stable namespace — this is BOTH the deduped row's `sourceKey`
 * (stable cursor position regardless of which mirror won) AND the dedup
 * identity. Every other source keeps its own `sourceId`.
 */
export function canonicalSourceKey(sourceId: string): string {
  if (
    sourceId === MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID ||
    sourceId === MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID
  ) {
    return MARKETPLACE_SUBMISSION_KEY;
  }
  if (
    sourceId === MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID ||
    sourceId === MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID
  ) {
    return MARKETPLACE_VENDOR_APPLICATION_KEY;
  }
  return sourceId;
}

/** Dedup identity for an approval row: `(canonicalSourceKey, id)`. */
export function approvalDedupKey(sourceId: string, id: string): string {
  return `${canonicalSourceKey(sourceId)}:${id}`;
}

interface TaggedApproval {
  row: ApprovalRow;
  direction: Direction;
}

/**
 * Dedup the pending approvals into one row per underlying item. Inbox
 * (actionable) rows are offered FIRST so, on a collision, the actionable row
 * wins over the read-only self mirror — the deterministic choice that, together
 * with the canonical source key, keeps cursor pagination stable across pages.
 */
export function dedupeApprovals(
  inbox: TaggedApproval[],
  mine: TaggedApproval[],
): TaggedApproval[] {
  const seen = new Map<string, TaggedApproval>();
  for (const tagged of [...inbox, ...mine]) {
    const key = approvalDedupKey(tagged.row.sourceId, tagged.row.id);
    if (!seen.has(key)) seen.set(key, tagged);
  }
  return [...seen.values()];
}

function toApprovalItem(tagged: TaggedApproval): UnifiedFeedItem {
  return {
    kind: "approval",
    createdAt: canonicalizeInstant(tagged.row.createdAt),
    sourceKey: canonicalSourceKey(tagged.row.sourceId),
    id: tagged.row.id,
    approval: { row: tagged.row, direction: tagged.direction },
  };
}

function toNotificationItem(n: AppNotification): UnifiedFeedItem {
  return {
    kind: "notification",
    createdAt: canonicalizeInstant(n.createdAt),
    sourceKey: NOTIFICATION_SOURCE_KEY,
    id: n.id,
    notification: n,
  };
}

// ---------------------------------------------------------------------------
// Pending-approval collection
// ---------------------------------------------------------------------------

/** Outcome of one pending-approval collection pass. `complete` is false when ANY
 *  applicable source's `fetchInbox`/`fetchMine` threw (its rows — possibly a full
 *  multi-page drain — are absent), so the merge must treat the resulting cursor
 *  as UNSOUND (see {@link loadUnifiedFeedPage}). */
interface CollectedApprovals {
  items: UnifiedFeedItem[];
  complete: boolean;
}

/**
 * Fetch and dedup the full pending-approval set for the viewer. Read-time
 * federated (small N) — re-fetched on every page so the deduped set is
 * deterministic and cursor-stable. Pending-only is guaranteed by the source
 * contract (pending-only `fetchInbox`; `fetchMine` called with the pending
 * status); the union does not re-filter by status.
 *
 * A per-source failure is logged, skipped, and RECORDED as `complete: false` (a
 * failing source may drain over several pages — any throw, at any page, drops
 * that source's ENTIRE contribution for this pass, not one row). The feed then
 * degrades gracefully rather than 500ing on one bad remote source — BUT, unlike
 * the page's per-section loader (each section owns an independent cursor), this
 * is ONE merged keyset stream, so an incomplete approval half cannot yield a
 * sound union cursor. `loadUnifiedFeedPage` therefore suppresses `nextCursor`
 * on an incomplete pass instead of silently advancing past the failed source's
 * rows (which would filter them out of every later page until a full reload).
 */
async function collectPendingApprovals(
  viewer: ApprovalViewer,
  sources: ApprovalSource[],
): Promise<CollectedApprovals> {
  const inbox: TaggedApproval[] = [];
  const mine: TaggedApproval[] = [];
  let complete = true;

  await Promise.all(
    sources.map(async (source) => {
      if (source.appliesTo(viewer, "inbox")) {
        try {
          const env = await source.fetchInbox(viewer);
          for (const row of env.rows) inbox.push({ row, direction: "inbox" });
        } catch (err) {
          complete = false;
          logSourceError(source.id, "inbox", err);
        }
      }
      if (source.appliesTo(viewer, "mine")) {
        try {
          const env = await source.fetchMine(viewer, { status: PENDING_MINE_STATUS });
          for (const row of env.rows) mine.push({ row, direction: "mine" });
        } catch (err) {
          complete = false;
          logSourceError(source.id, "mine", err);
        }
      }
    }),
  );

  return { items: dedupeApprovals(inbox, mine).map(toApprovalItem), complete };
}

function logSourceError(sourceId: string, direction: Direction, err: unknown): void {
  console.warn(
    `[unified-feed] approval source '${sourceId}' (${direction}) failed; skipping:`,
    err instanceof Error ? err.message : err,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load one page of the unified notifications + pending-approvals feed, newest
 * first, resumed from `cursor`.
 *
 * Stable keyset pagination over the COMPLETE inputs: no duplicate or skipped row
 * at a page boundary, even under concurrent inserts, because the union cursor is
 * an absolute total-order position that filters BOTH streams exactly (the
 * in-memory approval set; notifications via the derived seek boundary). This
 * holds for the two keyset-ordered halves; it does NOT promise atomicity for a
 * source that itself drains a non-keyset remote (the marketplace moderation
 * queues offset-paginate a remote that exposes no cursor — a best-effort
 * snapshot subject to offset pagination's inherent race, bounded and self-
 * healing on reload).
 *
 * Soundness under source failure: if the approval collection is INCOMPLETE (any
 * source threw — see {@link collectPendingApprovals}), the page is returned
 * `degraded: true` with `nextCursor: null`. Advancing a cursor over a partial
 * snapshot is unsound — the failed source's above-cursor rows would be filtered
 * out of every later page once it recovers — so the feed never pages forward
 * from an incomplete pass; the caller retries the SAME cursor instead.
 */
export async function loadUnifiedFeedPage(
  viewer: ApprovalViewer,
  options: LoadUnifiedFeedOptions = {},
): Promise<UnifiedFeedPage> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = options.cursor ?? null;
  const deps = options.deps ?? {};
  const readNotifications = deps.listNotifications ?? listNotificationsKeysetForUserId;

  const sources = deps.sources ?? (await availableSources(viewer));

  // Tier 1 — the pending-approval set (small N), then keep only rows strictly
  // after the cursor. `complete` is false when any source failed to load.
  const { items: allApprovals, complete } = await collectPendingApprovals(viewer, sources);
  const approvalsAfter = cursor
    ? allApprovals.filter((item) => isAfterCursor(cursor, item))
    : allApprovals;

  // Tier 2 — the notification page after the cursor. `limit + 1` is a sentinel
  // that also detects "more notifications remain" for the exhaustion check.
  const notifications = readNotifications({
    userId: viewer.userId,
    limit: limit + 1,
    before: cursor ? notificationBoundFromCursor(cursor) : undefined,
  }).map(toNotificationItem);

  // Merge + trim. `approvalsAfter` is complete; `notifications` is a bounded
  // window — so `candidates.length > limit` means the feed is not yet exhausted.
  const candidates = [...approvalsAfter, ...notifications].sort(compareUnifiedDesc);
  const items = candidates.slice(0, limit);
  // Only advance the cursor over a COMPLETE approval snapshot: an incomplete
  // pass yields no sound keyset position, so a degraded page never pages forward.
  const hasMore = complete && candidates.length > limit;
  const nextCursor = hasMore && items.length > 0 ? cursorOf(items[items.length - 1]) : null;

  return { items, nextCursor, degraded: !complete };
}

// ---------------------------------------------------------------------------
// Cursor token (de)serialization — a URL-safe opaque string for the E7 route.
// ---------------------------------------------------------------------------

/** Encode a union cursor to a URL-safe opaque token. */
export function encodeUnifiedFeedCursor(cursor: UnifiedFeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode an opaque cursor token; returns null for any malformed/absent token
 *  (a bad cursor degrades to "first page", never throws). */
export function decodeUnifiedFeedCursor(token: string | null | undefined): UnifiedFeedCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as UnifiedFeedCursor).createdAt === "string" &&
      typeof (parsed as UnifiedFeedCursor).sourceKey === "string" &&
      typeof (parsed as UnifiedFeedCursor).id === "string"
    ) {
      const c = parsed as UnifiedFeedCursor;
      return { createdAt: c.createdAt, sourceKey: c.sourceKey, id: c.id };
    }
    return null;
  } catch {
    return null;
  }
}
