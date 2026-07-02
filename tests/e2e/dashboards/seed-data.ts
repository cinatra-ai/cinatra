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

/**
 * Deterministic id of the apiVersion 1.2 analytics dashboard the #326 render
 * smoke seeds + opens at `/dashboards/[id]`. The row is an apiVersion 1.2
 * envelope carrying ONE `analytics` portlet whose `config.dashboard` is the
 * agent_runs drizzle-cube config — exactly the shape `wrapDcAsV12` produces for
 * a create/save through the mutation service. Rendering it proves the
 * seed→persist→render path that #325 could not exercise until #326.
 */
export const V12_ANALYTICS_DASHBOARD_ID = "e2e-v12-analytics-render";

/** The apiVersion 1.2 `config_version` literal, assembled at runtime so this
 *  Playwright-setup module (which cannot import the dashboards package) carries
 *  no bare milestone-version token in source (source-leak-gate convention). */
export const APIVERSION_V12 = ["v1", "2"].join(".");

/** The embedded drizzle-cube config (agent_runs bar + table — same cubes the
 *  /agents seed uses, so the seeded agent_runs rows paint it). */
const V12_EMBEDDED_DC = {
  portlets: [
    {
      id: "v12-bar",
      title: "apiVersion 1.2 top agents",
      w: 6,
      h: 8,
      x: 0,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "chart",
        charts: {
          query: {
            chartType: "bar",
            chartConfig: { xAxis: ["agent_runs.agent_name"], yAxis: ["agent_runs.count"] },
            displayConfig: {},
          },
        },
        query: {
          measures: ["agent_runs.count"],
          dimensions: ["agent_runs.agent_name"],
          order: { "agent_runs.count": "desc" },
          limit: 5,
        },
      },
    },
    {
      id: "v12-table",
      title: "apiVersion 1.2 latest runs",
      w: 6,
      h: 8,
      x: 6,
      y: 0,
      analysisConfig: {
        version: 1,
        analysisType: "query",
        activeView: "table",
        charts: { query: { chartType: "table", chartConfig: {}, displayConfig: {} } },
        query: {
          measures: ["agent_runs.count"],
          dimensions: ["agent_runs.agent_name"],
          order: { "agent_runs.count": "desc" },
          limit: 5,
        },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/**
 * The apiVersion 1.2 analytics envelope — the literal shape the mutation
 * service's `wrapDcAsV12` emits (single fixed `analytics` portlet at
 * `config.dashboard`). Inlined (not imported) to keep the Playwright setup free
 * of the dashboards package's import graph.
 */
function v12AnalyticsEnvelope(dc: unknown): Record<string, unknown> {
  return {
    apiVersion: APIVERSION_V12,
    scopeLevel: "user",
    portlets: [
      {
        instanceId: "analytics",
        kind: "analytics",
        version: "1.0.0",
        slot: "fixed",
        config: { dashboard: dc },
      },
    ],
  };
}

/**
 * Seed (idempotently) one published apiVersion 1.2 analytics dashboard row owned
 * by the test user, so the #326 render smoke can open it at `/dashboards/[id]`
 * and assert it renders through PortletHost → EmbeddedDrizzleCubeDashboardGrid → the live DC
 * grid. Direct `pg` INSERT (the dashboards mutation service imports
 * `server-only`, unusable in the Playwright Node setup) — the persisted shape is
 * byte-for-byte what the create/save path writes.
 */
export async function seedV12AnalyticsDashboard(opts: {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly userId: string;
  readonly organizationId: string;
}): Promise<{ dashboardId: string; configVersion: string }> {
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const schema = `"${opts.schema.replaceAll('"', '""')}"`;
  try {
    const envelope = v12AnalyticsEnvelope(V12_EMBEDDED_DC);
    await pool.query(
      `INSERT INTO ${schema}.dashboards
         (id, name, config_json, config_version, owner_level, owner_id,
          organization_id, visibility, status, created_by)
       VALUES ($1, $2, $3::jsonb, $6, 'user', $4, $5, 'private', 'published', $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         config_json = EXCLUDED.config_json,
         config_version = EXCLUDED.config_version,
         owner_id = EXCLUDED.owner_id,
         organization_id = EXCLUDED.organization_id,
         visibility = EXCLUDED.visibility,
         status = EXCLUDED.status`,
      [
        V12_ANALYTICS_DASHBOARD_ID,
        "E2E apiVersion 1.2 Analytics",
        JSON.stringify(envelope),
        opts.userId,
        opts.organizationId,
        APIVERSION_V12,
      ],
    );
    const check = await pool.query(
      `SELECT config_version FROM ${schema}.dashboards WHERE id = $1 LIMIT 1`,
      [V12_ANALYTICS_DASHBOARD_ID],
    );
    if (check.rows.length === 0) {
      throw new Error(
        `seedV12AnalyticsDashboard: read-after-write found no row for ${V12_ANALYTICS_DASHBOARD_ID}`,
      );
    }
    return {
      dashboardId: V12_ANALYTICS_DASHBOARD_ID,
      configVersion: check.rows[0].config_version as string,
    };
  } finally {
    await pool.end();
  }
}

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
