/**
 * cinatra#4264 slice B1a, DB tier (T8): core__0127 and its bootstrap twins
 * applied to a real Postgres.
 *
 *   - UPGRADE: on tables that already hold rows, `up` adds the four nullable
 *     columns (existing rows read NULL), the snapshot table and both indexes
 *     (valid); a second `up` is a no-op; an INVALID index left by a failed
 *     concurrent build is replaced by a valid one; `down` drops exactly what `up`
 *     added (the snapshot rows with it: DATA-DESTRUCTIVE) and `up` applies again.
 *   - RETENTION: deleting a run (what a template purge does) removes its
 *     snapshot rows through the cascade.
 *   - FRESH INSTALL: the bootstrap leaves give the same columns, table and
 *     index definitions as the upgrade, and replay cleanly.
 *
 * Each arm builds its own throwaway schema with minimal `agent_runs`,
 * `artifact_materializations` and `lifecycle_repair` tables and drops it after.
 *
 * DB-gated: runs only with a real SUPABASE_DB_URL. With
 * X4264_REGENERATE_REALDB=1 a missing database throws instead of skipping.
 *
 * Red at main: the migration module and the bootstrap leaf export do not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { artifactMaterializationLedgerSchemaQueries } from "@/lib/artifact-claim-schema";
import { lifecycleRepairSchemaQueries } from "@/lib/artifacts/artifact-review-gate-schema";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import * as migration from "../../../migrations/core/core__0127_regenerate-step-provenance.mjs";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4264_REGENERATE_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4264 B1a DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const describeDb = HAS_DB ? describe : describe.skip;

const suffix = `${process.pid}_${Date.now()}`;
const UPGRADE = `x4264_up_${suffix}`;
const FRESH = `x4264_fresh_${suffix}`;
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
const NEW_COLUMNS = {
  artifact_materializations: ["verified_step_id"],
  lifecycle_repair: ["regenerate_node_id", "source_artifact_id", "source_representation_revision_id"],
};
const INDEXES = ["artifact_materializations_org_artifact_rev_idx", "lifecycle_repair_successor_idx"];

let client: Client;

async function minimalTables(schema: string) {
  await client.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
  await client.query(`CREATE SCHEMA ${qi(schema)}`);
  await client.query(`CREATE TABLE ${qi(schema)}."agent_runs" (id text PRIMARY KEY, template_id text NOT NULL)`);
  await client.query(
    `CREATE TABLE ${qi(schema)}."artifact_materializations" (id text PRIMARY KEY, org_id text NOT NULL, run_id text NOT NULL,
       path text NOT NULL, artifact_id text, representation_revision_id text)`,
  );
  await client.query(
    `CREATE TABLE ${qi(schema)}."lifecycle_repair" (id text PRIMARY KEY, successor_artifact_id text,
       successor_representation_revision_id text)`,
  );
}

type Pgm = Parameters<typeof migration.up>[0];
let pending: string[] = [];
const pgm: Pgm = {
  sql: (text: string) => { pending.push(text); },
  noTransaction: () => pgm as unknown as ReturnType<Pgm["noTransaction"]>,
};
// `up` declares noTransaction: every statement runs on its own in autocommit,
// which is what the runner does (CREATE INDEX CONCURRENTLY requires it).
async function runMigration(fn: (b: typeof pgm) => void, schema: string) {
  pending = [];
  fn(pgm);
  await client.query(`SET search_path TO ${qi(schema)}`);
  for (const text of pending) await client.query(text);
}

async function columns(schema: string, table: string) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    [schema, table],
  );
  return rows as { column_name: string; data_type: string; is_nullable: string }[];
}

async function indexes(schema: string) {
  const { rows } = await client.query(
    `SELECT c.relname AS name, i.indisvalid AS valid,
            regexp_replace(pg_get_indexdef(i.indexrelid), '"?' || n.nspname || '"?\\.', '', 'g') AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2) ORDER BY c.relname`,
    [schema, INDEXES],
  );
  return rows as { name: string; valid: boolean; def: string }[];
}

async function snapshotFk(schema: string) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'agent_run_step_snapshots' AND c.contype IN ('f','p') ORDER BY c.contype`,
    [schema],
  );
  return rows.map((row: { def: string }) => row.def.replaceAll(`${qi(schema)}.`, "").replaceAll(`${schema}.`, ""));
}

describeDb("core__0127 regenerate step provenance (cinatra#4264 B1a, T8)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    if (!client) return;
    await client.query("RESET search_path").catch(() => undefined);
    for (const schema of [UPGRADE, FRESH]) {
      await client.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`).catch(() => undefined);
    }
    await client.end();
  });

  it("upgrade: up adds nullable columns over existing rows, replays as a no-op, down drops the data, up re-applies", async () => {
    await minimalTables(UPGRADE);
    await client.query(`INSERT INTO ${qi(UPGRADE)}."agent_runs" VALUES ('run-1', 'tmpl-1')`);
    await client.query(`INSERT INTO ${qi(UPGRADE)}."artifact_materializations" VALUES ('m-1', 'org-1', 'run-1', 'materialize_tool', 'a-1', 'r-1')`);
    await client.query(`INSERT INTO ${qi(UPGRADE)}."lifecycle_repair" VALUES ('lr-1', 'a-1', 'r-2')`);

    await runMigration(migration.up, UPGRADE);
    for (const [table, names] of Object.entries(NEW_COLUMNS)) {
      const cols = await columns(UPGRADE, table);
      for (const name of names) {
        expect(cols.find((c) => c.column_name === name)).toMatchObject({ data_type: "text", is_nullable: "YES" });
      }
    }
    const { rows: ledger } = await client.query(`SELECT verified_step_id FROM ${qi(UPGRADE)}."artifact_materializations"`);
    expect(ledger).toEqual([{ verified_step_id: null }]);
    const { rows: repair } = await client.query(
      `SELECT regenerate_node_id, source_artifact_id, source_representation_revision_id FROM ${qi(UPGRADE)}."lifecycle_repair"`,
    );
    expect(repair).toEqual([{ regenerate_node_id: null, source_artifact_id: null, source_representation_revision_id: null }]);
    const built = await indexes(UPGRADE);
    expect(built.map((i) => [i.name, i.valid])).toEqual([
      ["artifact_materializations_org_artifact_rev_idx", true],
      ["lifecycle_repair_successor_idx", true],
    ]);

    // Replay: a no-op.
    await runMigration(migration.up, UPGRADE);
    expect(await indexes(UPGRADE)).toEqual(built);

    // An INVALID index of the same name (a failed concurrent build) is replaced.
    await client.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = ${qi(UPGRADE)}.lifecycle_repair_successor_idx::regclass`).catch(() => undefined);
    const forced = (await indexes(UPGRADE)).find((i) => i.name === "lifecycle_repair_successor_idx");
    if (forced && !forced.valid) {
      await runMigration(migration.up, UPGRADE);
      expect((await indexes(UPGRADE)).find((i) => i.name === "lifecycle_repair_successor_idx")?.valid).toBe(true);
    }

    // Retention: deleting the run removes its snapshot rows (ON DELETE CASCADE).
    await client.query(
      `INSERT INTO ${qi(UPGRADE)}."agent_run_step_snapshots" (org_id, run_id, node_id, inputs_json, inputs_sha256, flow_sha256)
       VALUES ('org-1', 'run-1', 'produce', '{}', 'h', 'f')`,
    );
    await client.query(`DELETE FROM ${qi(UPGRADE)}."agent_runs" WHERE id = 'run-1'`);
    const { rows: left } = await client.query(`SELECT count(*)::int AS n FROM ${qi(UPGRADE)}."agent_run_step_snapshots"`);
    expect(left).toEqual([{ n: 0 }]);

    // Down: DATA-DESTRUCTIVE. The table with its rows, the indexes and the columns go.
    await client.query(`INSERT INTO ${qi(UPGRADE)}."agent_runs" VALUES ('run-2', 'tmpl-1')`);
    await client.query(
      `INSERT INTO ${qi(UPGRADE)}."agent_run_step_snapshots" (org_id, run_id, node_id, inputs_json, inputs_sha256, flow_sha256)
       VALUES ('org-1', 'run-2', 'produce', '{}', 'h', 'f')`,
    );
    await runMigration(migration.down, UPGRADE);
    const { rows: table } = await client.query(`SELECT to_regclass($1) AS t`, [`${qi(UPGRADE)}.agent_run_step_snapshots`]);
    expect(table).toEqual([{ t: null }]);
    expect(await indexes(UPGRADE)).toEqual([]);
    expect((await columns(UPGRADE, "artifact_materializations")).map((c) => c.column_name)).not.toContain("verified_step_id");
    expect((await columns(UPGRADE, "lifecycle_repair")).map((c) => c.column_name)).toEqual(
      ["id", "successor_artifact_id", "successor_representation_revision_id"],
    );

    await runMigration(migration.up, UPGRADE);
    expect((await indexes(UPGRADE)).map((i) => i.valid)).toEqual([true, true]);
  });

  it("fresh install: the bootstrap leaves give the migrated shape and replay cleanly", async () => {
    await minimalTables(FRESH);
    // The real ledger leaf creates the full ledger table, so the minimal one goes.
    await client.query(`DROP TABLE ${qi(FRESH)}."artifact_materializations"`);
    const leaf = [
      ...artifactMaterializationLedgerSchemaQueries(FRESH),
      ...lifecycleRepairSchemaQueries(FRESH).filter((q) => /regenerate_node_id|source_artifact_id|source_representation_revision_id|lifecycle_repair_successor_idx/.test(q.text)),
    ];
    for (const q of leaf) await client.query(q.text);
    for (const q of leaf) await client.query(q.text);

    // The upgrade arm's shape, re-applied for the comparison.
    await minimalTables(UPGRADE);
    await runMigration(migration.up, UPGRADE);
    await client.query("RESET search_path");

    expect(await columns(FRESH, "agent_run_step_snapshots")).toEqual(await columns(UPGRADE, "agent_run_step_snapshots"));
    expect(await columns(FRESH, "lifecycle_repair")).toEqual(await columns(UPGRADE, "lifecycle_repair"));
    const verified = (await columns(FRESH, "artifact_materializations")).find((c) => c.column_name === "verified_step_id");
    expect(verified).toMatchObject({ data_type: "text", is_nullable: "YES" });
    expect(await snapshotFk(FRESH)).toEqual(await snapshotFk(UPGRADE));
    expect((await indexes(FRESH)).map((i) => i.def)).toEqual((await indexes(UPGRADE)).map((i) => i.def));
  });
});
