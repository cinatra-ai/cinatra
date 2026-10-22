/**
 * cinatra#4245 PR A1, DB tier: core__0116 and its bootstrap twin applied to a
 * real Postgres.
 *
 *   - UPGRADE: on a table that already holds a paused run, `up` adds the
 *     columns with that run at generation 0 and no claim, a second `up` is a
 *     no-op, the CHECKs admit exactly the lease shapes, `down` removes only
 *     what `up` added, and `up` applies again after it.
 *   - FRESH INSTALL: the bootstrap leaf gives a schema the same columns and
 *     the same constraint definitions as the upgrade, and replays cleanly.
 *
 * Each arm builds its own throwaway schema with a minimal `agent_runs` and
 * `lifecycle_repair` (the DDL under test only alters them) and drops it after.
 *
 * DB-gated: runs only with CINATRA_DB_INTEGRATION_TESTS=1 and a real
 * SUPABASE_DB_URL. With X4245_PAUSE_CLAIM_REALDB=1 a missing database throws
 * instead of skipping.
 *
 * Red at main: the migration module and the bootstrap leaf export do not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { agentRunPauseClaimSchemaQueries } from "@/lib/agent-run-created-at-schema";
import { lifecycleRepairSchemaQueries } from "@/lib/artifacts/artifact-review-gate-schema";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import * as migration from "../../../migrations/core/core__0116_agent-run-pause-claim.mjs";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4245_PAUSE_CLAIM_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4245 pause claim DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const describeDb = HAS_DB ? describe : describe.skip;

const suffix = `${process.pid}_${Date.now()}`;
const UPGRADE = `x4245_up_${suffix}`;
const FRESH = `x4245_fresh_${suffix}`;
const NEW_COLUMNS = ["pause_claim_expires_at", "pause_claim_phase", "pause_claim_token", "pause_generation"];
const CHECKS = ["agent_runs_pause_claim_phase_chk", "agent_runs_pause_claim_shape_chk"];

let client: Client;

async function minimalTables(schema: string) {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`CREATE TABLE "${schema}"."agent_runs" (id text PRIMARY KEY, status text NOT NULL)`);
  await client.query(`CREATE TABLE "${schema}"."lifecycle_repair" (id text PRIMARY KEY)`);
}

const pgm = { sql: (text: string) => { pending.push(text); } };
let pending: string[] = [];
async function runMigration(fn: (b: typeof pgm) => void, schema: string) {
  pending = [];
  fn(pgm);
  await client.query(`SET search_path TO "${schema}"`);
  for (const text of pending) await client.query(text);
}

async function columns(schema: string, table: string) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
    [schema, table],
  );
  return rows;
}

async function checks(schema: string) {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'agent_runs' AND c.contype = 'c' ORDER BY c.conname`,
    [schema],
  );
  return rows as { conname: string; def: string }[];
}

async function sqlState(text: string, params: unknown[] = []): Promise<string | null> {
  try {
    await client.query(text, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  client = new Client({ connectionString: DB_URL });
  await client.connect();
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const schema of [UPGRADE, FRESH]) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

describeDb("core__0116 on a real database (cinatra#4245)", () => {
  it("upgrades a table holding a paused run to generation 0 with no claim, and a second up changes nothing", async () => {
    await minimalTables(UPGRADE);
    await client.query(`INSERT INTO "${UPGRADE}"."agent_runs" (id, status) VALUES ('run-old', 'pending_approval')`);
    await runMigration(migration.up, UPGRADE);
    const { rows } = await client.query(
      `SELECT pause_generation, pause_claim_token, pause_claim_phase, pause_claim_expires_at FROM "${UPGRADE}"."agent_runs" WHERE id = 'run-old'`,
    );
    expect(rows).toEqual([{ pause_generation: "0", pause_claim_token: null, pause_claim_phase: null, pause_claim_expires_at: null }]);
    const before = { runs: await columns(UPGRADE, "agent_runs"), repair: await columns(UPGRADE, "lifecycle_repair"), checks: await checks(UPGRADE) };
    await runMigration(migration.up, UPGRADE);
    expect({ runs: await columns(UPGRADE, "agent_runs"), repair: await columns(UPGRADE, "lifecycle_repair"), checks: await checks(UPGRADE) }).toEqual(before);
    expect(before.checks.map((row) => row.conname)).toEqual(CHECKS);
    expect(before.repair.find((row) => row.column_name === "paused_run_generation")).toMatchObject({ data_type: "bigint", is_nullable: "YES", column_default: null });
  });

  it.each([
    ["no claim", null, null, null],
    ["a live claim", "tok-a", "claimed", "now() + interval '2 minutes'"],
    ["a send lease", "tok-b", "sending", "now() + interval '1 day'"],
    ["the change-request end mark", "cr:3", "changes_requested", null],
  ])("admits %s", async (_label, token, phase, expiry) => {
    const id = `ok-${phase ?? "none"}`;
    const state = await sqlState(
      `INSERT INTO "${UPGRADE}"."agent_runs" (id, status, pause_generation, pause_claim_token, pause_claim_phase, pause_claim_expires_at)
       VALUES ($1, 'pending_approval', 3, $2, $3, ${expiry ?? "NULL"})`,
      [id, token, phase],
    );
    expect(state).toBeNull();
  });

  it.each([
    ["a token without a phase", "tok", null, "now()"],
    ["a phase without a token", null, "claimed", "now()"],
    ["an unknown phase", "tok", "held", "now()"],
    ["a case-varied phase", "tok", "Claimed", "now()"],
    ["a claim without an expiry", "tok", "claimed", null],
    ["a send without an expiry", "tok", "sending", null],
    ["an end mark with an expiry", "cr:3", "changes_requested", "now()"],
  ])("refuses %s", async (label, token, phase, expiry) => {
    const state = await sqlState(
      `INSERT INTO "${UPGRADE}"."agent_runs" (id, status, pause_claim_token, pause_claim_phase, pause_claim_expires_at)
       VALUES ($1, 'pending_approval', $2, $3, ${expiry ?? "NULL"})`,
      [`bad-${label}`, token, phase],
    );
    expect(state).toBe("23514");
  });

  it("refuses a NULL generation", async () => {
    expect(await sqlState(`INSERT INTO "${UPGRADE}"."agent_runs" (id, status, pause_generation) VALUES ('bad-null-gen', 'running', NULL)`)).toBe("23502");
  });

  it("down removes exactly the five columns and two constraints, keeps the rows, and up applies again", async () => {
    await runMigration(migration.down, UPGRADE);
    expect((await columns(UPGRADE, "agent_runs")).map((row) => row.column_name)).toEqual(["id", "status"]);
    expect((await columns(UPGRADE, "lifecycle_repair")).map((row) => row.column_name)).toEqual(["id"]);
    expect(await checks(UPGRADE)).toEqual([]);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${UPGRADE}"."agent_runs" WHERE id = 'run-old'`);
    expect(rows[0].n).toBe(1);
    await runMigration(migration.up, UPGRADE);
    expect((await checks(UPGRADE)).map((row) => row.conname)).toEqual(CHECKS);
  });

  it("the fresh-install bootstrap gives the same columns and constraint definitions, and replays cleanly", async () => {
    await minimalTables(FRESH);
    const bootstrap = [
      ...agentRunPauseClaimSchemaQueries(FRESH).map((row) => row.text),
      ...lifecycleRepairSchemaQueries(FRESH).map((row) => row.text).filter((text) => text.includes("paused_run_generation")),
    ];
    expect(bootstrap).toHaveLength(4);
    for (let replay = 0; replay < 2; replay += 1) {
      for (const text of bootstrap) await client.query(text);
    }
    const pick = (rows: { column_name: string }[]) => rows.filter((row) => [...NEW_COLUMNS, "paused_run_generation"].includes(row.column_name));
    expect(pick(await columns(FRESH, "agent_runs"))).toEqual(pick(await columns(UPGRADE, "agent_runs")));
    expect(pick(await columns(FRESH, "lifecycle_repair"))).toEqual(pick(await columns(UPGRADE, "lifecycle_repair")));
    expect(await checks(FRESH)).toEqual(await checks(UPGRADE));
  });
});
