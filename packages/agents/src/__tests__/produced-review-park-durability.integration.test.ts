/**
 * cinatra#3007 / #3046 fix leg 12 — THE PARK IS DURABLE STATE, AND NO OTHER
 * WRITER CAN FLIP IT.
 *
 * WHAT THE TENTH GRADED READING LEFT OPEN. The card reached both untouched
 * conversation surfaces 4.3 s and 4.7 s after the gate row and then LEFT AGAIN:
 * 475 of 535 one-second polls card-less, 46 separate absences, longest 55.4 s.
 * Fix leg 11 bounded a LONE false park answer on the client and named the
 * upstream it could not explain: a genuinely parked row answering
 * `producedReviewPark: false`. The predicate read the run's status plus a marker
 * inside the run's own MUTABLE `step_results` JSON, and the route served whatever
 * that answered on the row it happened to read.
 *
 * WHAT THIS FILE MEASURES, on a real database, on a real park:
 *
 *   THE FLIP     — a park written by the real `holdRunForProducedReview`, then
 *                  each SHIPPED writer of `step_results` that can land on a
 *                  parked row, then the REAL route read path
 *                  (`readAgentRunById` → `isParkedOnProducedReview`). Every write
 *                  to the run row in the window is logged by a trigger, so the
 *                  answer names WHICH write flips the park rather than reasoning
 *                  about which one might.
 *   THE POLL     — the same read, once per second across a window (300 s under
 *                  `PARK_POLL_SECONDS`, a short window by default so the file is
 *                  a suite and not a stopwatch), logging status, the park answer
 *                  and the marker's presence per answer.
 *   THE RELEASE  — a park whose `step_results` was overwritten still carries the
 *                  terminal write it owes, and the decision still releases it.
 *
 * RED-FIRST: every proof below fails at the previous head, where the park lived
 * only in `step_results`.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration produced-review-park-durability
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

const TEST_SCHEMA = "cinatra_test_park_durability_3046";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3046-f12";
const USER = "user-3046-f12";
const AUTHORITY = { orgId: ORG, can: () => true };

/** The measurement window. The leg's own run used 300; the suite uses a short one
 *  so a proof is not a stopwatch. Every write driven in the window is driven at a
 *  named second, so the log reads the same at either length. */
const POLL_SECONDS = Number(process.env.PARK_POLL_SECONDS ?? "8");

let hold: typeof import("../run-produced-review-hold");
let store: typeof import("../store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

const WITHHELD = { status: "completed" as const };

async function seedRun(runId: string, status = "running") {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, status, input_params, run_by, step_results)
     VALUES ($1, $2, $3, $4, '{}', $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [runId, `tpl-${randomUUID()}`, ORG, status, USER, JSON.stringify([{ kind: "step", output: "a" }])],
  );
}

/** A produced-outbox row for this run, in whatever state the proof needs. A
 *  `pending` one is production still awaiting orchestration, which is the answer
 *  the hold parks on and the window the working placeholder is drawn for. */
async function seedOutboxRow(runId: string, status = "pending") {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_produced_outbox"
       (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
        producer_run_id, origin_kind, destination_class, continuation_mode,
        continuation_address, status)
     VALUES ($1, $2, $3, $4, 'artifact_produced', 'createSemanticArtifact', $5,
             'agent_produced', 'none', 'async_effects_gated', NULL, $6)`,
    [`ev-${randomUUID()}`, ORG, `art-${randomUUID()}`, `rev-${randomUUID()}`, runId, status],
  );
}

/** Every produced event of this run settles, so the hold's question resolves and
 *  the decision can release the park. */
async function settleProduction(runId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status = 'processed'
       WHERE producer_run_id = $1`,
    [runId],
  );
}

/** The park, through the REAL seam — no hand-written row. */
async function park(runId: string) {
  await seedOutboxRow(runId);
  return hold.holdRunForProducedReview(
    {
      runId,
      orgId: ORG,
      fromStatus: "running",
      stepResults: [{ kind: "wayflow_response", output: "the draft" }],
      withheld: WITHHELD,
      // The drain is the test seam the module documents; a park with nothing
      // orchestrated yet is the shape the placeholder is drawn for.
      drain: async () => {},
    },
    AUTHORITY,
  );
}

/** THE ROUTE'S OWN READ, exactly: one row read, then the pure predicate. */
async function routeAnswer(runId: string) {
  const run = await store.readAgentRunById(runId);
  return {
    status: run?.status ?? null,
    producedReviewPark: run ? hold.isParkedOnProducedReview(run) : false,
    markerPresent: run ? hold.readWithheldTerminal(run.stepResults) !== null : false,
  };
}

async function writeLog(runId: string) {
  const r = await pool(
    `SELECT at, old_status, new_status, old_marker, new_marker
       FROM "${q(TEST_SCHEMA)}"."park_write_log" WHERE run_id = $1 ORDER BY at`,
    [runId],
  );
  return r.rows as Array<{
    at: Date;
    old_status: string;
    new_status: string;
    old_marker: boolean;
    new_marker: boolean;
  }>;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";

  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await c.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DO $$ ") {
        continue;
      }
      if (qy.text.includes("user_slug_move_trg")) continue;
      try {
        await c.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
      }
    }
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    // EVERY WRITE TO THE RUN ROW, CAPTURED. The measurement's own instrument:
    // the log names each UPDATE and what it did to the status and to the marker,
    // so "which write clears the park" is read off the database rather than
    // inferred from the code.
    await c.query(
      `CREATE TABLE "${q(TEST_SCHEMA)}"."park_write_log" (
         id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(),
         run_id text NOT NULL, old_status text, new_status text,
         old_marker boolean, new_marker boolean)`,
    );
    await c.query(
      `CREATE OR REPLACE FUNCTION "${q(TEST_SCHEMA)}".log_park_write() RETURNS trigger AS $fn$
       BEGIN
         INSERT INTO "${q(TEST_SCHEMA)}"."park_write_log"
           (run_id, old_status, new_status, old_marker, new_marker)
         VALUES (NEW.id, OLD.status, NEW.status,
           OLD.step_results IS NOT NULL AND OLD.step_results::jsonb @? '$[*].lifecycle_review_withheld_terminal',
           NEW.step_results IS NOT NULL AND NEW.step_results::jsonb @? '$[*].lifecycle_review_withheld_terminal');
         RETURN NEW;
       END $fn$ LANGUAGE plpgsql`,
    );
    await c.query(
      `CREATE TRIGGER park_write_log_trg AFTER UPDATE ON "${q(TEST_SCHEMA)}"."agent_runs"
       FOR EACH ROW EXECUTE FUNCTION "${q(TEST_SCHEMA)}".log_park_write()`,
    );
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  hold = await import("../run-produced-review-hold");
  store = await import("../store");
  dbMod = await import("../db");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin((c) => c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`));
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox"`);
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."agent_runs"`);
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."park_write_log"`);
});

describe.skipIf(!HAS_DB)("the produced-review park is the park's own durable state", () => {
  it("survives a shipped step_results write that knows nothing about it", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    const outcome = await park(runId);
    expect(outcome.held).toBe(true);

    const parked = await routeAnswer(runId);
    expect(parked).toMatchObject({ status: "pending_approval", producedReviewPark: true });

    // THE WRITE. `updateAgentRunMeta` is the package's own generic patch path,
    // exported from its public index: it sets `step_results` WHOLE, has no status
    // guard, and knows nothing about a marker riding inside the column. It is the
    // shape every other writer of that column has.
    await store.updateAgentRunMeta(runId, { stepResults: [{ kind: "step", output: "progress" }] });

    const after = await routeAnswer(runId);
    // The marker really is gone — the flip is measured, not assumed...
    expect(after.markerPresent).toBe(false);
    // ...and the run is still parked, and still SAYS so.
    expect(after.status).toBe("pending_approval");
    expect(after.producedReviewPark).toBe(true);

    // And the write log names the write that did it.
    const log = await writeLog(runId);
    // The measurement's own readout: every write to this run row in the window.
    console.log(
      `[park-measure] writes=${log.length} ` +
        log.map((r) => `${r.old_status}->${r.new_status} marker ${r.old_marker}->${r.new_marker}`).join(" | "),
    );
    const clearing = log.filter((r) => r.old_marker && !r.new_marker);
    expect(clearing).toHaveLength(1);
    expect(clearing[0]!.old_status).toBe("pending_approval");
    expect(clearing[0]!.new_status).toBe("pending_approval");
  }, 60_000);

  it("never answers false across a one-second poll of the whole park window", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    await park(runId);

    const answers: Array<{ second: number; park: boolean; status: string | null; marker: boolean }> = [];
    let clobberedAt = -1;
    for (let second = 0; second < POLL_SECONDS; second += 1) {
      // A shipped whole-column write lands in the middle of the window, exactly
      // as one lands in the middle of a real park.
      if (second === Math.floor(POLL_SECONDS / 2)) {
        await store.updateAgentRunMeta(runId, { stepResults: [{ kind: "step", output: `t${second}` }] });
        clobberedAt = second;
      }
      const a = await routeAnswer(runId);
      answers.push({ second, park: a.producedReviewPark, status: a.status, marker: a.markerPresent });
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(clobberedAt).toBeGreaterThanOrEqual(0);
    // The marker's own reading DOES go false — that is the upstream fix leg 11
    // named, reproduced here on a real row...
    expect(answers.some((a) => !a.marker)).toBe(true);
    // ...and the park's answer never does.
    const falseAnswers = answers.filter((a) => !a.park);
    console.log(
      `[park-measure] polls=${answers.length} park-true=${answers.filter((a) => a.park).length} ` +
        `park-false=${falseAnswers.length} marker-present=${answers.filter((a) => a.marker).length} ` +
        `marker-absent=${answers.filter((a) => !a.marker).length} clobber-at-second=${clobberedAt}`,
    );
    expect(falseAnswers).toEqual([]);
    expect(answers.every((a) => a.status === "pending_approval")).toBe(true);
    expect(answers).toHaveLength(POLL_SECONDS);
  }, 600_000);

  it("still owes and performs its terminal write after the column's payload is the only copy", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    await park(runId);
    await store.updateAgentRunMeta(runId, { stepResults: [{ kind: "step", output: "progress" }] });

    // Nothing this run produced is pending and no gate is linked, so the decision
    // resolves and the release must perform the withheld terminal write it can no
    // longer find in `step_results`.
    await settleProduction(runId);
    const released = await hold.releaseHeldRun(runId, AUTHORITY);
    expect(released).toEqual({ released: true, terminal: "completed" });

    const after = await routeAnswer(runId);
    expect(after.status).toBe("completed");
    // AND THE PARK IS CLEARED WITH THE TERMINAL WRITE — a terminal row that still
    // carried one would read back as parked, which is the same defect inverted.
    expect(after.producedReviewPark).toBe(false);
    const [row] = (await pool(
      `SELECT produced_review_park FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [runId],
    )).rows as Array<{ produced_review_park: string | null }>;
    expect(row?.produced_review_park).toBeNull();
  }, 60_000);

  it("clears the column on the terminal write that carries a derivation capture", async () => {
    // CONVERGENCE. `transitionRunStatus` takes a SEPARATE delegate when the
    // terminal write carries a derivation-outbox capture, and that delegate
    // commits its own UPDATE naming `status`, `completed_at`, `step_results`,
    // `error` and `started_at` — never the park's column. So the ONE release
    // path a successful WayFlow run actually takes landed `completed` still
    // carrying its park: durable state outliving the status it was a park in,
    // which is the defect this column was added to end, only inverted.
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    await seedOutboxRow(runId);
    await hold.holdRunForProducedReview(
      {
        runId,
        orgId: ORG,
        fromStatus: "running",
        stepResults: [{ kind: "wayflow_response", output: "the draft" }],
        withheld: {
          status: "completed",
          derivationOutbox: {
            orgId: ORG,
            templateId: `tpl-${randomUUID()}`,
            packageVersion: null,
            createdBy: USER,
            content: "the draft",
            contentIsJson: false,
            contentHash: "a".repeat(64),
          },
        },
        drain: async () => {},
      },
      AUTHORITY,
    );
    expect((await routeAnswer(runId)).producedReviewPark).toBe(true);

    await settleProduction(runId);
    expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({ released: true, terminal: "completed" });

    const after = await routeAnswer(runId);
    expect(after.status).toBe("completed");
    expect(after.producedReviewPark).toBe(false);
    const [row] = (await pool(
      `SELECT produced_review_park FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [runId],
    )).rows as Array<{ produced_review_park: string | null }>;
    expect(row?.produced_review_park).toBeNull();
  }, 60_000);

  it("clears both halves on every OTHER exit from the parked status, so no run inherits a park", async () => {
    // CONVERGENCE. `pending_approval` has five legal exits and the release is
    // one of them. A parked run that is STOPPED and then re-driven reaches an
    // ordinary approval — a setup question a person answers — and used to carry
    // the previous attempt's park with it: the route would call that ordinary
    // question a produced-review park, the sweep would select it, and the
    // release could land the OLD attempt's withheld terminal write on it.
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    await park(runId);
    expect((await routeAnswer(runId)).producedReviewPark).toBe(true);

    const { transitionRunStatus } = await import("../run-transition");
    await transitionRunStatus(runId, "pending_approval", "stopped", undefined, AUTHORITY);

    const [row] = (await pool(
      `SELECT status, produced_review_park, step_results FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [runId],
    )).rows as Array<{ status: string; produced_review_park: string | null; step_results: unknown }>;
    expect(row?.status).toBe("stopped");
    // BOTH halves, together — the column-first reader and the legacy-marker
    // fallback must not disagree about a run that is no longer parked.
    expect(row?.produced_review_park).toBeNull();
    expect(
      hold.readWithheldTerminal(
        typeof row?.step_results === "string" ? JSON.parse(row.step_results) : row?.step_results,
      ),
    ).toBeNull();

    // And the re-drive: the same run reaches an ordinary approval (the row is
    // moved directly, so the proof stays about the park and not about dispatch)
    // carrying
    // neither half, so nothing reads it as a produced-review park.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'pending_approval' WHERE id = $1`,
      [runId],
    );
    const reparked = await routeAnswer(runId);
    expect(reparked.status).toBe("pending_approval");
    expect(reparked.producedReviewPark).toBe(false);
    expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
      released: false,
      reason: "not-produced-review-park",
    });
    expect((await hold.listReleasableHeldRuns(50)).map((r) => r.runId)).not.toContain(runId);
  }, 60_000);

  it("keeps first-writer-wins on the park itself", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun(runId);
    await park(runId);
    // A second recovery chain re-enters the already-parked branch carrying a
    // DIFFERENT terminal write. The first one is the one the decision performs.
    await hold.holdRunForProducedReview(
      {
        runId,
        orgId: ORG,
        fromStatus: "pending_approval",
        stepResults: [],
        withheld: { status: "failed", error: "second chain" },
        drain: async () => {},
      },
      AUTHORITY,
    );
    await settleProduction(runId);
    const released = await hold.releaseHeldRun(runId, AUTHORITY);
    expect(released).toEqual({ released: true, terminal: "completed" });
  }, 60_000);

  it("does not claim a template-declared park, which carries neither half", async () => {
    const runId = `run-${randomUUID()}`;
    await seedRun(runId, "pending_approval");
    const answer = await routeAnswer(runId);
    expect(answer.producedReviewPark).toBe(false);
    expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
      released: false,
      reason: "not-produced-review-park",
    });
    expect(await hold.listReleasableHeldRuns(50)).toEqual([]);
  }, 60_000);

  it("still reads a run parked by the previous build, which has the marker and no column", async () => {
    const runId = `run-${randomUUID()}`;
    // Exactly the row shape the previous build wrote: the marker inside
    // step_results, and nothing in the column that did not exist yet.
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
         (id, template_id, org_id, status, input_params, run_by, step_results)
       VALUES ($1, $2, $3, 'pending_approval', '{}', $4, $5)`,
      [
        runId,
        `tpl-${randomUUID()}`,
        ORG,
        USER,
        JSON.stringify([{ kind: "wayflow_response", lifecycle_review_withheld_terminal: { status: "completed" } }]),
      ],
    );
    const answer = await routeAnswer(runId);
    expect(answer.producedReviewPark).toBe(true);
    expect((await hold.listReleasableHeldRuns(50)).map((r) => r.runId)).toContain(runId);
    expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({ released: true, terminal: "completed" });
  }, 60_000);
});
