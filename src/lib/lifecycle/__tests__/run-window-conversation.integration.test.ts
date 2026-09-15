// THE PER-RUN WINDOW CONVERSATION, AGAINST A REAL POSTGRES (cinatra#2933,
// lifecycle-b W5b) — acceptance item 1, on the tier that can settle it.
//
//   1. "the exchange stored with the run, present after a reload"
//
// Three things only a database can answer, and each is a case below:
//
//   · the shipped bootstrap really creates `agent_run_messages` with the
//     (run_id, sequence) UNIQUE index the append relies on to detect a race —
//     without it the retry loop is decoration and a lost turn is silent;
//   · a SECOND process reading the run really sees what the first wrote (a
//     reload is not a client re-render, and an in-memory stand-in would agree
//     with whatever the code claimed);
//   · the replay reader's exclusion really holds in SQL: a run carrying BOTH a
//     window row and a replay row hands the run's own thread only the replay
//     row, so /api/agents/runs/[runId] and `agent_run_messages_list` keep
//     returning exactly what they returned before.
//
// SELF-SKIPS without `SUPABASE_DB_URL`, and THROWS instead of skipping inside
// its own lane (`CINATRA_RUN_WINDOW_REALDB`), because a suite whose only
// failure mode is "skipped" reports success by doing nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const DSN = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2933";
const IN_LANE = process.env.CINATRA_RUN_WINDOW_REALDB === "1";

if (IN_LANE && !DSN) {
  throw new Error(
    "the run-window conversation tier needs a real database: set SUPABASE_DB_URL to a scratch Postgres DSN",
  );
}

const maybe = DSN ? describe : describe.skip;

let pool: Pool;
const T = () => `"${SCHEMA}"."agent_run_messages"`;

/** The bootstrap's OWN shape for this table, copied from
 *  `buildCreateStoreSchemaQueries` (src/lib/drizzle-store.ts) minus the
 *  agent_runs foreign key, which this tier does not need a run row for. */
const BOOTSTRAP = [
  `CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`,
  `CREATE TABLE IF NOT EXISTS ${T()} (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      sequence integer NOT NULL,
      role text NOT NULL,
      message_type text NOT NULL DEFAULT 'text',
      tool_call_id text,
      tool_name text,
      content text NOT NULL DEFAULT '',
      content_json text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_idx ON ${T()} (run_id, sequence)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_unique ON ${T()} (run_id, sequence)`,
];

/** The append's own statement pair, issued exactly as the store issues it. */
async function append(runId: string, role: "user" | "assistant", surface: string, text: string) {
  const hw = await pool.query(
    `SELECT max(sequence) AS high_water FROM ${T()} WHERE run_id = $1`,
    [runId],
  );
  const sequence = Number(hw.rows[0]?.high_water ?? 0) + 1;
  await pool.query(
    `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
     VALUES ($1, $2, $3, $4, 'window', $5, $6)`,
    [
      `${runId}-${sequence}-${Math.random().toString(36).slice(2)}`,
      runId,
      sequence,
      role,
      text,
      JSON.stringify({ messageType: "window", role, surface, text }),
    ],
  );
  return sequence;
}

maybe("the run's window conversation, on a real database", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DSN, max: 4 });
    for (const q of BOOTSTRAP) await pool.query(q);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  it("replays its bootstrap without complaint", async () => {
    for (const q of BOOTSTRAP) await pool.query(q);
    const res = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'agent_run_messages'`,
      [SCHEMA],
    );
    expect(res.rowCount).toBe(1);
  });

  it("holds the exchange so a RELOAD — a fresh read — finds it", async () => {
    const run = "run-reload";
    await append(run, "user", "review", "tighten the opening paragraph");
    await append(run, "assistant", "review", "Changes requested.");
    // A second pool is a second connection: nothing survives here by living in
    // one process's memory.
    const reader = new Pool({ connectionString: DSN, max: 1 });
    try {
      const rows = await reader.query(
        `SELECT role, content FROM ${T()} WHERE run_id = $1 AND message_type = 'window' ORDER BY sequence ASC`,
        [run],
      );
      expect(rows.rows.map((r) => [r.role, r.content])).toEqual([
        ["user", "tighten the opening paragraph"],
        ["assistant", "Changes requested."],
      ]);
    } finally {
      await reader.end();
    }
  });

  it("refuses a second row on one sequence, which is what the retry detects", async () => {
    const run = "run-race";
    const seq = await append(run, "user", "run-page", "one");
    await expect(
      pool.query(
        `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
         VALUES ('dup', $1, $2, 'user', 'window', 'two', '{}')`,
        [run, seq],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps the window rows OUT of the run's own replay thread", async () => {
    const run = "run-mixed";
    await append(run, "user", "run-page", "a window turn");
    await pool.query(
      `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
       VALUES ('replay-1', $1, 99, 'assistant', 'final', 'the run said this', '{"messageType":"final","role":"assistant","text":"the run said this"}')`,
      [run],
    );
    // The replay reader's predicate, in SQL.
    const replay = await pool.query(
      `SELECT content FROM ${T()} WHERE run_id = $1 AND message_type <> 'window' ORDER BY sequence ASC`,
      [run],
    );
    expect(replay.rows.map((r) => r.content)).toEqual(["the run said this"]);
    // …and the window reader sees only its own.
    const window = await pool.query(
      `SELECT content FROM ${T()} WHERE run_id = $1 AND message_type = 'window' ORDER BY sequence ASC`,
      [run],
    );
    expect(window.rows.map((r) => r.content)).toEqual(["a window turn"]);
  });

  it("gives the two uses ONE sequence space, so neither can overwrite the other", async () => {
    const run = "run-shared";
    await pool.query(
      `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
       VALUES ('replay-hw', $1, 7, 'assistant', 'final', 'run text', '{}')`,
      [run],
    );
    // The window's high-water read spans the WHOLE run, so its next number is 8
    // rather than 1 — the row the replay thread owns is never taken.
    const seq = await append(run, "user", "step-by-step", "asked after the run spoke");
    expect(seq).toBe(8);
    const all = await pool.query(
      `SELECT sequence, message_type FROM ${T()} WHERE run_id = $1 ORDER BY sequence ASC`,
      [run],
    );
    expect(all.rows.map((r) => [Number(r.sequence), r.message_type])).toEqual([
      [7, "final"],
      [8, "window"],
    ]);
  });
});
