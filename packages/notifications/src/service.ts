import "server-only";

import { randomUUID } from "crypto";

// Notifications live in this package and depend on host-injected adapters
// rather than direct `@/lib/*` imports. `getNotificationsHostAdapters()`
// supplies postgres concerns, while the local `buildAgentInstancePath`
// duplicate avoids the `@/` boundary violation needed by agent creation
// progress links.
import { buildAgentInstancePath } from "./agent-run-href";

import type {
  NotificationInput,
  NotificationKind,
  NotificationRecipient,
  NotificationRecord,
} from "./types";
import { resolveRecipientToUserIds, topicForRecipient } from "./recipient-policy";
import { getNotificationsHostAdapters } from "./host-adapters";
import { notifPerf, notifPerfNote, notifPerfNow } from "./perf-log";

// ---------------------------------------------------------------------------
// Postgres-backed notifications service.
//
// One row per (user, notification). Topic/admin/team/org recipients
// fan out at write time. Dedupe is handled by the partial unique index in
// the host's drizzle-store.ts via ON CONFLICT DO NOTHING.
//
// All functions are server-only. The host facade in src/lib/notifications.ts
// wraps these and preserves the original 5-function signature contract.
//
// Host coupling is INJECTED via `getNotificationsHostAdapters()` (the
// explicit NotificationsHostAdapters surface) — no direct @/lib/database or
// @/lib/postgres-sync import. `postgresSchema` is the injected replacement
// for the former `@/lib/database` `postgresSchema` constant.
// ---------------------------------------------------------------------------

const NOTIFICATIONS_PER_USER_LIMIT = 200;

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function schemaQualified(table: string): string {
  return `${q(getNotificationsHostAdapters().postgresSchema)}.${q(table)}`;
}

function normalizeKind(kind: NotificationKind | undefined): NotificationKind {
  if (kind === "error" || kind === "warning" || kind === "info") return kind;
  return "success";
}

function rowToRecord(row: Record<string, unknown>): NotificationRecord | null {
  const userId = typeof row.user_id === "string" ? row.user_id : null;
  if (!userId) return null;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  const title = typeof row.title === "string" ? row.title : "";
  const body = typeof row.body === "string" ? row.body : "";
  const kind = normalizeKind(row.kind as NotificationKind | undefined);
  const recipientKind = (typeof row.recipient_kind === "string"
    ? row.recipient_kind
    : "user") as NotificationRecipient["kind"];
  return {
    id,
    userId,
    recipientKind,
    recipientId: typeof row.recipient_id === "string" ? row.recipient_id : undefined,
    topic: typeof row.topic === "string" ? row.topic : `user:${userId}`,
    kind,
    title,
    body,
    href: typeof row.href === "string" ? row.href : undefined,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : undefined,
    sourceJobId:
      typeof row.source_job_id === "string" ? row.source_job_id : undefined,
    sourceJobName:
      typeof row.source_job_name === "string"
        ? row.source_job_name
        : undefined,
    dedupeKey:
      typeof row.dedupe_key === "string" ? row.dedupe_key : undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : typeof row.created_at === "string"
          ? row.created_at
          : new Date().toISOString(),
    readAt:
      row.read_at instanceof Date
        ? row.read_at.toISOString()
        : typeof row.read_at === "string"
          ? row.read_at
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listNotificationsForUser(userId: string): NotificationRecord[] {
  if (!userId) return [];
  const host = getNotificationsHostAdapters();
  const __tEnsure = notifPerfNow();
  host.ensurePostgresSchema();
  notifPerf("service.ensurePostgresSchema", __tEnsure);
  const __tQuery = notifPerfNow();
  const [result] = host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, dedupe_key, created_at, read_at
          FROM ${schemaQualified("notifications")}
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        values: [userId, NOTIFICATIONS_PER_USER_LIMIT],
      },
    ],
  });
  notifPerf("service.query", __tQuery);
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  notifPerfNote("service.rows", rows.length);
  const __tMap = notifPerfNow();
  const out = rows
    .map(rowToRecord)
    .filter((r): r is NotificationRecord => Boolean(r));
  notifPerf("service.map", __tMap);
  return out;
}

/**
 * List EVERY notification for a user whose `dedupe_key` starts with a given
 * prefix — UNCAPPED (no 200-newest window) so a caller reconciling an
 * auto-managed, keyed notification family (e.g. the agent configuration-needs
 * entries, dedupeKey `agent-config-needs:<pkg>`) always sees the COMPLETE set,
 * even for a user with thousands of older notifications. Without this the paged
 * `listNotificationsForUser` could hide a stale entry past the window, so it
 * would never be cleared when its condition resolves.
 *
 * The prefix is matched with `LIKE $2 || '%'`; callers pass a literal,
 * wildcard-free prefix (the `_`/`%` LIKE metacharacters are not escaped here).
 */
export function listNotificationsByDedupeKeyPrefixForUser(args: {
  userId: string;
  dedupeKeyPrefix: string;
}): NotificationRecord[] {
  if (!args.userId || !args.dedupeKeyPrefix) return [];
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  const [result] = host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, dedupe_key, created_at, read_at
          FROM ${schemaQualified("notifications")}
          WHERE user_id = $1
            AND dedupe_key IS NOT NULL
            AND dedupe_key LIKE $2
          ORDER BY created_at DESC`,
        values: [args.userId, `${args.dedupeKeyPrefix}%`],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows
    .map(rowToRecord)
    .filter((r): r is NotificationRecord => Boolean(r));
}

/**
 * Keyset ("seek") boundary for {@link listNotificationsKeysetForUser}. The feed
 * is ordered `created_at DESC, id DESC`; a boundary selects the rows that come
 * strictly AFTER a cursor position in that order.
 *
 * Three modes exist because the notifications stream is merged with a SECOND
 * stream (the read-time-federated pending approvals) into one chronological
 * `/notifications` feed (cinatra#1555). The union orders by MILLISECOND-epoch
 * (a canonical UTC ms ISO cursor), while `created_at` is stored at microsecond
 * precision — so every bound truncates the column to milliseconds
 * (`date_trunc('milliseconds', created_at)`) to agree with the union comparator,
 * with an index-usable `created_at < (createdAt + 1ms)` range narrowing the
 * scan. When the cursor lands in the OTHER stream, the equal-instant
 * notification rows relate to it wholesale (all after, or all before):
 *
 *   - `row`               — cursor IS a notification: strict ms tuple
 *                           `(date_trunc('ms',created_at), id) < (createdAt, id)`.
 *   - `createdAtInclusive`— cursor is an approval that sorts BEFORE notifications
 *                           at its instant (its `sourceKey` < the notification
 *                           sourceKey), so EVERY notification in that millisecond
 *                           is still ahead: `created_at < createdAt + 1ms`.
 *   - `createdAtExclusive`— cursor is an approval that sorts AFTER notifications
 *                           at its instant, so none in that millisecond remain:
 *                           `created_at < createdAt`.
 *
 * All three are index-friendly against `notifications_user_created_id_idx`
 * (`(user_id, created_at DESC, id DESC)`): the `created_at < …` range uses the
 * index, and the ms-truncated ORDER BY resolves via an incremental sort over
 * the already-ordered scan.
 */
export type NotificationsKeysetBefore =
  | { boundary: "row"; createdAt: string; id: string }
  | { boundary: "createdAtInclusive"; createdAt: string }
  | { boundary: "createdAtExclusive"; createdAt: string };

/**
 * Keyset-paginated read of a user's notifications, newest first
 * (`created_at DESC, id DESC`), for the unified `/notifications` feed
 * (cinatra#1555). Unlike {@link listNotificationsForUser} — which returns the
 * fixed 200-newest window with NO cursor — this walks the full history a page at
 * a time via a stable seek boundary, so a merge with the pending-approval stream
 * never dups or skips at a page edge. `limit` is clamped to
 * `[1, NOTIFICATIONS_PER_USER_LIMIT]`. Backed by `notifications_user_created_id_idx`.
 */
export function listNotificationsKeysetForUser(args: {
  userId: string;
  limit: number;
  before?: NotificationsKeysetBefore;
}): NotificationRecord[] {
  if (!args.userId) return [];
  const limit = Math.min(
    Math.max(Math.trunc(args.limit) || 0, 1),
    NOTIFICATIONS_PER_USER_LIMIT,
  );
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();

  const where: string[] = ["user_id = $1"];
  const values: unknown[] = [args.userId];
  const before = args.before;
  if (before) {
    // `values.push` returns the new length, i.e. the 1-based param index.
    const c = values.push(before.createdAt);
    if (before.boundary === "row") {
      const cid = values.push(before.id);
      where.push(
        `created_at < ($${c}::timestamptz + interval '1 millisecond') ` +
          `AND (date_trunc('milliseconds', created_at), id) < ($${c}::timestamptz, $${cid}::text)`,
      );
    } else if (before.boundary === "createdAtInclusive") {
      where.push(`created_at < ($${c}::timestamptz + interval '1 millisecond')`);
    } else {
      where.push(`created_at < $${c}::timestamptz`);
    }
  }
  values.push(limit);

  const [result] = host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, dedupe_key, created_at, read_at
          FROM ${schemaQualified("notifications")}
          WHERE ${where.join(" AND ")}
          ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
          LIMIT $${values.length}`,
        values,
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows
    .map(rowToRecord)
    .filter((r): r is NotificationRecord => Boolean(r));
}

export function countUnreadForUser(userId: string): number {
  if (!userId) return 0;
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  const [result] = host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT COUNT(*)::int AS n FROM ${schemaQualified("notifications")} WHERE user_id = $1 AND read_at IS NULL`,
        values: [userId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Opt-in flags for `createNotificationForRecipient`.
 *
 * `autoMarkRead` — set `read_at = now()` inside the INSERT so the
 * notification arrives pre-read to the SSE flyout listener. Used by
 * `createBackgroundProgressNotification` to keep the bell badge focused
 * on terminals (success/error/warning) while still putting the running
 * row in the In-progress tab. The LISTEN/NOTIFY trigger fires AFTER
 * INSERT so the SSE payload includes the read state from the start —
 * the alternative (`UPDATE … SET read_at = now()` post-INSERT) would
 * not reach open tabs because the trigger has no AFTER UPDATE handler
 * (see the host's `src/lib/drizzle-store.ts:573`).
 */
export type CreateNotificationOptions = {
  autoMarkRead?: boolean;
};

/**
 * Create one notification row per recipient user.
 *
 * Recipient expansion happens at write time: an `admins` recipient becomes
 * one row per platform admin; a `team` recipient becomes one row per team
 * member, etc. The partial unique index on (user_id, source_job_id, kind)
 * dedupes retries when `sourceJobId` is provided.
 */
export async function createNotificationForRecipient(
  recipient: NotificationRecipient,
  input: NotificationInput,
  options: CreateNotificationOptions = {},
): Promise<NotificationRecord[]> {
  const userIds = await resolveRecipientToUserIds(recipient);
  if (userIds.length === 0) return [];
  getNotificationsHostAdapters().ensurePostgresSchema();
  const topic = topicForRecipient(recipient);
  const created: NotificationRecord[] = [];
  for (const userId of userIds) {
    const row = insertNotificationRowForUser({
      userId,
      recipient,
      topic,
      input,
      options,
    });
    if (row) created.push(row);
  }
  return created;
}

function insertNotificationRowForUser(args: {
  userId: string;
  recipient: NotificationRecipient;
  topic: string;
  input: NotificationInput;
  options: CreateNotificationOptions;
}): NotificationRecord | null {
  const id = randomUUID();
  const kind = normalizeKind(args.input.kind);
  const recipientKind = args.recipient.kind;
  const recipientId =
    args.recipient.kind === "team"
      ? args.recipient.teamId
      : args.recipient.kind === "organization"
        ? args.recipient.organizationId
        : args.recipient.kind === "user"
          ? args.recipient.userId
          : null;

  // `auto-mark-read` renders as `read_at = now()` inline; otherwise
  // the column defaults to NULL (unread). This keeps it to one INSERT — no
  // follow-up UPDATE — so the LISTEN/NOTIFY trigger fires once with the
  // correct read state and the SSE flyout sees the row in its final shape.
  const readAtSql = args.options.autoMarkRead ? "now()" : "NULL";

  // General dedupe key (issue #50). Blank/whitespace keys normalize to NULL —
  // an empty string must never become a real unique key for the user.
  const dedupeKey = args.input.dedupeKey?.trim() || null;

  // Postgres accepts exactly ONE conflict target per INSERT, so the dedupe
  // arbiter is chosen per row: a `dedupeKey` row arbitrates on the general
  // `(user_id, dedupe_key)` partial unique index; otherwise the legacy
  // job-lifecycle `(user_id, source_job_id, kind)` index applies. A caller
  // that sets `dedupeKey` therefore must NOT also rely on the job index for
  // the same row (a same-(user, job, kind) re-insert with a DIFFERENT
  // dedupeKey would raise instead of no-op). Both partial unique indexes are
  // created in the host's drizzle-store.ts.
  const conflictSql = dedupeKey
    ? `ON CONFLICT (user_id, dedupe_key)
            WHERE dedupe_key IS NOT NULL AND user_id IS NOT NULL
            DO NOTHING`
    : `ON CONFLICT (user_id, source_job_id, kind)
            WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
            DO NOTHING`;

  const host = getNotificationsHostAdapters();
  const [result] = host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO ${schemaQualified("notifications")}
          (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, dedupe_key, created_at, read_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), ${readAtSql})
          ${conflictSql}
          RETURNING id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, dedupe_key, created_at, read_at`,
        values: [
          id,
          args.userId,
          recipientKind,
          recipientId,
          args.topic,
          kind,
          args.input.title,
          args.input.body ?? "",
          args.input.href ?? null,
          args.input.metadata ? JSON.stringify(args.input.metadata) : null,
          args.input.sourceJobId ?? null,
          args.input.sourceJobName ?? null,
          dedupeKey,
        ],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Background-process progress helper.
//
// Inserts a single `info`-kind notification row marking a BullMQ job as
// running. The worker.on("active") hook in src/lib/background-jobs.ts is the
// sole caller. `kind: "info"` distinguishes the running row from terminal
// success/error rows so the partial unique index `(user_id, source_job_id, kind)`
// admits one row per phase. The flyout's `collapseByJobId` helper merges the
// running row with its eventual terminal row by `source_job_id`.
//
// `autoMarkRead: true` keeps the bell badge counting terminals only — the
// spinner in the In-progress tab is the user-visible indicator for running
// jobs, not the bell badge.
// ---------------------------------------------------------------------------
export async function createBackgroundProgressNotification(args: {
  recipient: NotificationRecipient;
  jobId: string;
  jobName: string;
  title: string;
  body?: string;
  // Optional deep-link to the agent run. Pure additive optional field;
  // when undefined, behavior is byte-identical
  // (insertNotificationRowForUser already does `args.input.href ?? null`).
  href?: string;
}): Promise<NotificationRecord[]> {
  return createNotificationForRecipient(
    args.recipient,
    {
      title: args.title,
      body: args.body ?? "Started.",
      kind: "info",
      href: args.href,
      sourceJobId: args.jobId,
      sourceJobName: args.jobName,
      metadata: {
        category: "background_process",
        progress: {
          status: "running",
          startedAt: new Date().toISOString(),
          jobId: args.jobId,
          jobName: args.jobName,
        },
      },
    },
    { autoMarkRead: true },
  );
}

// ---------------------------------------------------------------------------
// Read-state mutations (always scoped to the calling user)
// ---------------------------------------------------------------------------

export function markNotificationReadForUser(args: {
  userId: string;
  notificationId: string;
}): void {
  if (!args.userId || !args.notificationId) return;
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE ${schemaQualified("notifications")}
          SET read_at = COALESCE(read_at, now())
          WHERE user_id = $1 AND id = $2`,
        values: [args.userId, args.notificationId],
      },
    ],
  });
}

export function markNotificationsReadByHrefPrefixForUser(args: {
  userId: string;
  hrefPrefix: string;
}): void {
  if (!args.userId || !args.hrefPrefix) return;
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  const prefixWithSlash = `${args.hrefPrefix}/`;
  host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE ${schemaQualified("notifications")}
          SET read_at = COALESCE(read_at, now())
          WHERE user_id = $1
            AND href IS NOT NULL
            AND (href = $2 OR href LIKE $3)`,
        values: [args.userId, args.hrefPrefix, `${prefixWithSlash}%`],
      },
    ],
  });
}

/**
 * Delete every notification row for a user carrying an EXACT `dedupe_key`.
 *
 * Unlike the read-state mutations above, this HARD-REMOVES the row. It exists
 * for auto-managed live-reminder notifications (the agent configuration-needs
 * entry, cinatra #1057 ruling (c)) whose meaning expires the moment the
 * underlying condition resolves — an agent that becomes runnable has no
 * "set up connections" reminder to keep, and its entry must vanish from every
 * tab, not merely dim. Deleting (rather than marking read) also frees the
 * `(user_id, dedupe_key)` slot so a later re-gating of the same agent inserts
 * a fresh UNREAD entry instead of colliding with a stale read row via the
 * partial unique index. Scoped to the exact key so it can never touch an
 * unrelated notification.
 */
export function deleteNotificationsByDedupeKeyForUser(args: {
  userId: string;
  dedupeKey: string;
}): void {
  if (!args.userId || !args.dedupeKey) return;
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `DELETE FROM ${schemaQualified("notifications")}
          WHERE user_id = $1 AND dedupe_key = $2`,
        values: [args.userId, args.dedupeKey],
      },
    ],
  });
}

export function markAllNotificationsReadForUser(userId: string): void {
  if (!userId) return;
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE ${schemaQualified("notifications")}
          SET read_at = COALESCE(read_at, now())
          WHERE user_id = $1 AND read_at IS NULL`,
        values: [userId],
      },
    ],
  });
}

/**
 * Mark read every UNREAD notification for a user THROUGH (up to and including) a
 * boundary row — the newest-LOADED notification on the /notifications v2 feed,
 * identified by its `id`. Unlike {@link markAllNotificationsReadForUser}, the
 * UPDATE is bounded to the loaded watermark, so a notification created AFTER the
 * boundary — e.g. inserted CONCURRENTLY between the feed's page load and this
 * PATCH — is never marked read despite never being loaded. On reload it re-syncs
 * as genuinely unread. This closes the mark-all-read read-state race for the v2
 * surface (cinatra#1557); the blanket flyout path keeps its own all-rows
 * semantics.
 *
 * The boundary is passed as an `id`, NOT a timestamp, and resolved to its
 * FULL-precision `created_at` inside the statement by joining the boundary row.
 * This is deliberate: `created_at` is stored at microsecond precision, but the
 * client only ever sees it ms-truncated (via `.toISOString()`). A ms-granular
 * timestamp watermark cannot distinguish the boundary row from a DIFFERENT row
 * inserted later within the SAME millisecond, so such a concurrent insert would
 * be wrongly marked read.
 *
 * The predicate is `n.created_at < b.created_at OR n.id = b.id` — mark read every
 * row STRICTLY older than the boundary, PLUS the boundary row itself. It does NOT
 * tie-break simultaneous rows by `id`: notification ids are random UUIDs, so a
 * row inserted at the EXACT same microsecond as the boundary but never loaded
 * could have a UUID that sorts below the boundary's and would be wrongly included
 * by a `(created_at, id) <= (…)` tuple. Requiring `created_at` to be STRICTLY
 * less (or the row to BE the boundary) means no non-boundary row sharing or
 * exceeding the boundary's microsecond is ever marked read — closing the race for
 * any concurrent insert regardless of UUID ordering. The only rows this leaves
 * unmarked that the optimistic client overlay marked read are loaded rows sharing
 * the boundary's exact microsecond (vanishingly rare, and genuinely ambiguous in
 * order); they self-heal to the server's authoritative `readAt` on reload.
 *
 * Both `n` and `b` are scoped to `user_id = $1`, so the boundary can never be
 * another user's row and no cross-user row is ever touched. A boundary `id` that
 * is unknown / not owned by the caller yields zero join rows → zero rows updated
 * (fail-CLOSED: never widens to a blanket update). Index-supported by
 * `(user_id, created_at DESC, id DESC)` (drizzle-store.ts).
 */
export function markNotificationsReadThroughForUser(args: {
  userId: string;
  boundaryId: string;
}): void {
  if (!args.userId || !args.boundaryId) return;
  const table = schemaQualified("notifications");
  const host = getNotificationsHostAdapters();
  host.ensurePostgresSchema();
  host.runPostgresQueriesSync({
    connectionString: host.getPostgresConnectionString(),
    queries: [
      {
        // `UPDATE ... FROM b` joins the boundary row (b.id is the PK → 0 or 1
        // row) and reads its full-precision `created_at`. Strictly-older rows
        // plus the boundary row itself are marked read; a row at/after the
        // boundary's microsecond (a concurrent insert) is excluded regardless of
        // its random UUID.
        text: `UPDATE ${table} AS n
          SET read_at = COALESCE(n.read_at, now())
          FROM ${table} AS b
          WHERE b.id = $2
            AND b.user_id = $1
            AND n.user_id = $1
            AND n.read_at IS NULL
            AND (n.created_at < b.created_at OR n.id = b.id)`,
        values: [args.userId, args.boundaryId],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Agent-creation progress event log — one row per (run, milestone).
//
// Each DISTINCT milestone is a NEW INSERT row in cinatra.notifications. The
// `(user_id, source_job_id, kind)` partial unique index would collapse
// repeated emits when source_job_id is the runId, so we use a per-event
// `randomUUID()` for source_job_id and put the grouping identity in
// `metadata.progress.runId`. The renderer in inline-agent-run-card.tsx
// filters by metadata.category + metadata.progress.runId (NOT
// sourceJobId), so milestones display as an ordered timeline.
//
// Idempotency lives on the general `dedupe_key` instead (issue #50):
// `agent-creation-progress:<runId>:<milestone>` collapses a re-emit of the
// SAME milestone for the same run while keeping one row per milestone.
//
// All emits are `kind: "info"` + `autoMarkRead: true` — the bell badge
// stays focused on terminal `success`/`error` rows from
// `notifyJobLifecycle`. The user-visible timeline lives inside the
// inline run card; no flyout chrome change is needed.
//
// INVARIANTS:
//   - kind is ALWAYS "info" (never promoted to success/error).
//   - metadata.category is ALWAYS "agent_creation_progress" (never
//     drifts to "background_process").
//   - source_job_id is ALWAYS a fresh UUID per emit (never the runId).
//   - dedupe_key is ALWAYS `agent-creation-progress:<runId>:<milestone>`
//     so the timeline is ONE ROW PER MILESTONE PER RUN, not one row per
//     emit. Re-emits of the same milestone for the same run (the
//     agent_source_write + agent_source_write_files pair both emitting
//     "writing_files", review re-invocations re-emitting the review
//     milestones, the dispatch-side + review-side "syncing_skills" pair)
//     collapse via ON CONFLICT DO NOTHING instead of rendering the same
//     notification twice in the flyout (issue #50). DIFFERENT milestones
//     of one run never collapse (the milestone is part of the key).
//   - recipient is server-derived from actor.principalId (never
//     caller-controlled — see callers).
// ---------------------------------------------------------------------------

export type AgentCreationProgressMilestone =
  | "queued"
  | "syncing_skills"
  | "planner_running"
  | "code_review_running"
  | "security_review_running"
  | "validating"
  | "writing_files"
  | "review_started"
  | "review_done";

const MILESTONE_TITLES: Record<AgentCreationProgressMilestone, string> = {
  queued: "Queued",
  syncing_skills: "Syncing skills",
  planner_running: "Planner running",
  code_review_running: "Code review running",
  security_review_running: "Security review running",
  validating: "Validating",
  writing_files: "Writing files",
  review_started: "Review started",
  review_done: "Review done",
};

export type EmitAgentCreationProgressArgs = {
  recipient: NotificationRecipient;
  runId: string;
  packageName: string;
  milestone: AgentCreationProgressMilestone;
  body?: string;
  href?: string;
};

export async function emitAgentCreationProgress(
  args: EmitAgentCreationProgressArgs,
): Promise<NotificationRecord[]> {
  const href = args.href ?? buildAgentInstancePath(args.packageName, args.runId);
  return createNotificationForRecipient(
    args.recipient,
    {
      title: MILESTONE_TITLES[args.milestone] ?? args.milestone,
      body: args.body ?? "",
      kind: "info",
      href,
      // Per-event UUID — defeats the partial unique idx collapse on
      // (user_id, source_job_id, kind). The runId lives in metadata.progress.runId.
      sourceJobId: randomUUID(),
      sourceJobName: "agent-creation-progress",
      // Stable per-(run, milestone) key: the SAME milestone emitted more
      // than once for one run (double writers / review re-runs) collapses
      // to one row; different milestones keep their own rows (issue #50).
      dedupeKey: `agent-creation-progress:${args.runId}:${args.milestone}`,
      metadata: {
        category: "agent_creation_progress",
        progress: {
          status: "running" as const,
          runId: args.runId,
          packageName: args.packageName,
          milestone: args.milestone,
          ts: new Date().toISOString(),
        },
      },
    },
    { autoMarkRead: true },
  );
}

/**
 * Fire-and-forget wrapper — swallows + logs any rejection so a
 * notification write failure never blocks the creation flow.
 *
 * Always use this from a code path that must not throw (chat
 * dispatch, MCP handlers).
 */
export async function safeEmitAgentCreationProgress(
  args: EmitAgentCreationProgressArgs,
): Promise<void> {
  try {
    await emitAgentCreationProgress(args);
  } catch (err) {
    console.warn(
      "[notifications] safeEmitAgentCreationProgress swallowed error:",
      err instanceof Error ? err.message : err,
    );
  }
}
