/**
 * cinatra#3745 — the run outward-action policy migration (core__0120), driven
 * through the REAL core migration runner over this repository's migrations
 * folder, on a real Postgres.
 *
 * The migration is additive: two tables (the run's bound step-tool graph and
 * the burned artifact-review gates) and two nullable columns on the resume
 * outbox (the delivery's claim mark and send witness). Its guard refuses only
 * a database that booted an unreleased draft of this change: such a database
 * carries a ledger row of a draft migration name, and a draft worker may have
 * claimed a paused run before it sent, leaving a claim with no mark.
 *
 *   - a draft database boots only when the operator states that every draft
 *     worker is stopped (CINATRA_3745_DRAFT_DB_ACK=workers-stopped); the
 *     migration cannot check that statement, and only if it is true does no
 *     draft worker claim after the check;
 *   - with that statement, any unmarked claim on a running run refuses the
 *     boot, whether its intent is still delivering or already dead-lettered;
 *   - a database from main is never refused, also when the bootstrap already
 *     created the two tables and the two columns, and the down migration throws;
 *   - every refusal leaves the schema and the ledger exactly as they were.
 *
 * The test never imports the migration module: it runs the runner over the
 * folder, so on a tree without core__0120 the runner completes and the refusal
 * assertions fail on behaviour.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<scratch DSN> \
 *     pnpm exec vitest run src/lib/__tests__/run-outward-action-policy-migration-3745.integration.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { runCoreMigrations } from "@cinatra-ai/migrations";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const ROOT = path.resolve(__dirname, "../../..");
const SCHEMA = "cinatra_test_3745_outward_policy_migration";
const ACK_ENV = "CINATRA_3745_DRAFT_DB_ACK";
const DRAFT_0115 = "core__0115_agent-run-outward-action-policy";
const DRAFT_0116 = "core__0116_resume-intent-run-claim";
const q = (s: string) => s.replaceAll('"', '""');
const T = (table: string) => `"${q(SCHEMA)}"."${table}"`;

/** Every core migration this tree ships, except the one under test. */
function shippedCoreMigrationNames(): string[] {
  return readdirSync(path.join(ROOT, "migrations/core"))
    .filter((f) => /^core__\d{4}_[a-z0-9-]+\.mjs$/.test(f))
    .map((f) => f.replace(/\.mjs$/, ""))
    .filter((name) => !name.startsWith("core__0120_"))
    .sort();
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * A schema that every shipped migration has already run on (ledger only),
 * with the two tables the guard reads in their pre-0120 shape. `draft` adds
 * the ledger rows a draft head left behind.
 */
async function seed(opts: { draft: boolean; draftNames?: string[] }): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(SCHEMA)}" CASCADE`);
    await c.query(`CREATE SCHEMA "${q(SCHEMA)}"`);
    await c.query(`CREATE TABLE ${T("pgmigrations")} (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`);
    await c.query(`CREATE TABLE ${T("agent_runs")} (id text PRIMARY KEY, status text NOT NULL)`);
    await c.query(`CREATE TABLE ${T("artifact_review_resume_outbox")} (
      gate_id text PRIMARY KEY, run_id text NOT NULL, status text NOT NULL, dead_lettered_at timestamptz)`);
    for (const name of shippedCoreMigrationNames()) {
      await c.query(`INSERT INTO ${T("pgmigrations")} (name, run_on) VALUES ($1, now())`, [name]);
    }
    if (opts.draft) {
      const names = opts.draftNames ?? [DRAFT_0115, DRAFT_0116];
      for (const name of names) {
        await c.query(`INSERT INTO ${T("pgmigrations")} (name, run_on) VALUES ($1, now())`, [name]);
      }
      if (names.includes(DRAFT_0116)) {
        // What the draft's own claim migration left: the two nullable columns.
        await c.query(`ALTER TABLE ${T("artifact_review_resume_outbox")} ADD COLUMN run_claimed_at timestamptz`);
        await c.query(`ALTER TABLE ${T("artifact_review_resume_outbox")} ADD COLUMN resume_task_result jsonb`);
      }
    }
  });
}

async function addIntent(row: {
  gateId: string; runStatus: string; status: string; deadLettered?: boolean; claimed?: boolean;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(`INSERT INTO ${T("agent_runs")} (id, status) VALUES ($1, $2)`, [`run-${row.gateId}`, row.runStatus]);
    await c.query(
      `INSERT INTO ${T("artifact_review_resume_outbox")} (gate_id, run_id, status, dead_lettered_at) VALUES ($1, $2, $3, $4)`,
      [row.gateId, `run-${row.gateId}`, row.status, row.deadLettered ? new Date() : null],
    );
    if (row.claimed) {
      await c.query(`UPDATE ${T("artifact_review_resume_outbox")} SET run_claimed_at = now() WHERE gate_id = $1`, [row.gateId]);
    }
  });
}

function migrate(direction: "up" | "down" = "up") {
  return runCoreMigrations({
    connectionString: DB_URL,
    schemaName: SCHEMA,
    rootDir: ROOT,
    direction,
    ...(direction === "down" ? { count: 1 } : {}),
    log: () => {},
  });
}

async function ledgerHas(name: string): Promise<boolean> {
  return withClient(async (c) =>
    (await c.query(`SELECT 1 FROM ${T("pgmigrations")} WHERE name = $1`, [name])).rowCount === 1);
}

/** Every column of every table in the test schema, and the ledger, in order. */
async function snapshot(): Promise<{ columns: string[]; ledger: string[] }> {
  return withClient(async (c) => {
    const cols = await c.query(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 ORDER BY table_name, column_name`,
      [SCHEMA],
    );
    const ledger = await c.query(`SELECT name FROM ${T("pgmigrations")} ORDER BY id`);
    return {
      columns: cols.rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`),
      ledger: ledger.rows.map((r) => r.name),
    };
  });
}

/** The migration is refused with `message`, and the schema and the ledger are unchanged. */
async function expectRefusedUnchanged(message: RegExp): Promise<void> {
  const before = await snapshot();
  await expect(migrate()).rejects.toThrow(message);
  expect(await snapshot()).toEqual(before);
  expect(await ledgerHas(MIGRATION)).toBe(false);
}

/**
 * The two tables as the bootstrap twin (or the draft's first migration)
 * creates them, each with one row, before core__0120 runs.
 */
async function preCreateTables(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`CREATE TABLE ${T("agent_run_outward_action_policies")} (
      run_id text PRIMARY KEY, org_id text NOT NULL, execution_attempt_id text NOT NULL,
      policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE ${T("artifact_review_action_consumptions")} (
      gate_id text PRIMARY KEY, run_id text NOT NULL, org_id text NOT NULL,
      step_id text NOT NULL, tool_identity jsonb NOT NULL,
      executed_source_sha256 text NOT NULL, consumed_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`INSERT INTO ${T("agent_run_outward_action_policies")} (run_id, org_id, execution_attempt_id, policy)
      VALUES ('run-pre', 'org-pre', 'attempt-pre', '{}')`);
    await c.query(`INSERT INTO ${T("artifact_review_action_consumptions")} (gate_id, run_id, org_id, step_id, tool_identity, executed_source_sha256)
      VALUES ('gate-pre', 'run-pre', 'org-pre', 'step-pre', '{}', 'sha-pre')`);
  });
}

async function preCreatedRows(): Promise<{ policies: number; consumptions: number }> {
  return withClient(async (c) => ({
    policies: (await c.query(`SELECT 1 FROM ${T("agent_run_outward_action_policies")} WHERE run_id = 'run-pre'`)).rowCount ?? 0,
    consumptions: (await c.query(`SELECT 1 FROM ${T("artifact_review_action_consumptions")} WHERE gate_id = 'gate-pre'`)).rowCount ?? 0,
  }));
}

async function shape(): Promise<{ tables: string[]; outboxColumns: string[] }> {
  return withClient(async (c) => {
    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1
         AND table_name IN ('agent_run_outward_action_policies', 'artifact_review_action_consumptions') ORDER BY 1`,
      [SCHEMA],
    );
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1
         AND table_name = 'artifact_review_resume_outbox' AND column_name IN ('run_claimed_at', 'resume_task_result') ORDER BY 1`,
      [SCHEMA],
    );
    return { tables: tables.rows.map((r) => r.table_name), outboxColumns: cols.rows.map((r) => r.column_name) };
  });
}

const FULL_SHAPE = {
  tables: ["agent_run_outward_action_policies", "artifact_review_action_consumptions"],
  outboxColumns: ["resume_task_result", "run_claimed_at"],
};
const MIGRATION = "core__0120_run-outward-action-policy-and-resume-claim";

describe.skipIf(!HAS_DB)("core__0120 on the real runner: additive on main, guarded on a draft database", () => {
  let savedAck: string | undefined;
  beforeEach(() => {
    savedAck = process.env[ACK_ENV];
    delete process.env[ACK_ENV];
  });
  afterEach(() => {
    if (savedAck === undefined) delete process.env[ACK_ENV];
    else process.env[ACK_ENV] = savedAck;
  });
  afterAll(async () => {
    await withClient((c) => c.query(`DROP SCHEMA IF EXISTS "${q(SCHEMA)}" CASCADE`));
  });

  it("a database from main: a running run's unclaimed intent is not a draft claim; the migration adds both tables and both columns", async () => {
    await seed({ draft: false });
    await addIntent({ gateId: "main-1", runStatus: "running", status: "delivering" });
    const outcome = await migrate();
    expect(outcome.ranNames).toEqual([MIGRATION]);
    expect(await shape()).toEqual(FULL_SHAPE);
  });

  it("a draft database without the stopped-workers statement is refused before any change", async () => {
    await seed({ draft: true });
    await expectRefusedUnchanged(/core__0120: this database booted an unreleased draft.*CINATRA_3745_DRAFT_DB_ACK=workers-stopped/);
    expect((await shape()).tables).toEqual([]);
  });

  it("a draft database with the statement and an unmarked delivering claim on a running run is refused", async () => {
    await seed({ draft: true });
    await addIntent({ gateId: "draft-delivering", runStatus: "running", status: "delivering" });
    process.env[ACK_ENV] = "workers-stopped";
    await expectRefusedUnchanged(/core__0120: 1 resume intent\(s\) .*no claim mark.*agent_run_stop/);
    expect((await shape()).tables).toEqual([]);
  });

  it("a draft database with the statement and an unmarked DEAD-LETTERED claim on a running run is refused", async () => {
    await seed({ draft: true });
    await addIntent({ gateId: "draft-dead", runStatus: "running", status: "dead_lettered", deadLettered: true });
    process.env[ACK_ENV] = "workers-stopped";
    await expectRefusedUnchanged(/core__0120: 1 resume intent\(s\) .*no claim mark.*agent_run_stop/);
    expect((await shape()).tables).toEqual([]);
  });

  it("a draft database that ran only the first draft migration (no claim columns) is read without error and refused on its unmarked claim", async () => {
    await seed({ draft: true, draftNames: [DRAFT_0115] });
    await addIntent({ gateId: "draft-no-cols", runStatus: "running", status: "delivering" });
    process.env[ACK_ENV] = "workers-stopped";
    await expectRefusedUnchanged(/core__0120: 1 resume intent\(s\)/);
    expect(await shape()).toEqual({ tables: [], outboxColumns: [] });
  });

  it("a draft database with the statement and no unmarked claim on a running run passes; a marked claim, a paused run and a pending or done intent of a running run do not count", async () => {
    await seed({ draft: true });
    await addIntent({ gateId: "draft-marked", runStatus: "running", status: "delivering", claimed: true });
    await addIntent({ gateId: "draft-paused", runStatus: "pending_approval", status: "delivering" });
    await addIntent({ gateId: "draft-done", runStatus: "completed", status: "delivered" });
    // A running run's intent that is neither delivering nor dead-lettered was never claimed by a delivery.
    await addIntent({ gateId: "draft-running-pending", runStatus: "running", status: "pending" });
    await addIntent({ gateId: "draft-running-done", runStatus: "running", status: "done" });
    process.env[ACK_ENV] = "workers-stopped";
    const outcome = await migrate();
    expect(outcome.ranNames).toEqual([MIGRATION]);
    expect(await shape()).toEqual(FULL_SHAPE);
  });

  it("either draft name alone marks a draft database", async () => {
    await seed({ draft: true, draftNames: [DRAFT_0116] });
    await expectRefusedUnchanged(/core__0120: this database booted an unreleased draft/);
    await seed({ draft: true, draftNames: [DRAFT_0115] });
    await expectRefusedUnchanged(/core__0120: this database booted an unreleased draft/);
  });

  it("an ack value other than the exact statement does not count", async () => {
    await seed({ draft: true });
    process.env[ACK_ENV] = "yes";
    await expectRefusedUnchanged(/core__0120: this database booted an unreleased draft/);
  });

  it("a database from main whose bootstrap already created both tables and both columns: the migration passes and keeps their rows", async () => {
    await seed({ draft: false });
    await preCreateTables();
    await withClient(async (c) => {
      await c.query(`ALTER TABLE ${T("artifact_review_resume_outbox")} ADD COLUMN run_claimed_at timestamptz`);
      await c.query(`ALTER TABLE ${T("artifact_review_resume_outbox")} ADD COLUMN resume_task_result jsonb`);
    });
    await addIntent({ gateId: "main-boot", runStatus: "running", status: "delivering" });
    const outcome = await migrate();
    expect(outcome.ranNames).toEqual([MIGRATION]);
    expect(await shape()).toEqual(FULL_SHAPE);
    expect(await preCreatedRows()).toEqual({ policies: 1, consumptions: 1 });
  });

  it("a draft database whose draft migrations created both tables and both columns: with the statement and no unmarked claim it passes and keeps their rows", async () => {
    await seed({ draft: true });
    await preCreateTables();
    await addIntent({ gateId: "draft-pre-marked", runStatus: "running", status: "delivering", claimed: true });
    process.env[ACK_ENV] = "workers-stopped";
    const outcome = await migrate();
    expect(outcome.ranNames).toEqual([MIGRATION]);
    expect(await shape()).toEqual(FULL_SHAPE);
    expect(await preCreatedRows()).toEqual({ policies: 1, consumptions: 1 });
  });

  it("the down migration refuses: dropping burned gates would re-admit them", async () => {
    await seed({ draft: false });
    await migrate();
    await expect(migrate("down")).rejects.toThrow(/outward_action_policy_downgrade_requires_preserved_consumptions/);
    expect(await ledgerHas(MIGRATION)).toBe(true);
  });
});
