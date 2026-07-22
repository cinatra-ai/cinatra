/**
 * Substrate-backed ATOMICITY kill-tests for the dashboards-artifact twin writer
 * (cinatra#1894 B1b). This is the ONLY thing that can prove the twin is atomic —
 * the no-substrate NOOP path cannot. Drives the REAL mutation-service writers
 * with the REAL host twin registered, against a lane-unique schema on a live
 * Postgres that carries the FULL substrate (objects / resource / representation /
 * graphiti_projection_outbox / artifact_audit / change_set / object_change_event)
 * + the dashboards tables — the schema is stood up from the LIVE migration chain
 * (`buildCreateStoreSchemaQueries`), never hand-invented, and dropped at the end.
 *
 * GATED on TWIN_DB_IT=1 + SUPABASE_DB_URL + a lane-unique SUPABASE_SCHEMA (the
 * default unit run has none, so it is skipped). Run locally:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *   SUPABASE_SCHEMA=twin_it_1894 TWIN_DB_IT=1 \
 *   npx vitest run --no-coverage --exclude '' \
 *     packages/dashboards/src/__tests__/twin-writer-substrate.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createDashboard,
  updateDashboard,
  deleteEntityDashboard,
  createEntityDashboard,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
} from "../twin-writer-seam";
import { dashboardArtifactTwinWriter, DASHBOARD_OBJECT_TYPE } from "@/lib/dashboards/dashboard-artifact-twin-writer";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const RUN = process.env.TWIN_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "twin_it_1894";
if (RUN && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the twin kill-test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;
const d = RUN ? describe : describe.skip;

const actor: DashboardActor = {
  userId: "u-1894",
  organizationId: "org-1894",
  teamIds: ["team-1894"],
  orgRole: "owner",
  teamRoles: { "team-1894": "admin" },
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
  const rows = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "${SCHEMA}"."${table}" WHERE ${where}`, values);
  return Number(rows[0]?.n ?? "0");
}

d("twin writer — substrate atomicity (cinatra#1894 kill-tests)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    // Fresh lane-unique schema; drop any stale one first.
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    // Stand up the FULL schema from the LIVE migration chain (not hand-invented).
    for (const query of buildCreateStoreSchemaQueries(SCHEMA)) {
      await pool.query(query.text, (query as { values?: unknown[] }).values ?? []);
    }
    // The delete path's `buildSoftDeleteObjectQuery` calls `ensurePostgresSchema()`
    // internally, which would otherwise open the sync worker_threads bridge (it
    // hangs under vitest). We just built the identical schema above, so flip its
    // per-thread "already initialized" guard to make that call a fast no-op — the
    // schema is provably ready, exactly the invariant the guard represents.
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  }, 120_000);

  afterAll(async () => {
    resetDashboardArtifactTwinWriter();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  it("HAPPY: create lands the dashboard row AND its full substrate twin atomically", async () => {
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);

    const row = await createDashboard(
      { name: "Kill-test happy", config: bareConfig, ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    const id = row.id;

    // dashboards row.
    expect(await countRows("dashboards", "id = $1", [id])).toBe(1);
    // objects row — type + scope axis copied verbatim, conservative visibility.
    const objects = await q<{ type: string; owner_level: string; owner_id: string; visibility: string; project_id: string | null }>(
      `SELECT type, owner_level, owner_id, visibility, project_id FROM "${SCHEMA}"."objects" WHERE id = $1`,
      [id],
    );
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe(DASHBOARD_OBJECT_TYPE);
    expect(objects[0].owner_level).toBe("user");
    expect(objects[0].owner_id).toBe(actor.userId);
    expect(objects[0].visibility).toBe("private"); // user owner, no project → 'private'
    expect(objects[0].project_id).toBeNull();
    // resource (kind='dashboard'), representation (rev 1, form='dashboard'),
    // audit, outbox all present.
    expect(await countRows("resource", "org_id = $1 AND kind = 'dashboard'", [actor.organizationId])).toBeGreaterThanOrEqual(1);
    const reps = await q<{ revision: number; form: string }>(
      `SELECT revision, form FROM "${SCHEMA}"."representation" WHERE artifact_id = $1`,
      [id],
    );
    expect(reps).toHaveLength(1);
    expect(reps[0].revision).toBe(1);
    expect(reps[0].form).toBe("dashboard");
    expect(await countRows("artifact_audit", "artifact_id = $1", [id])).toBe(1);
    expect(await countRows("graphiti_projection_outbox", "object_id = $1 AND operation = 'upsert'", [id])).toBe(1);
  });

  it("POISONED twin ⇒ the WHOLE tx rolls back (no dashboard row, no objects row)", async () => {
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(async () => {
      throw new Error("substrate boom");
    });

    const before = await countRows("dashboards", "organization_id = $1", [actor.organizationId]);
    await expect(
      createDashboard(
        { name: "Kill-test poisoned", config: bareConfig, ownerLevel: "user", ownerId: actor.userId },
        actor,
      ),
    ).rejects.toThrow(/substrate boom/);
    // No new dashboards row, and no orphaned objects row for the poisoned create.
    expect(await countRows("dashboards", "organization_id = $1", [actor.organizationId])).toBe(before);
    expect(await countRows("objects", "type = $1 AND data->>'dashboardId' IS NOT NULL AND id NOT IN (SELECT id FROM \"" + SCHEMA + "\".dashboards)", [DASHBOARD_OBJECT_TYPE])).toBe(0);
  });

  it("UNREGISTERED seam ⇒ the writer THROWS and writes nothing (fail-closed)", async () => {
    resetDashboardArtifactTwinWriter(); // no twin registered.

    const before = await countRows("dashboards", "organization_id = $1", [actor.organizationId]);
    await expect(
      createDashboard(
        { name: "Kill-test unregistered", config: bareConfig, ownerLevel: "user", ownerId: actor.userId },
        actor,
      ),
    ).rejects.toThrow(/twin writer/i);
    expect(await countRows("dashboards", "organization_id = $1", [actor.organizationId])).toBe(before);
  });

  it("NO-OP object update (D3): representation + audit advance, graphiti outbox does NOT", async () => {
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);

    // A NAMED entity dashboard so a config-only update touches no scope axis.
    const created = await createEntityDashboard(
      { ref: { entityType: "agents", entityId: actor.organizationId, ownerLevel: "user", ownerId: actor.userId }, name: "noop-d3", seedConfig: bareConfig },
      actor,
    );
    const id = created.id;

    // Baseline after create: rev 1, 1 audit, 1 outbox 'upsert'.
    expect(await countRows("representation", "artifact_id = $1", [id])).toBe(1);
    expect(await countRows("artifact_audit", "artifact_id = $1", [id])).toBe(1);
    expect(await countRows("graphiti_projection_outbox", "object_id = $1 AND operation = 'upsert'", [id])).toBe(1);

    // Config-only update — the objects identity row + scope axis are unchanged, so
    // the objects UPSERT change-gate suppresses the outbox, but representation +
    // audit STILL advance.
    await updateDashboard(id, { config: { ...bareConfig, layoutMode: "rows" } }, actor);

    expect(await countRows("representation", "artifact_id = $1", [id])).toBe(2);
    expect(await countRows("artifact_audit", "artifact_id = $1", [id])).toBe(2);
    // STILL only the one create-time outbox 'upsert' — the no-op update emitted none.
    expect(await countRows("graphiti_projection_outbox", "object_id = $1 AND operation = 'upsert'", [id])).toBe(1);
  });

  it("DELETE ⇒ soft-delete tombstone on the twin (deleted_at + delete outbox + change history)", async () => {
    resetDashboardArtifactTwinWriter();
    setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);

    const created = await createEntityDashboard(
      { ref: { entityType: "agents", entityId: actor.organizationId, ownerLevel: "user", ownerId: actor.userId }, name: "delete-me", seedConfig: bareConfig },
      actor,
    );
    const id = created.id;
    expect(await countRows("objects", "id = $1 AND deleted_at IS NULL", [id])).toBe(1);

    await deleteEntityDashboard(id, actor);

    // dashboards row hard-deleted; objects row tombstoned (soft-deleted); a
    // 'delete' outbox op + a change_set/object_change_event were written.
    expect(await countRows("dashboards", "id = $1", [id])).toBe(0);
    expect(await countRows("objects", "id = $1 AND deleted_at IS NOT NULL", [id])).toBe(1);
    expect(await countRows("graphiti_projection_outbox", "object_id = $1 AND operation = 'delete'", [id])).toBe(1);
    expect(await countRows("object_change_event", "object_id = $1 AND operation = 'soft-delete'", [id])).toBe(1);
  });

  it("PARITY: OBJECTS_WRITE_COLUMNS matches the live objects write column set", async () => {
    const { OBJECTS_WRITE_COLUMNS } = await import("@/lib/objects/objects-outbox-cte");
    const cols = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objects'`,
      [SCHEMA],
    );
    const live = new Set(cols.map((c) => c.column_name));
    for (const col of OBJECTS_WRITE_COLUMNS) {
      expect(live.has(col)).toBe(true);
    }
  });
});
