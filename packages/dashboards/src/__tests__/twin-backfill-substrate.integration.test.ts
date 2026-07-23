/**
 * Substrate-backed real-store proof for the B1c artifact-twin BACKFILL
 * (cinatra#1894 / #2006). Seeds pre-existing dashboards with NO twin (a direct
 * INSERT that bypasses the mutation service — exactly a dashboard predating the
 * B1b forward writer #1971), runs the backfill against a live Postgres, and
 * proves: every untwinned dashboard gets a COMPLETE twin under the forward
 * writer's semantics; a re-run is a no-op (idempotent/convergent); a same-id
 * NON-dashboard collision is surfaced and NEVER clobbered; and a twin that lands
 * between the scan and the per-id transaction is skipped (concurrency).
 *
 * GATED on TWIN_DB_IT=1 + SUPABASE_DB_URL + a lane-unique SUPABASE_SCHEMA (the
 * default unit run has none, so it is skipped). Run locally:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *   SUPABASE_SCHEMA=twin_bf_1894 TWIN_DB_IT=1 \
 *   npx vitest run --no-coverage --exclude '' \
 *     packages/dashboards/src/__tests__/twin-backfill-substrate.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  backfillDashboardArtifactTwins,
  createDashboard,
  pairOneUntwinnedDashboardTwin,
  DASHBOARD_TWIN_OBJECT_TYPE,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
} from "../twin-writer-seam";
import {
  dashboardArtifactTwinWriter,
  DASHBOARD_OBJECT_TYPE,
} from "@/lib/dashboards/dashboard-artifact-twin-writer";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const RUN = process.env.TWIN_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "twin_bf_1894";
if (RUN && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the twin-backfill kill-test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;
const d = RUN ? describe : describe.skip;

const ORG = "org-bf1894";
const USER = "u-bf1894";
const TEAM = "t-bf1894";
const PROJECT = "p-bf1894";

const actor: DashboardActor = {
  userId: USER,
  organizationId: ORG,
  teamIds: [TEAM],
  orgRole: "owner",
  teamRoles: { [TEAM]: "admin" },
};

const bareConfig = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

let pool: Pool;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, values);
  return r.rows as T[];
}
async function countRows(table: string, where: string, values: unknown[]): Promise<number> {
  const rows = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM "${SCHEMA}"."${table}" WHERE ${where}`,
    values,
  );
  return Number(rows[0]?.n ?? "0");
}

/** Seed a dashboard row DIRECTLY (bypassing the mutation service) so it has NO
 *  artifact twin — exactly a dashboard predating the B1b forward writer. */
async function seedUntwinned(
  id: string,
  ownerLevel: string,
  ownerId: string,
  projectId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO "${SCHEMA}"."dashboards"
       (id, name, config_json, owner_level, owner_id, organization_id, created_by, project_id)
     VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, $6, $7)`,
    [id, `seed-${id}`, ownerLevel, ownerId, ORG, ownerId, projectId],
  );
}

d("dashboards-artifact twin BACKFILL — substrate proof (cinatra#1894 B1c / #2006)", () => {
  let alreadyTwinnedId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const query of buildCreateStoreSchemaQueries(SCHEMA)) {
      await pool.query(query.text, (query as { values?: unknown[] }).values ?? []);
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);

    // Four pre-existing dashboards across owner tiers, NO twin.
    await seedUntwinned("bf-01-user", "user", USER, null);
    await seedUntwinned("bf-02-team", "team", TEAM, null);
    await seedUntwinned("bf-03-org", "organization", ORG, null);
    await seedUntwinned("bf-04-proj", "user", USER, PROJECT);

    // A same-id COLLISION: a dashboard whose id is already occupied by a
    // NON-dashboard object. The backfill must surface + skip it, never clobber.
    await seedUntwinned("bf-05-collision", "user", USER, null);
    await pool.query(
      `INSERT INTO "${SCHEMA}"."objects" (id, type, data, org_id)
       VALUES ($1, 'some-foreign-object-type', '{"foreign":true}'::jsonb, $2)`,
      ["bf-05-collision", ORG],
    );

    // A dashboard created through the REAL writer — ALREADY twinned; the backfill
    // must leave it entirely untouched (and never scan it).
    const created = await createDashboard(
      { name: "already-twinned", config: bareConfig, ownerLevel: "user", ownerId: USER },
      actor,
    );
    alreadyTwinnedId = created.id;
  }, 120_000);

  // The suite-wide setup file (tests/setup-twin-writer.ts) registers the NOOP
  // twin before each test; re-register the REAL host twin AFTER it (file hooks
  // run after the global setup hook) so the backfill drives real substrate writes.
  beforeEach(() => {
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);
  });

  afterAll(async () => {
    resetDashboardArtifactTwinWriter();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  it("PRE: the four seeded dashboards + the collision have NO dashboard-type twin", async () => {
    for (const id of ["bf-01-user", "bf-02-team", "bf-03-org", "bf-04-proj", "bf-05-collision"]) {
      expect(await countRows("objects", "id = $1 AND type = $2", [id, DASHBOARD_TWIN_OBJECT_TYPE])).toBe(0);
    }
    // The already-twinned dashboard DOES have its twin.
    expect(await countRows("objects", "id = $1 AND type = $2", [alreadyTwinnedId, DASHBOARD_TWIN_OBJECT_TYPE])).toBe(1);
  });

  it("BACKFILL: pairs every untwinned dashboard, surfaces the collision, leaves the twinned one untouched", async () => {
    // Baseline for the already-twinned dashboard — must be byte-stable across the run.
    const repBefore = await countRows("representation", "artifact_id = $1", [alreadyTwinnedId]);
    const audBefore = await countRows("artifact_audit", "artifact_id = $1", [alreadyTwinnedId]);

    // Small batch to exercise multi-batch keyset pagination.
    const result = await backfillDashboardArtifactTwins({ batchSize: 2 });

    expect(result.paired).toBe(4);
    expect(result.collisions).toBe(1);
    expect(result.alreadyTwinned).toBe(0);
    expect(result.gone).toBe(0);
    expect(result.failed).toEqual([]);
    // scanned = the 4 untwinned + the 1 collision (the already-twinned row is
    // excluded by the NOT EXISTS predicate, never scanned).
    expect(result.scanned).toBe(5);

    // Each paired dashboard now has a COMPLETE twin with verbatim axis, the
    // conservative visibility, the 'dashboards-twin' source, and the full
    // resource/representation/audit/outbox set.
    const cases: Array<{ id: string; ownerLevel: string; ownerId: string; projectId: string | null; visibility: string }> = [
      { id: "bf-01-user", ownerLevel: "user", ownerId: USER, projectId: null, visibility: "private" },
      { id: "bf-02-team", ownerLevel: "team", ownerId: TEAM, projectId: null, visibility: "team" },
      { id: "bf-03-org", ownerLevel: "organization", ownerId: ORG, projectId: null, visibility: "organization" },
      { id: "bf-04-proj", ownerLevel: "user", ownerId: USER, projectId: PROJECT, visibility: "private" },
    ];
    for (const c of cases) {
      const objs = await q<{
        type: string; owner_level: string; owner_id: string; visibility: string; project_id: string | null; source: string | null;
      }>(
        `SELECT type, owner_level, owner_id, visibility, project_id, source FROM "${SCHEMA}"."objects" WHERE id = $1`,
        [c.id],
      );
      expect(objs).toHaveLength(1);
      expect(objs[0].type).toBe(DASHBOARD_TWIN_OBJECT_TYPE);
      expect(objs[0].owner_level).toBe(c.ownerLevel);
      expect(objs[0].owner_id).toBe(c.ownerId);
      expect(objs[0].visibility).toBe(c.visibility);
      expect(objs[0].project_id).toBe(c.projectId);
      expect(objs[0].source).toBe("dashboards-twin");

      // resource(kind=dashboard), representation(rev 1, form=dashboard), audit, outbox.
      expect(await countRows("resource", "id = $1 AND kind = 'dashboard'", [`dashboard-resource:${c.id}`])).toBe(1);
      const reps = await q<{ revision: number; form: string }>(
        `SELECT revision, form FROM "${SCHEMA}"."representation" WHERE artifact_id = $1`,
        [c.id],
      );
      expect(reps).toHaveLength(1);
      expect(reps[0].revision).toBe(1);
      expect(reps[0].form).toBe("dashboard");
      const audits = await q<{ action: string; detail: { source?: string } | null }>(
        `SELECT action, detail FROM "${SCHEMA}"."artifact_audit" WHERE artifact_id = $1`,
        [c.id],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe("upsert");
      expect(audits[0].detail?.source).toBe("dashboards-twin");
      expect(await countRows("graphiti_projection_outbox", "object_id = $1 AND operation = 'upsert'", [c.id])).toBe(1);
    }

    // COLLISION: the foreign object at that id is UNTOUCHED — no clobber, no twin.
    const collision = await q<{ type: string; data: { foreign?: boolean } }>(
      `SELECT type, data FROM "${SCHEMA}"."objects" WHERE id = 'bf-05-collision'`,
    );
    expect(collision).toHaveLength(1);
    expect(collision[0].type).toBe("some-foreign-object-type");
    expect(collision[0].data.foreign).toBe(true);
    expect(await countRows("representation", "artifact_id = 'bf-05-collision'", [])).toBe(0);
    expect(await countRows("artifact_audit", "artifact_id = 'bf-05-collision'", [])).toBe(0);

    // ALREADY-TWINNED: byte-stable (no extra representation / audit).
    expect(await countRows("representation", "artifact_id = $1", [alreadyTwinnedId])).toBe(repBefore);
    expect(await countRows("artifact_audit", "artifact_id = $1", [alreadyTwinnedId])).toBe(audBefore);
  });

  it("IDEMPOTENT: a re-run creates nothing new (paired=0; representation/audit stable)", async () => {
    const repBefore = await countRows("representation", "artifact_id = 'bf-01-user'", []);
    const audBefore = await countRows("artifact_audit", "artifact_id = 'bf-01-user'", []);

    const again = await backfillDashboardArtifactTwins({ batchSize: 2 });

    // Only the (still-untwinned-as-dashboard) collision is re-scanned; the four
    // paired rows are now excluded.
    expect(again.paired).toBe(0);
    expect(again.collisions).toBe(1);
    expect(again.scanned).toBe(1);
    expect(again.failed).toEqual([]);

    expect(await countRows("representation", "artifact_id = 'bf-01-user'", [])).toBe(repBefore);
    expect(await countRows("artifact_audit", "artifact_id = 'bf-01-user'", [])).toBe(audBefore);
    // Still exactly one representation revision — no duplicate appended.
    expect(repBefore).toBe(1);
  });

  it("CONCURRENCY: a twin that lands between the scan and the per-id tx is skipped (exactly one pairing)", async () => {
    await seedUntwinned("bf-06-race", "user", USER, null);

    // First pairing (as the sweep would do) → paired.
    expect(await pairOneUntwinnedDashboardTwin("bf-06-race", SCHEMA)).toBe("paired");
    expect(await countRows("representation", "artifact_id = 'bf-06-race'", [])).toBe(1);
    expect(await countRows("artifact_audit", "artifact_id = 'bf-06-race'", [])).toBe(1);

    // Second call models the race: the scan saw it untwinned, but by the time the
    // per-id transaction runs the twin already exists. The in-tx re-check under the
    // advisory lock returns "already" and writes NOTHING — no duplicate revision.
    expect(await pairOneUntwinnedDashboardTwin("bf-06-race", SCHEMA)).toBe("already");
    expect(await countRows("representation", "artifact_id = 'bf-06-race'", [])).toBe(1);
    expect(await countRows("artifact_audit", "artifact_id = 'bf-06-race'", [])).toBe(1);

    // And the collision id, driven directly, is refused (never clobbered).
    expect(await pairOneUntwinnedDashboardTwin("bf-05-collision", SCHEMA)).toBe("collision");
    expect(await countRows("representation", "artifact_id = 'bf-05-collision'", [])).toBe(0);
  });

  it("GONE: a dashboard that vanished between the scan and the per-id tx yields 'gone', writes nothing", async () => {
    expect(await pairOneUntwinnedDashboardTwin("bf-does-not-exist", SCHEMA)).toBe("gone");
    expect(await countRows("objects", "id = 'bf-does-not-exist'", [])).toBe(0);
    expect(await countRows("representation", "artifact_id = 'bf-does-not-exist'", [])).toBe(0);
  });

  it("FAILURE ISOLATION: a per-dashboard pairing throw is captured, the run continues", async () => {
    // Two fresh untwinned dashboards; a twin writer that always throws.
    await seedUntwinned("bf-08-fail-a", "user", USER, null);
    await seedUntwinned("bf-08-fail-b", "user", USER, null);
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(async () => {
      throw new Error("boom-backfill");
    });

    // The run must NOT throw — each failure is isolated + recorded.
    const result = await backfillDashboardArtifactTwins({ batchSize: 1 });

    const failedIds = result.failed.map((f) => f.id).sort();
    expect(failedIds).toContain("bf-08-fail-a");
    expect(failedIds).toContain("bf-08-fail-b");
    expect(result.failed.every((f) => /boom-backfill/.test(f.error))).toBe(true);
    expect(result.paired).toBe(0);
    // Nothing partially written for a failed dashboard (the throw rolled its tx back).
    expect(await countRows("objects", "id = 'bf-08-fail-a' AND type = $1", [DASHBOARD_TWIN_OBJECT_TYPE])).toBe(0);
    expect(await countRows("objects", "id = 'bf-08-fail-b' AND type = $1", [DASHBOARD_TWIN_OBJECT_TYPE])).toBe(0);
    // The collision is still merely surfaced (its in-tx path never calls the
    // throwing writer), proving the run reached beyond the first failure.
    expect(result.collisions).toBe(1);
  });

  it("DRIFT GUARD: the package twin-type constant equals the host DASHBOARD_OBJECT_TYPE", () => {
    expect(DASHBOARD_TWIN_OBJECT_TYPE).toBe(DASHBOARD_OBJECT_TYPE);
  });
});
