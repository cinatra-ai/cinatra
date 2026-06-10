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
// One row per (user, notification). Topic/admin/team/org/project recipients
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
        : args.recipient.kind === "project"
          ? args.recipient.projectId
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
