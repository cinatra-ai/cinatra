/**
 * Workspace dashboards on real Postgres (cinatra#2811, per-scope surfaces S5).
 *
 * Provisions the dashboards tables in the shape the default branch's bootstrap
 * produces (organization NOT NULL, the three-kind links CHECK), seeds rows in
 * that OLD shape, then applies migration core__0108's own up SQL, so every
 * assertion below runs on a database that was upgraded, not hand-built wide.
 * Then it drives the ACTUAL mutation service.
 *
 * What it pins:
 *   - the migration on a database that already carries the old CHECK: existing
 *     rows survive, the shape widens, a re-run is a no-op, down then up
 *     round-trips;
 *   - every new CHECK refuses its forbidden row, and the org-NULL index twins
 *     hold one Overview / one name per user without colliding with any
 *     organization row;
 *   - the service: one workspace Overview per user whatever organization is
 *     active (or none), the four Overview guards, create / rename / save /
 *     delete under different active organizations, privacy from another user,
 *     and NO artifact twin for a workspace row while an organization row still
 *     pairs one.
 *
 * GATED like its siblings: DASH_DB_IT=1 plus a throwaway SUPABASE_DB_URL, and
 * SUPABASE_SCHEMA naming a schema this suite may drop:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5446/postgres \
 *   SUPABASE_SCHEMA=cinatra_it_2811 DASH_DB_IT=1 \
 *   npx vitest run --no-coverage --config vitest.integration.config.ts \
 *     src/__tests__/workspace-dashboards-2811.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  workspaceDashboardsDownSql,
  workspaceDashboardsUpSql,
} from "../../../../migrations/core/core__0108_workspace-dashboards.mjs";
import {
  archiveDashboard,
  createEntityDashboard,
  deleteEntityDashboard,
  ensureOverview,
  getEntityDashboard,
  listDashboardsForEntity,
  renameDashboard,
  updateDashboard,
  DashboardForbiddenError,
  DashboardNameConflictError,
  DashboardOverviewProtectedError,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";
import { workspaceDashboardRef, type DashboardEntityRef } from "../store/entity-identity";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
  type DashboardTwinContext,
} from "../twin-writer-seam";
import { DASHBOARD_CONFIG_V12_VERSION as V12 } from "../extension/dashboard-config-v12";
import {
  addWorkspaceReferenceLink,
  isWorkspaceReadGranted,
  listWorkspaceReferenceRows,
  removeWorkspaceReferenceLink,
  setWorkspaceReferenceReadGrant,
} from "../store/workspace-links";
import { DashboardAccessError, requireDashboardAccess } from "../auth/require-dashboard-access";
import {
  addDashboardEntityLink,
  listUserHomedDashboards,
  removeDashboardEntityLink,
} from "../store/entity-links";

const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_it_2811";
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${SCHEMA}`);
}

const ORG_A = "org-2811-a";
const ORG_B = "org-2811-b";
const authorityFor = (orgId: string) => ({ orgId, can: (c: string) => c === "content.write" });

/** The same user, seen under three different session states. */
const underA: DashboardActor = {
  userId: "u-2811",
  organizationId: ORG_A,
  teamIds: [],
  orgRole: "member",
  teamRoles: {},
  authority: authorityFor(ORG_A),
};
const underB: DashboardActor = { ...underA, organizationId: ORG_B, authority: authorityFor(ORG_B) };
const underNone: DashboardActor = {
  userId: "u-2811",
  organizationId: null,
  teamIds: [],
  teamRoles: {},
};
const otherUser: DashboardActor = { ...underA, userId: "u-other", orgRole: "owner" };

const wsRef = workspaceDashboardRef("u-2811");
const personalRefA: DashboardEntityRef = {
  entityType: "personal",
  entityId: ORG_A,
  ownerLevel: "user",
  ownerId: "u-2811",
};

/**
 * The dashboards / links / revisions / audit tables in the shape the default
 * branch's bootstrap produces BEFORE core__0108 (mirrors
 * buildCreateStoreSchemaQueries): organization_id NOT NULL, the org-keyed
 * per-entity indexes, and the three-kind inline links CHECK.
 */
async function provisionOldShape(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    config_json jsonb NOT NULL,
    config_version text NOT NULL DEFAULT '${V12}',
    dashboard_version integer NOT NULL DEFAULT 1,
    published_revision_number integer,
    owner_level text NOT NULL CHECK (owner_level IN ('user','team','organization','workspace')),
    owner_id text NOT NULL,
    organization_id text NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived','generation_failed')),
    created_by text NOT NULL,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    archived_at timestamptz,
    project_id text,
    extension_id text,
    is_template boolean NOT NULL DEFAULT false,
    template_scope text,
    entity_type text,
    entity_id text,
    is_default boolean NOT NULL DEFAULT false,
    contribution_id text,
    applied_contribution_version integer,
    applied_default_json jsonb,
    applied_default_hash text,
    archive_reason text
  )`);
  await pool.query(`CREATE TABLE "${SCHEMA}".dashboard_revisions (
    dashboard_id text NOT NULL REFERENCES "${SCHEMA}".dashboards(id) ON DELETE CASCADE,
    revision_number integer NOT NULL,
    config_json jsonb NOT NULL,
    config_version text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dashboard_id, revision_number)
  )`);
  await pool.query(`CREATE TABLE "${SCHEMA}".audit_events (
    id text PRIMARY KEY, organization_id text, actor_principal_id text,
    actor_principal_type text, auth_source text, delegated_by text,
    impersonated_user_id text, resource_type text, resource_id text,
    operation text, decision text, policy_version text, request_id text,
    run_id text, a2a_task_id text, ip text, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX dashboards_entity_idx ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id) WHERE entity_type IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX dashboards_entity_default_uniq ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id) WHERE is_default = true AND entity_type IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX dashboards_entity_name_uniq ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id, name) WHERE entity_type IS NOT NULL`);
  await pool.query(`CREATE TABLE "${SCHEMA}".dashboard_entity_links (id text PRIMARY KEY, dashboard_id text NOT NULL REFERENCES "${SCHEMA}".dashboards(id) ON DELETE CASCADE, entity_type text NOT NULL CHECK (entity_type IN ('team','organization','project')), entity_id text NOT NULL, organization_id text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX dashboard_entity_links_uniq ON "${SCHEMA}".dashboard_entity_links (dashboard_id, entity_type, entity_id)`);
  await pool.query(`CREATE INDEX dashboard_entity_links_scope_idx ON "${SCHEMA}".dashboard_entity_links (entity_type, entity_id, organization_id)`);
  await pool.query(`CREATE INDEX dashboard_entity_links_dashboard_idx ON "${SCHEMA}".dashboard_entity_links (dashboard_id)`);
  // The org-write kernel guard reads public."organization" FOR SHARE before an
  // ORGANIZATION write; the workspace arm reads nothing there.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, name text, "archivedAt" timestamptz, "archiveEpoch" int)`,
  );
  await pool.query(`ALTER TABLE public."organization" ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz`);
  await pool.query(`ALTER TABLE public."organization" ADD COLUMN IF NOT EXISTS "archiveEpoch" int`);
  for (const org of [ORG_A, ORG_B]) {
    await pool.query(
      `INSERT INTO public."organization" (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [org],
    );
  }
}

/** Run a migration SQL block the way the runner does: unqualified names on the
 *  app schema's search_path, in one transaction. */
async function runMigrationSql(pool: Pool, text: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${SCHEMA}", public`);
    await client.query(text);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Expect a statement to be refused with a given SQLSTATE (and constraint). */
async function expectRefused(
  pool: Pool,
  text: string,
  values: unknown[],
  code: "23514" | "23505",
  constraint?: string,
): Promise<void> {
  let caught: { code?: string; constraint?: string } | null = null;
  try {
    await pool.query(text, values);
  } catch (e) {
    caught = e as { code?: string; constraint?: string };
  }
  expect(caught, `expected ${code} for: ${text}`).not.toBeNull();
  expect(caught!.code).toBe(code);
  if (constraint) expect(caught!.constraint).toBe(constraint);
}

const T = () => `"${SCHEMA}".dashboards`;
const L = () => `"${SCHEMA}".dashboard_entity_links`;
const CFG = `'{"apiVersion":"${V12}","scopeLevel":"user","portlets":[]}'::jsonb`;

describe.skipIf(!RUN_IT)("cinatra#2811 workspace dashboards (real Postgres)", () => {
  let pool: Pool;
  const twinCalls: DashboardTwinContext[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await provisionOldShape(pool);
    // Rows that exist BEFORE the upgrade: an organization dashboard and a team
    // listing of it, both in the old shape.
    await pool.query(
      `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id)
       VALUES ('pre-team-dash', 'Pipeline health', ${CFG}, 'team', 'team-1', $1, 'u-admin', 'team', 'team-1')`,
      [ORG_A],
    );
    await pool.query(
      `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by)
       VALUES ('pre-link', 'pre-team-dash', 'organization', $1, $1, 'u-admin')`,
      [ORG_A],
    );
    await runMigrationSql(pool, workspaceDashboardsUpSql);
  }, 60_000);

  beforeEach(() => {
    twinCalls.length = 0;
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(async (_tx, ctx) => {
      twinCalls.push(ctx);
    });
  });

  afterAll(async () => {
    resetDashboardArtifactTwinWriter();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool
        .query(`DELETE FROM public."organization" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
        .catch(() => {});
      await pool.end();
    }
  });

  // ── The migration on a database carrying the old CHECK ─────────────────
  describe("migration core__0108 on the old shape", () => {
    it("keeps every pre-existing row and widens the shape", async () => {
      const dash = await pool.query(`SELECT id, organization_id FROM ${T()} WHERE id = 'pre-team-dash'`);
      expect(dash.rows).toEqual([{ id: "pre-team-dash", organization_id: ORG_A }]);
      const link = await pool.query(
        `SELECT id, entity_type, workspace_read_granted, workspace_read_granted_by, workspace_read_granted_at FROM ${L()}`,
      );
      expect(link.rows).toEqual([
        {
          id: "pre-link",
          entity_type: "organization",
          workspace_read_granted: false,
          workspace_read_granted_by: null,
          workspace_read_granted_at: null,
        },
      ]);
      const nullable = await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'dashboards' AND column_name = 'organization_id'`,
        [SCHEMA],
      );
      expect(nullable.rows[0].is_nullable).toBe("YES");
      const check = await pool.query(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
          WHERE c.conrelid = $1::regclass AND c.conname = 'dashboard_entity_links_entity_type_check'`,
        [`"${SCHEMA}".dashboard_entity_links`],
      );
      expect(check.rows[0].def).toContain("workspace");
    });

    it("is a no-op when re-run on the target shape", async () => {
      await expect(runMigrationSql(pool, workspaceDashboardsUpSql)).resolves.toBeUndefined();
      const count = await pool.query(`SELECT count(*)::int AS n FROM ${L()}`);
      expect(count.rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });

  // ── The CHECKs refuse their forbidden rows ──────────────────────────────
  describe("the new CHECK constraints", () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM ${L()} WHERE id <> 'pre-link'`);
      await pool.query(`DELETE FROM ${T()} WHERE id <> 'pre-team-dash'`);
    });

    const insertDash = (over: Record<string, unknown>) => {
      const row = {
        id: "c1",
        name: "N",
        owner_level: "user",
        owner_id: "u-2811",
        organization_id: null as string | null,
        entity_type: "workspace" as string | null,
        entity_id: "__workspace__" as string | null,
        project_id: null as string | null,
        is_template: false,
        ...over,
      };
      return [
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id, project_id, is_template)
         VALUES ($1, $2, ${CFG}, $3, $4, $5, 'u-2811', $6, $7, $8, $9)`,
        [row.id, row.name, row.owner_level, row.owner_id, row.organization_id, row.entity_type, row.entity_id, row.project_id, row.is_template],
      ] as const;
    };

    it("admits the workspace shape itself", async () => {
      const [text, values] = insertDash({});
      await expect(pool.query(text, [...values])).resolves.toBeTruthy();
    });

    it("refuses a workspace row that carries an organization", async () => {
      const [text, values] = insertDash({ organization_id: ORG_A });
      await expectRefused(pool, text, [...values], "23514", "dashboards_workspace_entity_org_check");
    });

    it("refuses an org-NULL row that is not the workspace entity", async () => {
      const [text, values] = insertDash({ entity_type: "personal", entity_id: ORG_A });
      await expectRefused(pool, text, [...values], "23514", "dashboards_workspace_entity_org_check");
      const [text2, values2] = insertDash({ id: "c2", entity_type: null, entity_id: null });
      await expectRefused(pool, text2, [...values2], "23514", "dashboards_workspace_entity_org_check");
    });

    it("refuses a workspace row outside the user-owned __workspace__ shape", async () => {
      for (const over of [
        { entity_id: null },
        { entity_id: ORG_A },
        { owner_level: "team" },
        { project_id: "p-1" },
        { is_template: true },
      ]) {
        const [text, values] = insertDash(over);
        await expectRefused(pool, text, [...values], "23514", "dashboards_workspace_entity_shape_check");
      }
    });

    it("refuses a link kind outside team / organization / project / workspace", async () => {
      await expectRefused(
        pool,
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by) VALUES ('l1', 'pre-team-dash', 'personal', 'u-2811', $1, 'u')`,
        [ORG_A],
        "23514",
        "dashboard_entity_links_entity_type_check",
      );
    });

    it("pins a workspace link to the __workspace__ scope", async () => {
      await expectRefused(
        pool,
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by) VALUES ('l1', 'pre-team-dash', 'workspace', 'somewhere', $1, 'u')`,
        [ORG_A],
        "23514",
        "dashboard_entity_links_workspace_scope_check",
      );
    });

    it("forbids the everyone-grant on a non-workspace link", async () => {
      await expectRefused(
        pool,
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by, workspace_read_granted, workspace_read_granted_by, workspace_read_granted_at)
         VALUES ('l1', 'pre-team-dash', 'team', 'team-9', $1, 'u', true, 'u-platform', now())`,
        [ORG_A],
        "23514",
        "dashboard_entity_links_workspace_grant_check",
      );
    });

    it("requires the grant metadata exactly when granted", async () => {
      await expectRefused(
        pool,
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by, workspace_read_granted)
         VALUES ('l1', 'pre-team-dash', 'workspace', '__workspace__', $1, 'u', true)`,
        [ORG_A],
        "23514",
        "dashboard_entity_links_workspace_grant_check",
      );
      await expectRefused(
        pool,
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by, workspace_read_granted, workspace_read_granted_by)
         VALUES ('l2', 'pre-team-dash', 'workspace', '__workspace__', $1, 'u', false, 'u-platform')`,
        [ORG_A],
        "23514",
        "dashboard_entity_links_workspace_grant_check",
      );
      await expect(
        pool.query(
          `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by, workspace_read_granted, workspace_read_granted_by, workspace_read_granted_at)
           VALUES ('l3', 'pre-team-dash', 'workspace', '__workspace__', $1, 'u', true, 'u-platform', now())`,
          [ORG_A],
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ── The org-NULL index twins ────────────────────────────────────────────
  describe("the org-NULL twins of the per-entity indexes", () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM ${T()} WHERE id <> 'pre-team-dash'`);
    });

    const ins = (id: string, name: string, org: string | null, isDefault: boolean, owner = "u-2811") =>
      pool.query(
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id, is_default)
         VALUES ($1, $2, ${CFG}, 'user', $3, $4, $3, $5, $6, $7)`,
        [id, name, owner, org, org ? "personal" : "workspace", org ?? "__workspace__", isDefault],
      );

    it("holds ONE workspace Overview per user", async () => {
      await ins("w-ov-1", "Overview", null, true);
      await expectRefused(
        pool,
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id, is_default)
         VALUES ('w-ov-2', 'Overview', ${CFG}, 'user', 'u-2811', NULL, 'u-2811', 'workspace', '__workspace__', true)`,
        [],
        "23505",
        "dashboards_workspace_entity_default_uniq",
      );
    });

    it("holds ONE name per user's workspace collection", async () => {
      await ins("w-1", "Revenue", null, false);
      await expectRefused(
        pool,
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id)
         VALUES ('w-2', 'Revenue', ${CFG}, 'user', 'u-2811', NULL, 'u-2811', 'workspace', '__workspace__')`,
        [],
        "23505",
        "dashboards_workspace_entity_name_uniq",
      );
    });

    it("never collides with an organization row, nor with another user's workspace", async () => {
      await ins("w-1", "Revenue", null, false);
      await ins("w-ov", "Overview", null, true);
      await expect(ins("o-1", "Revenue", ORG_A, false)).resolves.toBeTruthy();
      await expect(ins("o-ov", "Overview", ORG_A, true)).resolves.toBeTruthy();
      await expect(ins("w-other", "Revenue", null, false, "u-other")).resolves.toBeTruthy();
      await expect(ins("w-other-ov", "Overview", null, true, "u-other")).resolves.toBeTruthy();
    });
  });

  // ── The service ─────────────────────────────────────────────────────────
  describe("the mutation service's workspace arms", () => {
    beforeEach(async () => {
      await pool.query(`DELETE FROM ${T()} WHERE id <> 'pre-team-dash'`);
      await pool.query(`DELETE FROM "${SCHEMA}".audit_events`);
    });

    it("ensures ONE workspace Overview whatever organization is active, or none", async () => {
      const a = await ensureOverview({ ref: wsRef }, underA);
      const b = await ensureOverview({ ref: wsRef }, underB);
      const none = await ensureOverview({ ref: wsRef }, underNone);
      expect(a.id).toBe("dash:workspace:__workspace__:user:u-2811:overview");
      expect(b.id).toBe(a.id);
      expect(none.id).toBe(a.id);
      expect(a.organizationId).toBeNull();
      const n = await pool.query(`SELECT count(*)::int AS n FROM ${T()} WHERE entity_type = 'workspace'`);
      expect(n.rows[0].n).toBe(1);
    });

    it("lists the same workspace dashboards under every active organization", async () => {
      await ensureOverview({ ref: wsRef }, underA);
      await createEntityDashboard({ ref: wsRef, name: "Revenue" }, underB);
      const lists = await Promise.all(
        [underA, underB, underNone].map((act) => listDashboardsForEntity(wsRef, act)),
      );
      const names = lists.map((rows) => rows.map((r) => `${r.id}|${r.name}`));
      expect(names[0].length).toBe(2);
      expect(names[1]).toEqual(names[0]);
      expect(names[2]).toEqual(names[0]);
      expect(lists[0][0].isDefault).toBe(true);
    });

    it("refuses a duplicate name in the user's workspace collection", async () => {
      await createEntityDashboard({ ref: wsRef, name: "Revenue" }, underA);
      await expect(
        createEntityDashboard({ ref: wsRef, name: "Revenue" }, underNone),
      ).rejects.toBeInstanceOf(DashboardNameConflictError);
    });

    it("keeps the workspace Overview non-removable through ALL FOUR guards", async () => {
      const overview = await ensureOverview({ ref: wsRef }, underA);
      await expect(updateDashboard(overview.id, { name: "Renamed" }, underA)).rejects.toBeInstanceOf(
        DashboardOverviewProtectedError,
      );
      await expect(archiveDashboard(overview.id, underB)).rejects.toBeInstanceOf(
        DashboardOverviewProtectedError,
      );
      await expect(renameDashboard(overview.id, "Renamed", underNone)).rejects.toBeInstanceOf(
        DashboardOverviewProtectedError,
      );
      await expect(deleteEntityDashboard(overview.id, underA)).rejects.toBeInstanceOf(
        DashboardOverviewProtectedError,
      );
      const still = await pool.query(`SELECT name, status FROM ${T()} WHERE id = $1`, [overview.id]);
      expect(still.rows).toEqual([{ name: "Overview", status: "draft" }]);
    });

    it("renames, saves and deletes a workspace dashboard under DIFFERENT active organizations", async () => {
      const created = await createEntityDashboard({ ref: wsRef, name: "Draft" }, underA);
      const renamed = await renameDashboard(created.id, "Final", underB);
      expect(renamed.name).toBe("Final");
      expect(renamed.organizationId).toBeNull();
      const saved = await updateDashboard(
        created.id,
        { config: { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } } },
        underNone,
      );
      expect(saved.dashboardVersion).toBe(renamed.dashboardVersion + 1);
      await deleteEntityDashboard(created.id, underA);
      const gone = await pool.query(`SELECT 1 FROM ${T()} WHERE id = $1`, [created.id]);
      expect(gone.rowCount).toBe(0);
    });

    it("keeps a user's workspace dashboards private from every other user", async () => {
      const mine = await createEntityDashboard({ ref: wsRef, name: "Mine" }, underA);
      expect(await getEntityDashboard(mine.id, otherUser)).toBeUndefined();
      await expect(renameDashboard(mine.id, "Theirs", otherUser)).rejects.toBeInstanceOf(
        DashboardForbiddenError,
      );
      await expect(deleteEntityDashboard(mine.id, otherUser)).rejects.toBeInstanceOf(
        DashboardForbiddenError,
      );
      // Their own workspace list never carries mine.
      const theirs = await listDashboardsForEntity(workspaceDashboardRef("u-other"), otherUser);
      expect(theirs.map((r) => r.id)).not.toContain(mine.id);
      // And naming MY ref does not hand them my rows.
      expect(await listDashboardsForEntity(wsRef, otherUser)).toEqual([]);
    });

    it("refuses to write a workspace ref on behalf of another user", async () => {
      await expect(ensureOverview({ ref: workspaceDashboardRef("u-other") }, underA)).rejects.toBeInstanceOf(
        DashboardForbiddenError,
      );
      await expect(
        createEntityDashboard({ ref: workspaceDashboardRef("u-other"), name: "X" }, underA),
      ).rejects.toBeInstanceOf(DashboardForbiddenError);
    });

    it("pairs NO artifact twin for a workspace row, while an organization row still pairs one", async () => {
      const overview = await ensureOverview({ ref: wsRef }, underA);
      const created = await createEntityDashboard({ ref: wsRef, name: "Twinless" }, underA);
      await renameDashboard(created.id, "Still twinless", underA);
      await deleteEntityDashboard(created.id, underA);
      expect(overview.organizationId).toBeNull();
      expect(twinCalls).toEqual([]);
      // The organization arm is unchanged: its Overview pairs exactly one twin.
      await ensureOverview({ ref: personalRefA }, underA);
      expect(twinCalls.length).toBe(1);
      expect(twinCalls[0].orgId).toBe(ORG_A);
    });

    it("keeps Personal in its landed shape: the personal read never returns a workspace row", async () => {
      await ensureOverview({ ref: wsRef }, underA);
      await createEntityDashboard({ ref: wsRef, name: "Workspace only" }, underA);
      await ensureOverview({ ref: personalRefA }, underA);
      const personal = await listUserHomedDashboards({ orgId: ORG_A, userId: "u-2811" });
      expect(personal.map((r) => [r.entityType, r.organizationId])).toEqual([["personal", ORG_A]]);
      expect(personal.map((r) => r.name)).not.toContain("Workspace only");
    });

    it("audits a workspace write with no organization", async () => {
      const overview = await ensureOverview({ ref: wsRef }, underB);
      const audit = await pool.query(
        `SELECT organization_id, operation, resource_id FROM "${SCHEMA}".audit_events WHERE resource_id = $1`,
        [overview.id],
      );
      expect(audit.rows).toEqual([
        { organization_id: null, operation: "dashboards.create", resource_id: overview.id },
      ]);
    });
  });

  // ── Workspace references, the everyone-grant, and the read bypass ──────
  describe("workspace references and the everyone-grant", () => {
    const outsider: DashboardActor = {
      userId: "u-outsider",
      organizationId: ORG_B,
      teamIds: [],
      orgRole: "member",
      teamRoles: {},
    };

    beforeEach(async () => {
      await pool.query(`DELETE FROM ${L()} WHERE id <> 'pre-link'`);
      await pool.query(`DELETE FROM ${T()} WHERE id NOT IN ('pre-team-dash')`);
      await pool.query(`DELETE FROM "${SCHEMA}".audit_events`);
      await pool.query(
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id)
         VALUES ('b-org-dash', 'Spend by project', ${CFG}, 'organization', $1, $1, 'u-admin-b', 'organization', $1)`,
        [ORG_B],
      );
    });

    it("adds a reference only under the target's own home organization, idempotently", async () => {
      expect(
        await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_B, createdBy: "u-admin" }),
      ).toEqual({ created: false });
      expect(
        await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u-admin" }),
      ).toEqual({ created: true });
      expect(
        await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u-admin" }),
      ).toEqual({ created: false });
      const rows = await pool.query(`SELECT entity_type, entity_id, organization_id FROM ${L()} WHERE entity_type = 'workspace'`);
      expect(rows.rows).toEqual([{ entity_type: "workspace", entity_id: "__workspace__", organization_id: ORG_A }]);
    });

    it("reads the collection across organizations, fenced on both sides of the join", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      await addWorkspaceReferenceLink({ dashboardId: "b-org-dash", homeOrgId: ORG_B, createdBy: "u" });
      // A malformed link whose organization disagrees with its target's is
      // never surfaced (no name leaks across the fence).
      await pool.query(
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by)
         VALUES ('bad-fence', 'pre-team-dash', 'team', 'team-1', $1, 'u')`,
        [ORG_B],
      );
      await pool.query(
        `UPDATE ${L()} SET organization_id = $1 WHERE dashboard_id = 'b-org-dash' AND entity_type = 'workspace'`,
        [ORG_A],
      );
      const rows = await listWorkspaceReferenceRows();
      expect(rows.map((r) => [r.dashboardId, r.homeOrgId, r.name])).toEqual([
        ["pre-team-dash", ORG_A, "Pipeline health"],
      ]);
    });

    it("grants, revokes and audits the everyone-grant; revoking keeps the audit history", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      const g = await setWorkspaceReferenceReadGrant(
        { dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true },
        "u-platform",
      );
      expect(g).toEqual({ changed: true });
      const live = await pool.query(
        `SELECT workspace_read_granted AS g, workspace_read_granted_by AS by, workspace_read_granted_at IS NOT NULL AS at FROM ${L()} WHERE entity_type = 'workspace'`,
      );
      expect(live.rows).toEqual([{ g: true, by: "u-platform", at: true }]);
      // Re-granting changes nothing and records nothing.
      expect(
        await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true }, "u-platform"),
      ).toEqual({ changed: false });
      expect(
        await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: false }, "u-platform-2"),
      ).toEqual({ changed: true });
      const cleared = await pool.query(
        `SELECT workspace_read_granted AS g, workspace_read_granted_by AS by, workspace_read_granted_at AS at FROM ${L()} WHERE entity_type = 'workspace'`,
      );
      expect(cleared.rows).toEqual([{ g: false, by: null, at: null }]);
      const audit = await pool.query(
        `SELECT operation, organization_id, actor_principal_id, resource_type, resource_id, metadata FROM "${SCHEMA}".audit_events ORDER BY created_at, operation`,
      );
      expect(audit.rows.map((r) => [r.operation, r.organization_id, r.actor_principal_id, r.resource_type, r.resource_id])).toEqual([
        ["dashboard.workspace_read_granted", ORG_A, "u-platform", "dashboard", "pre-team-dash"],
        ["dashboard.workspace_read_revoked", ORG_A, "u-platform-2", "dashboard", "pre-team-dash"],
      ]);
      expect(audit.rows[0].metadata.prior).toEqual({ granted: false, grantedBy: null, grantedAt: null });
      expect(audit.rows[1].metadata.prior.granted).toBe(true);
      expect(audit.rows[1].metadata.prior.grantedBy).toBe("u-platform");
      expect(typeof audit.rows[0].metadata.linkId).toBe("string");
      expect(typeof audit.rows[0].metadata.at).toBe("string");
    });

    it("refuses a grant on a link that does not exist or sits under another home organization", async () => {
      expect(
        await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true }, "u-p"),
      ).toEqual({ changed: false, missing: true });
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      expect(
        await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_B, granted: true }, "u-p"),
      ).toEqual({ changed: false, missing: true });
    });

    it("removing a granted reference revokes it on the record, and the link is gone", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true }, "u-p");
      expect(await removeWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A }, "u-admin-a")).toEqual({
        removed: true,
      });
      const left = await pool.query(`SELECT count(*)::int AS n FROM ${L()} WHERE entity_type = 'workspace'`);
      expect(left.rows[0].n).toBe(0);
      const audit = await pool.query(
        `SELECT operation, metadata FROM "${SCHEMA}".audit_events ORDER BY created_at, operation`,
      );
      expect(audit.rows.map((r) => r.operation)).toEqual([
        "dashboard.workspace_read_granted",
        "dashboard.workspace_read_revoked",
      ]);
      expect(audit.rows[1].metadata.reason).toBe("reference-removed");
      // An ungranted reference is removed without a revocation record.
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      await removeWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A }, "u-admin-a");
      const after = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".audit_events`);
      expect(after.rows[0].n).toBe(2);
    });

    it("deleting a dashboard whose reference is granted records the revocation before the cascade", async () => {
      await pool.query(
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id)
         VALUES ('a-user-dash', 'Doomed', ${CFG}, 'user', 'u-2811', $1, 'u-2811', 'personal', $1)`,
        [ORG_A],
      );
      await addWorkspaceReferenceLink({ dashboardId: "a-user-dash", homeOrgId: ORG_A, createdBy: "u" });
      await setWorkspaceReferenceReadGrant({ dashboardId: "a-user-dash", homeOrgId: ORG_A, granted: true }, "u-p");
      await deleteEntityDashboard("a-user-dash", underA);
      const links = await pool.query(`SELECT count(*)::int AS n FROM ${L()} WHERE dashboard_id = 'a-user-dash'`);
      expect(links.rows[0].n).toBe(0);
      const audit = await pool.query(
        `SELECT operation, actor_principal_id, metadata FROM "${SCHEMA}".audit_events
          WHERE resource_id = 'a-user-dash' AND operation LIKE 'dashboard.workspace_read_%' ORDER BY created_at, operation`,
      );
      expect(audit.rows.map((r) => [r.operation, r.actor_principal_id, r.metadata.reason])).toEqual([
        ["dashboard.workspace_read_granted", "u-p", "set"],
        ["dashboard.workspace_read_revoked", "u-2811", "dashboard-deleted"],
      ]);
    });

    it("never references a default Overview (organization deletion removes those without the delete writer)", async () => {
      await pool.query(
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id, is_default)
         VALUES ('a-overview', 'Overview', ${CFG}, 'user', 'u-2811', $1, 'u-2811', 'personal', $1, true)`,
        [ORG_A],
      );
      expect(
        await addWorkspaceReferenceLink({ dashboardId: "a-overview", homeOrgId: ORG_A, createdBy: "u" }),
      ).toEqual({ created: false });
    });

    it("a grant racing a dashboard delete is still revoked on the record", async () => {
      await pool.query(
        `INSERT INTO ${T()} (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id)
         VALUES ('a-race', 'Racing', ${CFG}, 'user', 'u-2811', $1, 'u-2811', 'personal', $1)`,
        [ORG_A],
      );
      await addWorkspaceReferenceLink({ dashboardId: "a-race", homeOrgId: ORG_A, createdBy: "u" });
      // A platform administrator's grant is mid-flight: its link row is locked
      // and updated, not yet committed, when the delete starts.
      const granter = await pool.connect();
      try {
        await granter.query("BEGIN");
        await granter.query(
          `SELECT id FROM ${L()} WHERE dashboard_id = 'a-race' AND entity_type = 'workspace' FOR UPDATE`,
        );
        await granter.query(
          `UPDATE ${L()} SET workspace_read_granted = true, workspace_read_granted_by = 'u-p', workspace_read_granted_at = now()
            WHERE dashboard_id = 'a-race' AND entity_type = 'workspace'`,
        );
        const deleting = deleteEntityDashboard("a-race", underA);
        await new Promise((r) => setTimeout(r, 300));
        await granter.query("COMMIT");
        await deleting;
      } finally {
        granter.release();
      }
      const audit = await pool.query(
        `SELECT operation, metadata FROM "${SCHEMA}".audit_events
          WHERE resource_id = 'a-race' AND operation = 'dashboard.workspace_read_revoked'`,
      );
      expect(audit.rows.map((r) => r.metadata.reason)).toEqual(["dashboard-deleted"]);
    });

    it("the tenant listing writers refuse a workspace link at runtime", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true }, "u-p");
      await expect(
        removeDashboardEntityLink({
          dashboardId: "pre-team-dash",
          entityType: "workspace" as never,
          entityId: "__workspace__",
          organizationId: ORG_A,
        }),
      ).rejects.toThrow(/workspace/);
      await expect(
        addDashboardEntityLink({
          dashboardId: "b-org-dash",
          entityType: "workspace" as never,
          entityId: "__workspace__",
          organizationId: ORG_B,
          createdBy: "u",
        }),
      ).rejects.toThrow(/workspace/);
      const still = await pool.query(`SELECT workspace_read_granted AS g FROM ${L()} WHERE entity_type = 'workspace'`);
      expect(still.rows).toEqual([{ g: true }]);
    });

    it("the grant opens READ ONLY, to any authenticated user, only while it stands", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      const read = (actor: DashboardActor, mode: "read" | "write" = "read") =>
        requireDashboardAccess({ actor, projectGrants: [], dashboardId: "pre-team-dash", mode });
      // Without the grant the target's home access decides: an outsider is refused.
      await expect(read(outsider)).rejects.toBeInstanceOf(DashboardAccessError);
      expect(await isWorkspaceReadGranted("pre-team-dash", ORG_A)).toBe(false);

      await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: true }, "u-p");
      expect(await isWorkspaceReadGranted("pre-team-dash", ORG_A)).toBe(true);
      await expect(read(outsider)).resolves.toMatchObject({ id: "pre-team-dash" });
      // Write never widens.
      await expect(read(outsider, "write")).rejects.toBeInstanceOf(DashboardAccessError);
      // No identified user, no bypass.
      await expect(read({ ...outsider, userId: "" })).rejects.toBeInstanceOf(DashboardAccessError);
      // An OBO-delegated agent actor is not "every authenticated user".
      await expect(
        read({ ...outsider, oboCeiling: [{ tier: "organization", id: ORG_B }] }),
      ).rejects.toBeInstanceOf(DashboardAccessError);

      await setWorkspaceReferenceReadGrant({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, granted: false }, "u-p");
      await expect(read(outsider)).rejects.toBeInstanceOf(DashboardAccessError);
    });

    it("a reference without the grant widens nothing: home access alone decides", async () => {
      await addWorkspaceReferenceLink({ dashboardId: "pre-team-dash", homeOrgId: ORG_A, createdBy: "u" });
      const outsiderRead = requireDashboardAccess({
        actor: outsider,
        projectGrants: [],
        dashboardId: "pre-team-dash",
        mode: "read",
      });
      await expect(outsiderRead).rejects.toBeInstanceOf(DashboardAccessError);
      // A member of the team's organization and team still reads it at home.
      const teamMember: DashboardActor = { ...underA, userId: "u-member", teamIds: ["team-1"] };
      await expect(
        requireDashboardAccess({ actor: teamMember, projectGrants: [], dashboardId: "pre-team-dash", mode: "read" }),
      ).resolves.toMatchObject({ id: "pre-team-dash" });
    });
  });

  // ── Down, then up again ─────────────────────────────────────────────────
  describe("migration core__0108 down, then up again", () => {
    it("deletes the workspace rows on the way down, restores the old shape, and re-widens", async () => {
      await pool.query(`DELETE FROM ${T()} WHERE id <> 'pre-team-dash'`);
      await ensureOverview({ ref: wsRef }, underA);
      await pool.query(
        `INSERT INTO ${L()} (id, dashboard_id, entity_type, entity_id, organization_id, created_by, workspace_read_granted, workspace_read_granted_by, workspace_read_granted_at)
         VALUES ('ws-link', 'pre-team-dash', 'workspace', '__workspace__', $1, 'u', true, 'u-platform', now())
         ON CONFLICT DO NOTHING`,
        [ORG_A],
      );
      await runMigrationSql(pool, workspaceDashboardsDownSql);
      const ws = await pool.query(`SELECT count(*)::int AS n FROM ${T()} WHERE organization_id IS NULL`);
      expect(ws.rows[0].n).toBe(0);
      const links = await pool.query(`SELECT id FROM ${L()} ORDER BY id`);
      expect(links.rows).toEqual([{ id: "pre-link" }]);
      const nullable = await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'dashboards' AND column_name = 'organization_id'`,
        [SCHEMA],
      );
      expect(nullable.rows[0].is_nullable).toBe("NO");
      await runMigrationSql(pool, workspaceDashboardsUpSql);
      const back = await ensureOverview({ ref: wsRef }, underB);
      expect(back.organizationId).toBeNull();
    });
  });
});
