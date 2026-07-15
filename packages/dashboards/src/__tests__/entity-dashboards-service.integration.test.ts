/**
 * Real-Postgres integration proof for the cinatra#700 per-entity multi-dashboard
 * data model + service layer. Drives the ACTUAL mutation service
 * (ensureOverview / createEntityDashboard / listDashboardsForEntity /
 * renameDashboard / deleteEntityDashboard / archiveDashboard) and the REAL
 * coexistence backfill SQL (extracted verbatim from the bootstrap DDL in
 * src/lib/drizzle-store.ts) against a live Postgres — so the behavior the unit
 * suite can't reach (partial UNIQUE indexes, the Overview invariant, the legacy
 * → Overview mapping, name-conflict codes) is verified end-to-end at the DB
 * boundary.
 *
 * GATED: only runs when DASH_DB_IT=1 AND SUPABASE_DB_URL point at a throwaway
 * Postgres (the default CI unit run has neither, so it is skipped — it is NOT
 * part of the green unit gate, mirroring mutation-service-v12-wrap.integration).
 * Run locally:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5439/postgres \
 *   SUPABASE_SCHEMA=cinatra_it_700 DASH_DB_IT=1 \
 *   npx vitest run --no-coverage src/__tests__/entity-dashboards-service.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  archiveDashboard,
  createEntityDashboard,
  deleteEntityDashboard,
  ensureOverview,
  getEntityDashboard,
  listDashboardsForEntity,
  renameDashboard,
  updateDashboard,
  upsertDashboardConfig,
  DashboardOverviewProtectedError,
  DashboardNameConflictError,
  DashboardInvalidEntityError,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";
import type { DashboardEntityRef } from "../store/entity-identity";
// The apiVersion literal via the constant (avoids a bare version token in source).
import { DASHBOARD_CONFIG_V12_VERSION as V12 } from "../extension/dashboard-config-v12";
// The REAL coexistence backfill lives in the versioned migration; pin the test
// to it (no drift) rather than to a hand-copied SQL string.
import { buildEntityOverviewBackfillSql } from "../../../../migrations/core/core__0049_dashboards-entity-overview-backfill.mjs";

const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_it_700";
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;

const actor: DashboardActor = {
  userId: "u-700",
  organizationId: "org-700",
  teamIds: [],
  orgRole: "owner",
  teamRoles: {},
};
const agentsRef: DashboardEntityRef = {
  entityType: "agents",
  entityId: actor.organizationId, // per-org surface: entity_id == organization_id
  ownerLevel: "user",
  ownerId: actor.userId,
};

/** The REAL coexistence backfill, schema-qualified for the throwaway test schema. */
function realBackfillSql(schema: string): string {
  return buildEntityOverviewBackfillSql(schema);
}

async function provision(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
  // dashboards in its POST-#700 shape (the three new columns + CHECKs).
  await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    config_json jsonb NOT NULL,
    config_version text NOT NULL DEFAULT '${V12}',
    dashboard_version integer NOT NULL DEFAULT 1,
    published_revision_number integer,
    owner_level text NOT NULL,
    owner_id text NOT NULL,
    organization_id text NOT NULL,
    visibility text NOT NULL DEFAULT 'private',
    status text NOT NULL DEFAULT 'draft',
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
    is_default boolean NOT NULL DEFAULT false
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
  // The three #700 partial indexes (the DB backstop the service relies on).
  await pool.query(`CREATE UNIQUE INDEX dashboards_entity_default_uniq ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id) WHERE is_default = true AND entity_type IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX dashboards_entity_name_uniq ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id, name) WHERE entity_type IS NOT NULL`);
  await pool.query(`CREATE INDEX dashboards_entity_idx ON "${SCHEMA}".dashboards (organization_id, entity_type, entity_id, owner_level, owner_id) WHERE entity_type IS NOT NULL`);
}

async function truncate(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE "${SCHEMA}".dashboard_revisions, "${SCHEMA}".dashboards, "${SCHEMA}".audit_events`);
}

async function readRow(pool: Pool, id: string) {
  const r = await pool.query(
    `SELECT id, name, entity_type, entity_id, is_default, status FROM "${SCHEMA}".dashboards WHERE id = $1`,
    [id],
  );
  return r.rows[0] as
    | { id: string; name: string; entity_type: string | null; entity_id: string | null; is_default: boolean; status: string }
    | undefined;
}

describe.skipIf(!RUN_IT)("cinatra#700 per-entity dashboards (real Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await provision(pool);
  }, 60_000);

  beforeEach(async () => {
    await truncate(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  // ── Coexistence / compat backfill ───────────────────────────────────────
  it("backfill absorbs a legacy system-<surface> row as the Overview; leaves others untouched; idempotent", async () => {
    const legacyId = `system-agents:${actor.organizationId}:${actor.userId}`;
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, owner_level, owner_id, organization_id, created_by)
       VALUES ($1, 'Agents', '{"apiVersion":"${V12}","scopeLevel":"user","portlets":[]}'::jsonb, 'user', $2, $3, $2)`,
      [legacyId, actor.userId, actor.organizationId],
    );
    // A NON-legacy extension row (must NOT be absorbed — fail-closed).
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, owner_level, owner_id, organization_id, created_by, extension_id, is_template)
       VALUES ('ext-row-1', 'Ext', '{}'::jsonb, 'organization', $1, $1, $2, '@x/y', true)`,
      [actor.organizationId, actor.userId],
    );

    const backfill = realBackfillSql(SCHEMA);
    await pool.query(backfill);

    const mapped = await readRow(pool, legacyId);
    expect(mapped).toMatchObject({
      entity_type: "agents",
      entity_id: actor.organizationId,
      is_default: true,
      name: "Overview",
    });
    const ext = await readRow(pool, "ext-row-1");
    expect(ext?.entity_type).toBeNull();
    expect(ext?.is_default).toBe(false);

    // Idempotent: a second run changes nothing.
    await pool.query(backfill);
    expect(await readRow(pool, legacyId)).toMatchObject({ name: "Overview", is_default: true });
  });

  it("backfill is FAIL-CLOSED: only the exact canonical id on a user row is stamped", async () => {
    const cfg = `'{"apiVersion":"${V12}","scopeLevel":"user","portlets":[]}'::jsonb`;
    const ins = async (id: string, ownerLevel: string, ownerId: string, orgId: string) =>
      pool.query(
        `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, owner_level, owner_id, organization_id, created_by)
         VALUES ($1, 'X', ${cfg}, $2, $3, $4, $3)`,
        [id, ownerLevel, ownerId, orgId],
      );
    // Canonical (should be stamped):
    await ins(`system-agents:${actor.organizationId}:${actor.userId}`, "user", actor.userId, actor.organizationId);
    // Non-canonical (must all stay entity_type NULL):
    await ins("system-agents", "user", actor.userId, actor.organizationId); // 1 segment
    await ins("system-agents:only-two", "user", actor.userId, actor.organizationId); // 2 segments
    // id segments DISAGREE with the row's org/owner columns (corrupt/forged):
    await ins("system-agents:WRONG-ORG:WRONG-USER", "user", actor.userId, actor.organizationId);
    await ins(`system-agents:${actor.organizationId}:${actor.userId}:extra`, "user", actor.userId, actor.organizationId); // 4 segments
    await ins(`system-teams:${actor.organizationId}:${actor.organizationId}`, "organization", actor.organizationId, actor.organizationId); // non-user owner

    await pool.query(realBackfillSql(SCHEMA));

    const stamped = await pool.query(
      `SELECT id FROM "${SCHEMA}".dashboards WHERE entity_type IS NOT NULL ORDER BY id`,
    );
    expect(stamped.rows.map((r) => r.id)).toEqual([
      `system-agents:${actor.organizationId}:${actor.userId}`,
    ]);
  });

  it("ensureOverview COEXISTS with a migrated legacy row (no double-create)", async () => {
    const legacyId = `system-agents:${actor.organizationId}:${actor.userId}`;
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, owner_level, owner_id, organization_id, created_by)
       VALUES ($1, 'Agents', '{"apiVersion":"${V12}","scopeLevel":"user","portlets":[]}'::jsonb, 'user', $2, $3, $2)`,
      [legacyId, actor.userId, actor.organizationId],
    );
    await pool.query(realBackfillSql(SCHEMA));

    const ov = await ensureOverview({ ref: agentsRef }, actor);
    expect(ov.id).toBe(legacyId); // found the migrated row, did not mint a new id
    const list = await listDashboardsForEntity(agentsRef, actor);
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  // ── CRUD + Overview invariants ──────────────────────────────────────────
  it("ensureOverview is idempotent and creates a non-removable default", async () => {
    const first = await ensureOverview({ ref: agentsRef }, actor);
    const second = await ensureOverview({ ref: agentsRef }, actor);
    expect(second.id).toBe(first.id);
    expect(first.isDefault).toBe(true);
    expect(first.name).toBe("Overview");
    expect(first.entityType).toBe("agents");

    await expect(deleteEntityDashboard(first.id, actor)).rejects.toBeInstanceOf(
      DashboardOverviewProtectedError,
    );
    await expect(archiveDashboard(first.id, actor)).rejects.toBeInstanceOf(
      DashboardOverviewProtectedError,
    );
    await expect(renameDashboard(first.id, "Renamed", actor)).rejects.toBeInstanceOf(
      DashboardOverviewProtectedError,
    );
    // Still present + default after the denied mutations.
    expect(await readRow(pool, first.id)).toMatchObject({ is_default: true, status: "draft" });
  });

  it("create → list (Overview first) → rename → delete", async () => {
    await ensureOverview({ ref: agentsRef }, actor);
    const named = await createEntityDashboard({ ref: agentsRef, name: "Zeta" }, actor);
    const also = await createEntityDashboard({ ref: agentsRef, name: "Alpha" }, actor);

    const list = await listDashboardsForEntity(agentsRef, actor);
    expect(list.map((d) => d.name)).toEqual(["Overview", "Alpha", "Zeta"]); // default first, then name

    const renamed = await renameDashboard(named.id, "Zulu", actor);
    expect(renamed.name).toBe("Zulu");

    await deleteEntityDashboard(also.id, actor);
    expect(await getEntityDashboard(also.id, actor)).toBeUndefined();
    const after = await listDashboardsForEntity(agentsRef, actor);
    expect(after.map((d) => d.name)).toEqual(["Overview", "Zulu"]);
  });

  it("a post-migration legacy save (upsertDashboardConfig) births a mapped Overview; no double-create", async () => {
    // The still-live save action path (no pre-existing row — a first save on a
    // fresh install, or AFTER the one-time migration already ran).
    const legacyId = `system-agents:${actor.organizationId}:${actor.userId}`;
    const bareDc = { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } };
    await upsertDashboardConfig(
      legacyId,
      { config: bareDc, name: "Agents", ownerLevel: "user", ownerId: actor.userId, visibility: "private" },
      actor,
    );
    // The row is born mapped: entity_type/entity_id/is_default set, name forced to Overview.
    expect(await readRow(pool, legacyId)).toMatchObject({
      entity_type: "agents",
      entity_id: actor.organizationId,
      is_default: true,
      name: "Overview",
    });
    // listDashboardsForEntity SEES it (not orphaned).
    const listed = await listDashboardsForEntity(agentsRef, actor);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(legacyId);
    // ensureOverview converges on the SAME id — no second dashboard.
    const ov = await ensureOverview({ ref: agentsRef }, actor);
    expect(ov.id).toBe(legacyId);
    expect(await listDashboardsForEntity(agentsRef, actor)).toHaveLength(1);
    // A re-save keeps the mapping + Overview name (idempotent), and the config updates.
    await upsertDashboardConfig(legacyId, { config: bareDc, name: "Agents", ownerLevel: "user", ownerId: actor.userId }, actor);
    expect(await readRow(pool, legacyId)).toMatchObject({ is_default: true, name: "Overview" });
  });

  it("ensureOverview-first then a legacy save resolve to ONE row (id convergence)", async () => {
    const ov = await ensureOverview({ ref: agentsRef }, actor);
    expect(ov.id).toBe(`system-agents:${actor.organizationId}:${actor.userId}`);
    const bareDc = { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } };
    await upsertDashboardConfig(
      ov.id,
      { config: bareDc, name: "Agents", ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    // Still exactly one Overview (ON CONFLICT id → same row; no default-uniq collision).
    const listed = await listDashboardsForEntity(agentsRef, actor);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(ov.id);
    expect(listed[0].isDefault).toBe(true);
  });

  it("upsert stamping is FAIL-CLOSED: a wrong-org / malformed system-* id is never stamped as a default", async () => {
    const bareDc = { portlets: [], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } };
    // Wrong org segment (actor.org is org-700): parsed entityId disagrees → NOT stamped.
    const wrongOrgId = `system-agents:WRONG-ORG:${actor.userId}`;
    await upsertDashboardConfig(
      wrongOrgId,
      { config: bareDc, name: "Bogus", ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    expect(await readRow(pool, wrongOrgId)).toMatchObject({ entity_type: null, is_default: false });
    // Malformed (2-segment) id → NOT stamped.
    const malformedId = "system-agents:only-two";
    await upsertDashboardConfig(
      malformedId,
      { config: bareDc, name: "Bogus2", ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    expect(await readRow(pool, malformedId)).toMatchObject({ entity_type: null, is_default: false });
    // Neither appears in the entity list, and the canonical Overview still forms cleanly.
    const ov = await ensureOverview({ ref: agentsRef }, actor);
    expect(ov.id).toBe(`system-agents:${actor.organizationId}:${actor.userId}`);
    const listed = await listDashboardsForEntity(agentsRef, actor);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(ov.id);
  });

  it("the generic updateDashboard path also enforces the Overview invariant", async () => {
    const ov = await ensureOverview({ ref: agentsRef }, actor);
    // Overview cannot be renamed via the MCP-reachable generic update path.
    await expect(
      updateDashboard(ov.id, { name: "Hacked" }, actor),
    ).rejects.toBeInstanceOf(DashboardOverviewProtectedError);
    // A non-default entity dashboard cannot claim the reserved "Overview" name.
    const named = await createEntityDashboard({ ref: agentsRef, name: "Real" }, actor);
    await expect(
      updateDashboard(named.id, { name: "Overview" }, actor),
    ).rejects.toBeInstanceOf(DashboardInvalidEntityError);
    // A normal rename of a non-default dashboard still works.
    const ok = await updateDashboard(named.id, { name: "Renamed via update" }, actor);
    expect(ok.name).toBe("Renamed via update");
    // Overview name is intact.
    expect(await readRow(pool, ov.id)).toMatchObject({ name: "Overview", is_default: true });
  });

  it("duplicate + reserved names are rejected", async () => {
    await ensureOverview({ ref: agentsRef }, actor);
    await createEntityDashboard({ ref: agentsRef, name: "Dup" }, actor);
    await expect(createEntityDashboard({ ref: agentsRef, name: "Dup" }, actor)).rejects.toBeInstanceOf(
      DashboardNameConflictError,
    );
    await expect(
      createEntityDashboard({ ref: agentsRef, name: "Overview" }, actor),
    ).rejects.toBeInstanceOf(DashboardInvalidEntityError);
    // rename collision too.
    const b = await createEntityDashboard({ ref: agentsRef, name: "Bee" }, actor);
    await expect(renameDashboard(b.id, "Dup", actor)).rejects.toBeInstanceOf(
      DashboardNameConflictError,
    );
  });

  it("the same name is allowed in a DIFFERENT entity (composite scoping)", async () => {
    const artifactsRef: DashboardEntityRef = { ...agentsRef, entityType: "artifacts" };
    await ensureOverview({ ref: agentsRef }, actor);
    await ensureOverview({ ref: artifactsRef }, actor);
    await createEntityDashboard({ ref: agentsRef, name: "Shared" }, actor);
    // Same name under a different entity_type must NOT conflict.
    await expect(
      createEntityDashboard({ ref: artifactsRef, name: "Shared" }, actor),
    ).resolves.toMatchObject({ name: "Shared", entityType: "artifacts" });
    // Each entity lists only its own dashboards.
    expect((await listDashboardsForEntity(agentsRef, actor)).map((d) => d.name).sort()).toEqual([
      "Overview",
      "Shared",
    ]);
  });

  // ── Fail-closed scoping (empty scope → zero rows) ───────────────────────
  it("listDashboardsForEntity is tenant-scoped (a cross-org actor sees zero rows)", async () => {
    await ensureOverview({ ref: agentsRef }, actor);
    await createEntityDashboard({ ref: agentsRef, name: "Private" }, actor);
    const otherOrgActor: DashboardActor = { ...actor, organizationId: "org-OTHER" };
    expect(await listDashboardsForEntity(agentsRef, otherOrgActor)).toEqual([]);
    // getEntityDashboard also fail-closes cross-org (no existence leak).
    const mine = (await listDashboardsForEntity(agentsRef, actor))[0];
    expect(await getEntityDashboard(mine.id, otherOrgActor)).toBeUndefined();
  });

  it("a second default for the same (entity, owner) is impossible (partial UNIQUE backstop)", async () => {
    const ov = await ensureOverview({ ref: agentsRef }, actor);
    // Directly attempt a second is_default row for the same composite → 23505.
    await expect(
      pool.query(
        `INSERT INTO "${SCHEMA}".dashboards (id, name, config_json, owner_level, owner_id, organization_id, created_by, entity_type, entity_id, is_default)
         VALUES ('dupe-default', 'Overview2', '{}'::jsonb, 'user', $1, $2, $1, 'agents', $2, true)`,
        [actor.userId, actor.organizationId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(ov.isDefault).toBe(true);
  });
});
