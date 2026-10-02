// THE FILL AND THE FILES, AGAINST A REAL POSTGRES (cinatra#2934, lifecycle-b
// W5c) — acceptance item 1, on the tier that can settle it.
//
// Three things only a database can answer, and each is a case below:
//
//   · a fill really SURVIVES the round trip. Its values are JSON inside a text
//     column; an in-memory stand-in would agree with whatever the code claimed,
//     and a driver that mangled the body would look identical until a reader
//     opened the page again;
//   · a SECOND connection — a reload, another tab, the submit running in another
//     request — really reads back the newest fill FOR THAT SCREEN, which is the
//     whole basis of "the fields still show what was sent";
//   · the replay reader's exclusion really still holds in SQL with fill rows on
//     the run, so `/api/agents/runs/[runId]` and `agent_run_messages_list` keep
//     returning exactly what they returned before this slice.
//
// SELF-SKIPS without `SUPABASE_DB_URL`, and THROWS instead of skipping inside
// its own lane (`CINATRA_SCREEN_FILL_REALDB`), because a suite whose only
// failure mode is "skipped" reports success by doing nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const DSN = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2934";
const IN_LANE = process.env.CINATRA_SCREEN_FILL_REALDB === "1";

if (IN_LANE && !DSN) {
  throw new Error(
    "the screen-fill tier needs a real database: set SUPABASE_DB_URL to a scratch Postgres DSN",
  );
}

const maybe = DSN ? describe : describe.skip;

let pool: Pool;
const T = () => `"${SCHEMA}"."agent_run_messages"`;

/** The bootstrap's OWN shape for this table (src/lib/drizzle-store.ts), minus
 *  the agent_runs foreign key this tier does not need a run row for. */
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
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_unique ON ${T()} (run_id, sequence)`,
];

/** The append's own statement pair, issued exactly as the store issues it. */
async function append(
  runId: string,
  role: "user" | "assistant",
  surface: string,
  text: string,
  extra: Record<string, unknown> = {},
  messageType = "window",
) {
  const hw = await pool.query(
    `SELECT max(sequence) AS high_water FROM ${T()} WHERE run_id = $1`,
    [runId],
  );
  const sequence = Number(hw.rows[0]?.high_water ?? 0) + 1;
  await pool.query(
    `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      `${runId}-${sequence}-${Math.random().toString(36).slice(2)}`,
      runId,
      sequence,
      role,
      messageType,
      text,
      JSON.stringify({ messageType: "window", role, surface, text, ...extra }),
    ],
  );
  return sequence;
}

/** The store's own window read, as SQL. */
async function readWindow(p: Pool, runId: string) {
  const res = await p.query(
    `SELECT sequence, role, content, content_json FROM ${T()}
      WHERE run_id = $1 AND message_type = 'window' ORDER BY sequence ASC`,
    [runId],
  );
  return res.rows.map((r) => ({
    sequence: Number(r.sequence),
    role: r.role as string,
    text: r.content as string,
    body: JSON.parse(r.content_json as string) as Record<string, unknown>,
  }));
}

maybe("the fill and the attached files, on a real database", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DSN, max: 4 });
    for (const q of BOOTSTRAP) await pool.query(q);
    await pool.query(`DELETE FROM ${T()} WHERE run_id LIKE 'w5c-%'`);
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM ${T()} WHERE run_id LIKE 'w5c-%'`).catch(() => undefined);
    await pool.end();
  });

  it("a fill survives the round trip verbatim, and is not a bubble", async () => {
    const run = "w5c-round-trip";
    const values = {
      subject: "Quarterly update — Q3",
      body: "Hello,\n\n“Everything” is fine — 100% on track. \\ backslash, 'quote'.",
    };
    await append(run, "assistant", "run-page", "", { fill: { ref: "ref-a", values } });
    const rows = await readWindow(pool, run);
    expect(rows).toHaveLength(1);
    // NOT A BUBBLE: the text column is empty, so the conversation reader skips it.
    expect(rows[0]!.text).toBe("");
    expect(rows[0]!.body.fill).toEqual({ ref: "ref-a", values });
  });

  it("a SECOND connection reads back THIS MESSAGE's fills for that screen", async () => {
    const run = "w5c-second-connection";
    await append(run, "user", "run-page", "make it about Q3", { messageId: "turn-1" });
    await append(run, "assistant", "run-page", "", {
      messageId: "turn-1",
      fill: { ref: "ref-a", values: { subject: "mine, first" } },
    });
    await append(run, "assistant", "run-page", "", {
      messageId: "turn-1",
      fill: { ref: "ref-b", values: { subject: "another screen" } },
    });
    await append(run, "assistant", "run-page", "", {
      messageId: "turn-1",
      fill: { ref: "ref-a", values: { body: "mine, second" } },
    });
    // A SECOND TAB, mid-flight, on the same run.
    await append(run, "assistant", "run-page", "", {
      messageId: "turn-2",
      fill: { ref: "ref-a", values: { subject: "SOMEBODY ELSE'S" } },
    });

    // A RELOAD IS NOT A RE-RENDER: a different pool, a different connection.
    const other = new Pool({ connectionString: DSN, max: 1 });
    try {
      const rows = await readWindow(other, run);
      const mine = rows
        .filter((r) => r.body.messageId === "turn-1")
        .map((r) => r.body.fill as { ref: string; values: Record<string, unknown> } | undefined)
        .filter((f): f is { ref: string; values: Record<string, unknown> } => !!f && f.ref === "ref-a");
      // BOTH of this message's fills, in order — a turn that filled twice left
      // both in the fields, and the press sends what the fields showed.
      expect(mine.map((f) => f.values)).toEqual([
        { subject: "mine, first" },
        { body: "mine, second" },
      ]);
      // And the other tab's fill is not among them.
      expect(JSON.stringify(mine)).not.toContain("SOMEBODY");
    } finally {
      await other.end();
    }
  });

  it("the files stay on the person's own row and read back whole", async () => {
    const run = "w5c-attachments";
    const attachments = [
      { artifactId: "art_1", representationRevisionId: "rev_1", filename: "brief.pdf", size: 4096 },
    ];
    await append(run, "user", "step-by-step", "use the brief I attached", {
      attachments,
      messageId: "turn-1",
    });
    await append(run, "assistant", "step-by-step", "Got it.", { messageId: "turn-1" });
    const rows = await readWindow(pool, run);
    expect(rows[0]!.body.attachments).toEqual(attachments);
    expect(rows[0]!.body.messageId).toBe("turn-1");
    // The ANSWER carries none of its own — the files are the person's.
    expect(rows[1]!.body.attachments).toBeUndefined();
  });

  it("the run's own replay thread still sees none of it", async () => {
    const run = "w5c-replay-exclusion";
    await append(run, "user", "run-page", "fill it in");
    await append(run, "assistant", "run-page", "", {
      fill: { ref: "ref-a", values: { subject: "x" } },
    });
    // A REPLAY row, written the way the run's own thread writes one.
    await append(run, "assistant", "run-page", "the run's own reply", {}, "text");

    const replay = await pool.query(
      `SELECT content FROM ${T()}
        WHERE run_id = $1 AND message_type <> 'window' ORDER BY sequence ASC`,
      [run],
    );
    expect(replay.rows.map((r) => r.content)).toEqual(["the run's own reply"]);
  });

  it("two fills racing for one sequence collide on the index rather than overwriting", async () => {
    const run = "w5c-race";
    await append(run, "assistant", "run-page", "", {
      fill: { ref: "ref-a", values: { subject: "one" } },
    });
    // The SAME sequence, by hand: the unique index is what the append's retry
    // loop depends on, and without it a lost fill would be silent.
    await expect(
      pool.query(
        `INSERT INTO ${T()} (id, run_id, sequence, role, message_type, content, content_json)
         VALUES ($1, $2, 1, 'assistant', 'window', '', '{}')`,
        [`${run}-dup`, run],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
