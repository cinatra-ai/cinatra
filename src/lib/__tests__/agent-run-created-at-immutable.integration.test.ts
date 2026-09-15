/**
 * cinatra#2911 — REAL-Postgres proof that `agent_runs.created_at` is IMMUTABLE
 * after insert.
 *
 * `created_at` is the only record of when a run was REQUESTED. Its insert
 * default is the only legitimate writer; run listings order by it and the
 * requested-to-started interval is derived from it.
 *
 * WHAT WENT WRONG. `buildCreateStoreSchemaQueries` carried, with NO WHERE
 * clause, `UPDATE … agent_runs SET created_at = COALESCE(started_at,
 * completed_at, created_at)` right after the idempotent
 * `ADD COLUMN IF NOT EXISTS created_at`. `ensurePostgresSchema` replays that
 * whole list once per fresh server process, and `started_at` / `completed_at`
 * are populated LATER in a run's life — so every restart recomputed `created_at`
 * from data that did not exist at insert time. A run that had reached `running`
 * came back reporting `started_at` as its creation time; a run that FAILED
 * before it ever started came back reporting `completed_at`, its own END time.
 *
 * THE PROOF IS THE REPLAY. Building the schema once and asserting the SQL text
 * would not have caught this: the statement is only harmful the SECOND time it
 * runs, against rows that have moved on. So every case here seeds a row, runs
 * the bootstrap list AGAIN exactly as a cold init does, and reads the row back.
 *
 * Also proved here, because the fix must not cost the backfill it guards: a
 * database that never had the column still gets it filled (from `started_at`,
 * else `completed_at`, else now()), and the column comes back NOT NULL with its
 * `now()` default and its ordering index.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided — EXCEPT in the
 * dedicated lane, which refuses to skip. Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:created-at-immutable
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { updateAgentRunStatus } from "@cinatra-ai/agents/store";
import { db } from "@cinatra-ai/agents/db";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE =
  process.env.CINATRA_CREATED_AT_IMMUTABLE_REALDB === "1";
const ALLOW_SKIP = process.env.X2911_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the #2911 created_at-immutability lane needs a live Postgres: set " +
      "SUPABASE_DB_URL to a real connection string (it is unset, empty, or the " +
      "unused:unused placeholder). Refusing to skip — a skipped proof that a " +
      "column survives a replay proves nothing. Pass X2911_ALLOW_SKIP=1 to " +
      "skip anyway.",
  );
}

// The schema the dedicated config also hands to packages/agents/src/schema.ts,
// so the store primitive writes into the very schema the replay runs against.
const TEST_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2911";
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;

// Fixed, distinguishable instants. The gap between them is what a rewrite
// destroys, so it is minutes wide rather than milliseconds.
const REQUESTED_AT = new Date("2026-01-05T10:36:09.000Z");
const STARTED_AT = new Date("2026-01-05T10:41:00.000Z");
const ENDED_AT = new Date("2026-01-05T10:53:01.000Z");

let admin: Client;

/** Run the bootstrap list exactly as a fresh server process's cold init does. */
async function replayBootstrap(): Promise<void> {
  for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    await admin.query(stmt.text);
  }
}

/** One template every seeded run points at — agent_runs.template_id is a real FK. */
const TEMPLATE_ID = "tpl-x2911";

async function seedTemplate(): Promise<void> {
  await admin.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, name, description, source_nl, compiled_plan, input_schema, approval_policy, status, package_name, org_id)
     VALUES ($1, 'x2911', 'created_at immutability fixture', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/x2911', 'org-x2911')
     ON CONFLICT (id) DO NOTHING`,
    [TEMPLATE_ID],
  );
}

async function seedRun(row: {
  id: string;
  status: string;
  createdAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}): Promise<void> {
  await admin.query(
    `INSERT INTO ${RUNS} (id, template_id, input_params, status, org_id, created_at, started_at, completed_at)
     VALUES ($1, $2, '{}', $3, $4, $5, $6, $7)`,
    [
      row.id,
      TEMPLATE_ID,
      row.status,
      "org-x2911",
      row.createdAt,
      row.startedAt,
      row.completedAt,
    ],
  );
}

async function readCreatedAt(id: string): Promise<Date | null> {
  const res = await admin.query(
    `SELECT created_at FROM ${RUNS} WHERE id = $1`,
    [id],
  );
  return (res.rows[0]?.created_at ?? null) as Date | null;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await replayBootstrap();
  await seedTemplate();
}, 300_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.end();
});

describeDb("agent_runs.created_at survives a bootstrap replay (cinatra#2911)", () => {
  // One replay for the whole block: the defect is per-row, not per-replay, and
  // three rows in three different states are exactly the three shapes the old
  // COALESCE could reach.
  beforeAll(async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    // Reached `running`: the old backfill collapsed created_at onto started_at.
    await seedRun({
      id: "run-started",
      status: "running",
      createdAt: REQUESTED_AT,
      startedAt: STARTED_AT,
      completedAt: null,
    });
    // FAILED before it ever started: the old backfill collapsed created_at onto
    // completed_at, so the run reported its own end time as its creation time.
    await seedRun({
      id: "run-failed-before-start",
      status: "failed",
      createdAt: REQUESTED_AT,
      startedAt: null,
      completedAt: ENDED_AT,
    });
    // Still queued: unchanged even under the old statement, but only until
    // either column is populated. Pinned so the guard covers it too.
    await seedRun({
      id: "run-pending",
      status: "pending",
      createdAt: REQUESTED_AT,
      startedAt: null,
      completedAt: null,
    });
    await replayBootstrap();
  }, 300_000);

  it("a run that reached `running` keeps the time it was requested", async () => {
    expect(await readCreatedAt("run-started")).toEqual(REQUESTED_AT);
  });

  it("a run that FAILED before starting keeps the time it was requested", async () => {
    const createdAt = await readCreatedAt("run-failed-before-start");
    expect(createdAt).toEqual(REQUESTED_AT);
    // The shape of the original defect, named explicitly.
    expect(createdAt).not.toEqual(ENDED_AT);
  });

  it("a still-queued run keeps the time it was requested", async () => {
    expect(await readCreatedAt("run-pending")).toEqual(REQUESTED_AT);
  });

  it("a second replay changes nothing either — the guard is not a one-shot", async () => {
    await replayBootstrap();
    expect(await readCreatedAt("run-started")).toEqual(REQUESTED_AT);
    expect(await readCreatedAt("run-failed-before-start")).toEqual(REQUESTED_AT);
  });

  it("the column keeps its deployed shape: NOT NULL, DEFAULT now()", async () => {
    const res = await admin.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_runs' AND column_name = 'created_at'`,
      [TEST_SCHEMA],
    );
    expect(res.rows[0]?.is_nullable).toBe("NO");
    expect(String(res.rows[0]?.column_default)).toContain("now()");
  });

  it("an insert that names no created_at still gets one from the database default", async () => {
    await admin.query(
      `INSERT INTO ${RUNS} (id, template_id, input_params, status, org_id)
       VALUES ('run-default', $1, '{}', 'pending', 'org-x2911')`,
      [TEMPLATE_ID],
    );
    const createdAt = await readCreatedAt("run-default");
    expect(createdAt).toBeInstanceOf(Date);
  });
});

describeDb("the terminal write does not touch created_at either (cinatra#2911)", () => {
  // The OTHER candidate writer, ruled out against the real primitive rather
  // than by reading it. `updateAgentRunStatus` is the canonical status/meta
  // write; it stamps `completed_at` on a terminal status and never names
  // `created_at`. This passes today — it pins the invariant so the two writers
  // stay distinguishable, and so a future patch field cannot quietly add one.
  // It writes through the SAME throwaway schema: the dedicated config hands
  // SUPABASE_SCHEMA to packages/agents/src/schema.ts.
  const RUN_ID = "run-terminal-write";

  beforeAll(async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun({
      id: RUN_ID,
      status: "running",
      createdAt: REQUESTED_AT,
      startedAt: STARTED_AT,
      completedAt: null,
    });
  }, 300_000);

  it("failing a run stamps completed_at and leaves created_at alone", async () => {
    await updateAgentRunStatus(
      RUN_ID,
      "failed",
      { error: "x2911 fixture" },
      db as unknown as Parameters<typeof updateAgentRunStatus>[3],
    );
    const res = await admin.query(
      `SELECT created_at, completed_at, status FROM ${RUNS} WHERE id = $1`,
      [RUN_ID],
    );
    expect(res.rows[0]?.status).toBe("failed");
    expect(res.rows[0]?.completed_at).toBeInstanceOf(Date);
    expect(res.rows[0]?.created_at).toEqual(REQUESTED_AT);
  });

  it("and a replay AFTER that terminal write still leaves created_at alone", async () => {
    // The exact sequence from the field report: the run ends, the process
    // restarts, the bootstrap list runs again. This is where the value was lost.
    await replayBootstrap();
    expect(await readCreatedAt(RUN_ID)).toEqual(REQUESTED_AT);
  });
});

describeDb("the backfill still fills a genuinely missing created_at (cinatra#2911)", () => {
  // Runs LAST and mutates the shared schema: it puts the database back into the
  // pre-column state the backfill exists for.
  beforeAll(async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun({
      id: "legacy-started",
      status: "running",
      createdAt: REQUESTED_AT,
      startedAt: STARTED_AT,
      completedAt: null,
    });
    await seedRun({
      id: "legacy-failed",
      status: "failed",
      createdAt: REQUESTED_AT,
      startedAt: null,
      completedAt: ENDED_AT,
    });
    await seedRun({
      id: "legacy-bare",
      status: "pending",
      createdAt: REQUESTED_AT,
      startedAt: null,
      completedAt: null,
    });
    // A database that predates the column, faithfully: the column is gone, and
    // CASCADE takes the ordering index with it.
    await admin.query(`ALTER TABLE ${RUNS} DROP COLUMN created_at CASCADE`);
    await replayBootstrap();
  }, 300_000);

  it("fills from started_at when the run had started", async () => {
    expect(await readCreatedAt("legacy-started")).toEqual(STARTED_AT);
  });

  it("falls back to completed_at when the run never started", async () => {
    expect(await readCreatedAt("legacy-failed")).toEqual(ENDED_AT);
  });

  it("falls back to a real timestamp when the run has neither", async () => {
    const createdAt = await readCreatedAt("legacy-bare");
    expect(createdAt).toBeInstanceOf(Date);
  });

  it("restores NOT NULL and the ordering index the drop took with it", async () => {
    const col = await admin.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_runs' AND column_name = 'created_at'`,
      [TEST_SCHEMA],
    );
    expect(col.rows[0]?.is_nullable).toBe("NO");
    const idx = await admin.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'agent_runs_source_lookup_idx'`,
      [TEST_SCHEMA],
    );
    expect(idx.rowCount).toBe(1);
  });
});
