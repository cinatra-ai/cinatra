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
 *
 * Pre-1 fold (each red at b128ee97): the shape CHECK refuses an orphan expiry
 * (C1/C6); no statement scans agent_runs under ACCESS EXCLUSIVE, and other
 * sessions read and write while VALIDATE scans (C4); a schema name holding
 * both quote characters boots (C5). No CI job runs this file: every DB job
 * pins literal paths and none names it, so its reading is a recorded host run
 * (C2/C9).
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
const LOCKS = `x4245_lk_${suffix}`;
const QUOTED = `x4245_q"u'o_${suffix}`;
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
const NEW_COLUMNS = ["pause_claim_expires_at", "pause_claim_phase", "pause_claim_token", "pause_generation"];
const CHECKS = ["agent_runs_pause_claim_phase_chk", "agent_runs_pause_claim_shape_chk"];

let client: Client;

async function minimalTables(schema: string) {
  await client.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
  await client.query(`CREATE SCHEMA ${qi(schema)}`);
  await client.query(`CREATE TABLE ${qi(schema)}."agent_runs" (id text PRIMARY KEY, status text NOT NULL)`);
  await client.query(`CREATE TABLE ${qi(schema)}."lifecycle_repair" (id text PRIMARY KEY)`);
}

// `up` declares noTransaction; this harness runs every statement on its own in
// autocommit, which is what the runner then does.
// Typed as `up`'s own parameter: node-pg-migrate's noTransaction() returns the
// builder (chainable), so a void stub would not type-check.
type Pgm = Parameters<typeof migration.up>[0];
const pgm: Pgm = {
  sql: (text: string) => { pending.push(text); },
  noTransaction: () => pgm as unknown as ReturnType<Pgm["noTransaction"]>,
};
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

async function validated(schema: string) {
  const { rows } = await client.query(
    `SELECT c.conname, c.convalidated FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'agent_runs' AND c.contype = 'c' ORDER BY c.conname`,
    [schema],
  );
  return rows;
}

/** The relation locks this session holds on <schema>.agent_runs. */
async function heldLocks(schema: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT l.mode FROM pg_locks l
       JOIN pg_class t ON t.oid = l.relation JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted
        AND n.nspname = $1 AND t.relname = 'agent_runs' ORDER BY l.mode`,
    [schema],
  );
  return rows.map((row: { mode: string }) => row.mode);
}

let probeSeq = 0;
/** Can a second session read and write <schema>.agent_runs right now? null = yes, else the SQLSTATE. */
async function otherSession(schema: string): Promise<{ read: string | null; write: string | null }> {
  const other = new Client({ connectionString: DB_URL });
  await other.connect();
  const attempt = async (text: string) => {
    try {
      await other.query(text);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  };
  try {
    await other.query("SET statement_timeout = '1500ms'");
    probeSeq += 1;
    return {
      read: await attempt(`SELECT count(*) FROM ${qi(schema)}."agent_runs"`),
      write: await attempt(`INSERT INTO ${qi(schema)}."agent_runs" (id, status) VALUES ('probe-${probeSeq}', 'running')`),
    };
  } finally {
    await other.end();
  }
}

/** Runs one statement in an open transaction and reads its locks (and, with probe, a second session) before the commit. */
async function holdingLocksOf(schema: string, text: string, probe = true) {
  await client.query("BEGIN");
  try {
    await client.query(text);
    return { locks: await heldLocks(schema), other: probe ? await otherSession(schema) : null };
  } finally {
    await client.query("COMMIT");
  }
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
  for (const schema of [UPGRADE, FRESH, LOCKS, QUOTED]) await client.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
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
    ["an orphan expiry", null, null, "now()"],
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
    expect(bootstrap).toHaveLength(6);
    for (let replay = 0; replay < 2; replay += 1) {
      for (const text of bootstrap) await client.query(text);
    }
    const pick = (rows: { column_name: string }[]) => rows.filter((row) => [...NEW_COLUMNS, "paused_run_generation"].includes(row.column_name));
    expect(pick(await columns(FRESH, "agent_runs"))).toEqual(pick(await columns(UPGRADE, "agent_runs")));
    expect(pick(await columns(FRESH, "lifecycle_repair"))).toEqual(pick(await columns(UPGRADE, "lifecycle_repair")));
    expect(await checks(FRESH)).toEqual(await checks(UPGRADE));
  });

  it("scans agent_runs only in VALIDATE, under SHARE UPDATE EXCLUSIVE, while other sessions read and write", async () => {
    await minimalTables(LOCKS);
    await client.query(`INSERT INTO ${qi(LOCKS)}."agent_runs" (id, status) SELECT 'row-' || g, 'running' FROM generate_series(1, 50) g`);
    pending = [];
    migration.up(pgm);
    const statements = [...pending];
    expect(statements).toHaveLength(6);
    const [columnsAdd, phaseAdd, shapeAdd, phaseValidate, shapeValidate, repairAdd] = statements;
    await client.query(`SET search_path TO ${qi(LOCKS)}`);

    // The column add holds ACCESS EXCLUSIVE, and the probe sees it block.
    const added = await holdingLocksOf(LOCKS, columnsAdd);
    expect(added.locks).toContain("AccessExclusiveLock");
    expect(added.other?.read).toBe("57014");

    // A row the phase CHECK refuses: the NOT VALID adds succeed over it, so
    // they read no row; the VALIDATE refuses it, so the scan happens there.
    await client.query(
      `INSERT INTO ${qi(LOCKS)}."agent_runs" (id, status, pause_claim_token, pause_claim_phase, pause_claim_expires_at)
       VALUES ('stale', 'running', 'tok', 'held', now() + interval '1 hour')`,
    );
    for (const add of [phaseAdd, shapeAdd]) {
      expect((await holdingLocksOf(LOCKS, add, false)).locks).toContain("AccessExclusiveLock");
    }
    expect(await sqlState(phaseValidate)).toBe("23514");
    await client.query(`DELETE FROM ${qi(LOCKS)}."agent_runs" WHERE id = 'stale'`);

    for (const validate of [phaseValidate, shapeValidate]) {
      const held = await holdingLocksOf(LOCKS, validate);
      expect(held.locks).toContain("ShareUpdateExclusiveLock");
      expect(held.locks).not.toContain("AccessExclusiveLock");
      expect(held.other).toEqual({ read: null, write: null });
    }
    await client.query(repairAdd);
    expect(await validated(LOCKS)).toEqual(CHECKS.map((conname) => ({ conname, convalidated: true })));
    expect(await checks(LOCKS)).toEqual(await checks(UPGRADE));
  }, 60_000);

  it("boots a schema whose name holds a double quote and a single quote, and replays cleanly", async () => {
    await minimalTables(QUOTED);
    for (let replay = 0; replay < 2; replay += 1) {
      for (const { text } of agentRunPauseClaimSchemaQueries(QUOTED)) await client.query(text);
    }
    expect(await validated(QUOTED)).toEqual(CHECKS.map((conname) => ({ conname, convalidated: true })));
    expect(await checks(QUOTED)).toEqual(await checks(UPGRADE));
  });
});
