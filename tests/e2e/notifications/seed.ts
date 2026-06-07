/**
 * Direct-pg seeders for the notifications UAT.
 *
 * The /api/notifications surface is read-only for new rows (it only
 * exposes PATCH for read-state mutations). The write path
 * happens via the BullMQ worker hooks + the
 * `createNotificationForRecipient` server-only helper. Neither is
 * reachable from a Playwright test request context.
 *
 * So: seed directly via pg. Pattern mirrors
 * `tests/e2e/dashboards/seed-data.ts` — single Pool, schema-quoted
 * INSERT, idempotent via ON CONFLICT DO NOTHING.
 *
 * Layout produced by `seedNotificationFixtures`:
 *   12 terminal rows for the test user, mixed kinds (8 success / 3 error
 *   / 1 warning), 1/3 already read. All carry a `sourceJobId` so they
 *   are NOT collapsed away (different `sourceJobId` per row).
 *   1 running info-kind row with `metadata.progress.status = "running"`,
 *   `read_at = now()` (auto-read at INSERT).
 *
 * Total: 13 rows.
 *   - All tab: 13 (collapse doesn't merge anything because no two rows
 *     share a sourceJobId).
 *   - Unread tab: 8 unread terminals (running is auto-read; unread
 *     terminals = 12 - 4 read = 8).
 *   - In progress tab: 1 running row.
 *
 * `cleanupNotificationFixtures` deletes every notification row written
 * by this helper (matches the deterministic id prefix). Run as a
 * fixture afterEach if the spec mutates beyond what setup planted.
 */
import { Pool } from "pg";

export type NotificationsSeedOptions = {
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

const FIXTURE_ID_PREFIX = "notif-uat-";
const RUNNING_FIXTURE_ID = `${FIXTURE_ID_PREFIX}running-1`;

const TERMINAL_FIXTURES = [
  { suffix: "ok-1", kind: "success", title: "Blog Post Idea Generation completed", body: "Background job finished.", read: true },
  { suffix: "ok-2", kind: "success", title: "Skill Match Inline For Skill completed", body: "Background job finished.", read: true },
  { suffix: "ok-3", kind: "success", title: "Blog Post Draft Generation completed", body: "Background job finished.", read: true },
  { suffix: "ok-4", kind: "success", title: "Blog Post Wordpress Draft Creation completed", body: "Background job finished.", read: true },
  { suffix: "ok-5", kind: "success", title: "Blog Post Image Regeneration completed", body: "Background job finished.", read: false },
  { suffix: "ok-6", kind: "success", title: "Skill Prefill Generation completed", body: "Background job finished.", read: false },
  { suffix: "ok-7", kind: "success", title: "Blog Post Linkedin Draft Creation completed", body: "Background job finished.", read: false },
  { suffix: "ok-8", kind: "success", title: "Blog Post Linkedin Draft Publish completed", body: "Background job finished.", read: false },
  { suffix: "err-1", kind: "error", title: "Blog Post Idea Generation failed", body: "LLM responded with malformed JSON.", read: false },
  { suffix: "err-2", kind: "error", title: "Agent Builder Execution failed", body: "Connection refused.", read: false },
  { suffix: "err-3", kind: "error", title: "Skill Match Inline For Agent failed", body: "Timeout after 30s.", read: false },
  { suffix: "warn-1", kind: "warning", title: "Skill Match Drift Sample completed with warnings", body: "Threshold drift detected.", read: false },
] as const;

export async function seedNotificationFixtures(
  opts: NotificationsSeedOptions,
): Promise<NotificationsSeedResult> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    // Resolve userId via Better Auth's public.user table (test creds).
    const userRow = await pool.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [opts.email],
    );
    if (userRow.rows.length === 0) {
      throw new Error(
        `seedNotificationFixtures: user not found for ${opts.email} — run auth.setup.ts first`,
      );
    }
    const userId = userRow.rows[0]!.id;

    // Wipe any previous fixture rows for idempotence (the partial
    // unique idx on `(user_id, source_job_id, kind)` would otherwise
    // ON CONFLICT DO NOTHING and leave stale rows from a prior run).
    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [userId, `${FIXTURE_ID_PREFIX}%`],
    );

    // Insert terminal fixtures with deterministic source_job_ids.
    let unreadTerminals = 0;
    for (const fixture of TERMINAL_FIXTURES) {
      const id = `${FIXTURE_ID_PREFIX}${fixture.suffix}`;
      const jobId = `job-${fixture.suffix}`;
      const jobName = "blog-post-idea-generation"; // any user-init name works
      const readAt = fixture.read
        ? "now() - interval '1 hour'"
        : "NULL";
      if (!fixture.read) unreadTerminals += 1;
      await pool.query(
        `INSERT INTO ${schema}.notifications
          (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
          VALUES ($1, $2, 'user', $2, 'user:' || $2, $3, $4, $5, NULL, NULL, $6, $7, now() - interval '5 minutes', ${readAt})
          ON CONFLICT (user_id, source_job_id, kind)
            WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
            DO NOTHING`,
        [id, userId, fixture.kind, fixture.title, fixture.body, jobId, jobName],
      );
    }

    // Insert ONE running info-kind row (no terminal counterpart, so it
    // shows up in the In progress tab).
    const runningMetadata = JSON.stringify({
      category: "background_process",
      progress: {
        status: "running",
        jobId: "job-running-1",
        jobName: "blog-post-draft-generation",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'info', $3, $4, NULL, $5::jsonb, $6, $7, now() - interval '1 minute', now())
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        RUNNING_FIXTURE_ID,
        userId,
        "Blog Post Draft Generation in progress",
        "Started.",
        runningMetadata,
        "job-running-1",
        "blog-post-draft-generation",
      ],
    );

    return {
      userId,
      terminalCount: TERMINAL_FIXTURES.length,
      runningCount: 1,
      unreadTerminalCount: unreadTerminals,
    };
  } finally {
    await pool.end();
  }
}

export async function cleanupNotificationFixtures(
  opts: NotificationsSeedOptions,
): Promise<void> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    const userRow = await pool.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [opts.email],
    );
    if (userRow.rows.length === 0) return;
    const userId = userRow.rows[0]!.id;
    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [userId, `${FIXTURE_ID_PREFIX}%`],
    );
  } finally {
    await pool.end();
  }
}
