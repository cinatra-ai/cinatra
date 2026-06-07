/**
 * Test-data seeding for the dashboards live-verify smoke (Option A
 * retrospective item C).
 *
 * The `agent_runs` cube needs rows to render the two `/agents`
 * portlets. On a fresh CI Postgres schema we won't have any. This
 * module exposes `seedDashboardFixtures(opts)` which:
 *
 *   1. Creates a deterministic test user via Better Auth's
 *      email/password sign-up endpoint (`POST /api/auth/sign-up/email`).
 *   2. Resolves the user's active organization (via Better Auth's
 *      `/api/auth/organization/list` + setActive if needed).
 *   3. Inserts 3 distinct `agent_templates` rows + 4 `agent_runs`
 *      rows so the bar chart shows at least 3 bars and the table
 *      shows at least 3 rows.
 *
 * Run inside Playwright's setup project — see `auth.setup.ts`.
 *
 * Idempotent: ON CONFLICT DO NOTHING on every insert. Safe to re-run.
 */
import { Pool } from "pg";

export type SeedOptions = {
  readonly email: string;
  readonly databaseUrl: string;
  readonly schema: string;
};

export type SeedResult = {
  readonly userId: string;
  readonly organizationId: string;
  readonly templateCount: number;
  readonly runCount: number;
};

const TEMPLATES = [
  { id: "tmpl-test-scrape", name: "Test Scrape Agent" },
  { id: "tmpl-test-publish", name: "Test Publish Agent" },
  { id: "tmpl-test-summarize", name: "Test Summarize Agent" },
] as const;

const RUNS = [
  { id: "run-fixture-1", templateId: "tmpl-test-scrape", status: "succeeded", offsetHours: 2 },
  { id: "run-fixture-2", templateId: "tmpl-test-scrape", status: "succeeded", offsetHours: 5 },
  { id: "run-fixture-3", templateId: "tmpl-test-publish", status: "succeeded", offsetHours: 12 },
  { id: "run-fixture-4", templateId: "tmpl-test-summarize", status: "failed", offsetHours: 26 },
] as const;

export async function seedDashboardFixtures(
  opts: SeedOptions,
): Promise<SeedResult> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    // 1. Resolve userId via Better Auth's public.user table (test creds).
    const userRow = await pool.query(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [opts.email],
    );
    if (userRow.rows.length === 0) {
      throw new Error(
        `seedDashboardFixtures: user not found for ${opts.email} — run auth.setup.ts first`,
      );
    }
    const userId = userRow.rows[0].id as string;

    // 2. Resolve activeOrganizationId via Better Auth's member table.
    const memberRow = await pool.query(
      `SELECT "organizationId" FROM public."member" WHERE "userId" = $1 LIMIT 1`,
      [userId],
    );
    if (memberRow.rows.length === 0) {
      throw new Error(
        `seedDashboardFixtures: user ${userId} has no organization membership`,
      );
    }
    const organizationId = memberRow.rows[0].organizationId as string;

    // 3. Insert templates (minimum required NOT NULL cols).
    for (const t of TEMPLATES) {
      await pool.query(
        `INSERT INTO ${schema}.agent_templates
           (id, org_id, creator_id, name, source_nl, compiled_plan, input_schema,
            approval_policy, status, package_name)
         VALUES ($1, $2, $3, $4, '', '{}', '{}', '{"steps":[]}', 'published', $5)
         ON CONFLICT (id) DO NOTHING`,
        [t.id, organizationId, userId, t.name, `@cinatra-ai/${t.id}`],
      );
    }

    // 4. Insert runs.
    for (const r of RUNS) {
      const createdAt = new Date(Date.now() - r.offsetHours * 3_600_000);
      await pool.query(
        `INSERT INTO ${schema}.agent_runs
           (id, template_id, run_by, status, input_params, org_id, created_at)
         VALUES ($1, $2, $3, $4, '{}', $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.templateId, userId, r.status, organizationId, createdAt],
      );
    }

    const tCount = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.agent_templates WHERE id LIKE 'tmpl-test-%'`,
    );
    const rCount = await pool.query(
      `SELECT COUNT(*) FROM ${schema}.agent_runs WHERE id LIKE 'run-fixture-%'`,
    );

    return {
      userId,
      organizationId,
      templateCount: Number(tCount.rows[0].count),
      runCount: Number(rCount.rows[0].count),
    };
  } finally {
    await pool.end();
  }
}
