/**
 * Direct-pg seeders for the unified /notifications v2 conformance UAT
 * (cinatra#1561, E11 of the #1549 approvals-into-notifications epic).
 *
 * The E7 `/notifications` surface merge-sorts TWO disjoint queues (E5 data
 * layer): the per-user Postgres `notifications` table AND the read-time-federated
 * `ApprovalSource` registry. Neither queue is writable from a Playwright request
 * context (notifications are worker-written; approvals are not materialized as
 * rows). So this kit seeds BOTH substrates directly via pg — the same pattern the
 * retired flyout UAT used for notifications, extended to the local agent-creation
 * approval source so the suite can prove eligibility, interleave, and the decide
 * round-trip on the real production build.
 *
 * ── What is planted ─────────────────────────────────────────────────────────
 * NOTIFICATIONS (`<schema>.notifications`, one row per user) — 6 rows for the
 * test user, deterministic ids (prefix `notif-uat-`), distinct `source_job_id`
 * per row (so nothing collapses), staggered `created_at` so approvals interleave
 * BETWEEN notifications in the newest-first list:
 *   - `ok-1`      success, READ           (T-8m) — the "already read" control
 *   - `ok-2`      success, UNREAD         (T-7m)
 *   - `running-1` info,    RUNNING/auto-read (T-6m) — the In-progress row
 *   - `warn-1`    warning, UNREAD         (T-5m)
 *   - `err-1`     error,   UNREAD         (T-3m) — drives the destructive badge
 *   - `e9-1`      warning, UNREAD, href   (T-1m) — the E9 run-awaiting-human row
 *                 (`metadata.category = run_awaiting_human`), the newest row.
 * ⇒ Unread terminal notifications = ok-2, warn-1, err-1, e9-1 = 4.
 *   In-progress = running-1 = 1.
 *
 * APPROVALS (`<schema>.agent_creation_request`, read-time-federated by the agent
 * source) — 2 pending proposals in the viewer's ACTIVE org, deterministic ids
 * (prefix `acr-uat-`):
 *   - `inbox-1` authored by SOMEONE ELSE → the admin viewer's Inbox row: §II
 *     ACTIONABLE ("Awaiting you" + inline Approve/Reject). Feeds the Needs-action
 *     chip (=1) and the bell's actionable-approvals contribution (=1).
 *   - `mine-1`  authored by the VIEWER → a "Your requests" row: §II NON-actionable
 *     in the unified feed ("Awaiting others" + "no action for you"; a mine-
 *     direction row is never actionable here regardless of self-approval rights).
 * Both carry a known `snapshot_hash` = the row's CAS `version`, so the reject
 * round-trip's edit-after-view guard matches the seeded token.
 *
 * Idempotent: every seeder deletes its own deterministic-prefix rows first.
 */
import { Pool } from "pg";

export type SeedOptions = {
  readonly email: string;
  readonly databaseUrl: string;
  readonly schema: string;
};

export type NotificationsSeedResult = {
  readonly userId: string;
  readonly terminalCount: number;
  readonly runningCount: number;
  readonly unreadTerminalCount: number;
};

export type ApprovalsSeedResult = {
  readonly orgId: string;
  readonly inboxActionableCount: number;
  readonly mineCount: number;
  /** The seeded Inbox row id + its CAS token — the decide spec rejects it. */
  readonly inboxRowId: string;
  readonly inboxSnapshotHash: string;
  readonly inboxTitle: string;
  readonly mineTitle: string;
};

const NOTIF_PREFIX = "notif-uat-";
const APPROVAL_PREFIX = "acr-uat-";

/** The E9 run-awaiting-human run id (also the notification's deep-link target). */
export const E9_RUN_ID = "RUN-E9-UAT";
export const E9_HREF = `/agents/acme/sales/${E9_RUN_ID}`;

/** Human titles carried on the proposal snapshots (oas.name → the row title). */
const INBOX_APPROVAL_TITLE = "Quarterly Revenue Analyst";
const MINE_APPROVAL_TITLE = "Personal Inbox Triage Bot";

/** A synthetic "other author" for the Inbox row. The agent source filters
 *  `authorId !== viewer.userId` (no user-table JOIN), and the notifications
 *  table has no FK on `user_id`, so a synthetic id is safe: it surfaces the row
 *  as someone-else's Inbox work and the reject's best-effort author notification
 *  writes a harmless orphan row. */
const OTHER_AUTHOR_ID = "notif-uat-inbox-author";

type TerminalFixture = {
  suffix: string;
  kind: "success" | "error" | "warning";
  title: string;
  body: string;
  read: boolean;
  /** minutes before now for created_at (bigger = older). */
  ageMinutes: number;
};

const TERMINAL_FIXTURES: readonly TerminalFixture[] = [
  { suffix: "ok-1", kind: "success", title: "Blog Post Draft Generation completed", body: "Background job finished.", read: true, ageMinutes: 8 },
  { suffix: "ok-2", kind: "success", title: "Skill Prefill Generation completed", body: "Background job finished.", read: false, ageMinutes: 7 },
  { suffix: "warn-1", kind: "warning", title: "Skill Match Drift Sample completed with warnings", body: "Threshold drift detected.", read: false, ageMinutes: 5 },
  { suffix: "err-1", kind: "error", title: "Blog Post Idea Generation failed", body: "LLM responded with malformed JSON.", read: false, ageMinutes: 3 },
];

async function userIdByEmail(pool: Pool, email: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
    [email],
  );
  if (row.rows.length === 0) {
    throw new Error(`seed: user not found for ${email} — run auth.setup.ts first`);
  }
  return row.rows[0]!.id;
}

/**
 * Seed the notification substrate: the mixed-kind terminal set, the in-progress
 * row, and the E9 run-awaiting-human actionable notification.
 */
export async function seedNotificationFixtures(
  opts: SeedOptions,
): Promise<NotificationsSeedResult> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    const userId = await userIdByEmail(pool, opts.email);

    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [userId, `${NOTIF_PREFIX}%`],
    );

    let unreadTerminals = 0;
    for (const f of TERMINAL_FIXTURES) {
      const id = `${NOTIF_PREFIX}${f.suffix}`;
      const jobId = `job-${f.suffix}`;
      const readAt = f.read ? "now() - interval '1 hour'" : "NULL";
      if (!f.read) unreadTerminals += 1;
      await pool.query(
        `INSERT INTO ${schema}.notifications
          (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
          VALUES ($1, $2, 'user', $2, 'user:' || $2, $3, $4, $5, NULL, NULL, $6, $7, now() - ($8 || ' minutes')::interval, ${readAt})
          ON CONFLICT (user_id, source_job_id, kind)
            WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
            DO NOTHING`,
        [id, userId, f.kind, f.title, f.body, jobId, "blog-post-idea-generation", String(f.ageMinutes)],
      );
    }

    // The In-progress row (background_process/running; auto-read at INSERT).
    const runningMetadata = JSON.stringify({
      category: "background_process",
      progress: {
        status: "running",
        jobId: "job-running-1",
        jobName: "blog-post-draft-generation",
        startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
    });
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'info', $3, $4, NULL, $5::jsonb, $6, $7, now() - interval '6 minutes', now())
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        `${NOTIF_PREFIX}running-1`,
        userId,
        "Blog Post Draft Generation in progress",
        "Started.",
        runningMetadata,
        "job-running-1",
        "blog-post-draft-generation",
      ],
    );

    // The E9 run-awaiting-human actionable notification (cinatra#1559): a
    // standard AppNotification carrying `category: run_awaiting_human` + an href
    // to the run's approval surface. It is the NEWEST row so it also anchors the
    // mark-all watermark. It counts under Unread + All (a notification row) but
    // NEVER the Needs-action chip (that is approval-only, by E7 design).
    const e9Metadata = JSON.stringify({
      category: "run_awaiting_human",
      runAwaitingHuman: { runId: E9_RUN_ID, reason: "pending_approval" },
    });
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'warning', $3, $4, $5, $6::jsonb, $7, $8, now() - interval '1 minute', NULL)
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        `${NOTIF_PREFIX}e9-1`,
        userId,
        `"Nightly sync" is awaiting your approval`,
        "Open the run to review and approve the pending step.",
        E9_HREF,
        e9Metadata,
        "job-e9-run-await",
        "nightly-sync",
      ],
    );
    unreadTerminals += 1; // the e9 row is unread

    return {
      userId,
      terminalCount: TERMINAL_FIXTURES.length + 1, // + the e9 terminal row
      runningCount: 1,
      unreadTerminalCount: unreadTerminals,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Seed the approval substrate: two pending agent-creation proposals in `orgId`
 * — one authored by someone else (the admin viewer's ACTIONABLE Inbox row) and
 * one authored by the viewer (a NON-actionable "Your requests" row).
 */
export async function seedApprovalFixtures(opts: {
  databaseUrl: string;
  schema: string;
  orgId: string;
  viewerUserId: string;
}): Promise<ApprovalsSeedResult> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    await pool.query(
      `DELETE FROM ${schema}.agent_creation_request WHERE org_id = $1 AND id LIKE $2`,
      [opts.orgId, `${APPROVAL_PREFIX}%`],
    );

    const insert = async (row: {
      id: string;
      authorId: string;
      title: string;
      slug: string;
      snapshotHash: string;
      ageMinutes: number;
    }) => {
      const snapshot = JSON.stringify({
        oas: { name: row.title, info: { title: row.title } },
        packageJson: { name: `@acme/${row.slug}`, displayName: row.title },
        skillMd: null,
      });
      await pool.query(
        `INSERT INTO ${schema}.agent_creation_request
          (id, org_id, author_id, package_slug, package_name, package_version, status,
           proposal_snapshot, snapshot_hash, resolved_approver_ids, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, '1.0.0', 'proposed', $6::jsonb, $7, NULL,
                  now() - ($8 || ' minutes')::interval, now() - ($8 || ' minutes')::interval)
          ON CONFLICT (id) DO NOTHING`,
        [row.id, opts.orgId, row.authorId, row.slug, `@acme/${row.slug}`, snapshot, row.snapshotHash, String(row.ageMinutes)],
      );
    };

    const inboxRowId = `${APPROVAL_PREFIX}inbox-1`;
    const inboxSnapshotHash = "acr-uat-inbox-snap-hash-1";
    await insert({
      id: inboxRowId,
      authorId: OTHER_AUTHOR_ID, // someone else → the admin viewer's Inbox
      title: INBOX_APPROVAL_TITLE,
      slug: "quarterly-revenue-analyst",
      snapshotHash: inboxSnapshotHash,
      ageMinutes: 2, // interleaves between err-1 (T-3m) and e9-1 (T-1m)
    });
    await insert({
      id: `${APPROVAL_PREFIX}mine-1`,
      authorId: opts.viewerUserId, // the viewer's own request
      title: MINE_APPROVAL_TITLE,
      slug: "personal-inbox-triage-bot",
      snapshotHash: "acr-uat-mine-snap-hash-1",
      ageMinutes: 4, // interleaves between warn-1 (T-5m) and err-1 (T-3m)
    });

    return {
      orgId: opts.orgId,
      inboxActionableCount: 1,
      mineCount: 1,
      inboxRowId,
      inboxSnapshotHash,
      inboxTitle: INBOX_APPROVAL_TITLE,
      mineTitle: MINE_APPROVAL_TITLE,
    };
  } finally {
    await pool.end();
  }
}

export async function cleanupNotificationFixtures(opts: SeedOptions): Promise<void> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [opts.email],
    );
    if (row.rows.length === 0) return;
    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [row.rows[0]!.id, `${NOTIF_PREFIX}%`],
    );
  } finally {
    await pool.end();
  }
}

export async function cleanupApprovalFixtures(opts: {
  databaseUrl: string;
  schema: string;
  orgId: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    await pool.query(
      `DELETE FROM ${schema}.agent_creation_request WHERE org_id = $1 AND id LIKE $2`,
      [opts.orgId, `${APPROVAL_PREFIX}%`],
    );
  } finally {
    await pool.end();
  }
}
