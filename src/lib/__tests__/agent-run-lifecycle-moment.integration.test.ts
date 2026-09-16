/**
 * THE LIFECYCLE MOMENT TRIPLE, ON A REAL DATABASE (cinatra#2928, epic #2926 W2a).
 *
 * A run RECORDS which lifecycle moment it is waiting at, which card that moment
 * mounts and the card's server-checked reference. Three things have to be true
 * of that, and none of them can be shown against a stub:
 *
 *   1. THE BOOTSTRAP REALLY PRODUCES THE COLUMNS. They ship through the
 *      idempotent bootstrap alone — no numbered migration — so what the
 *      bootstrap builds IS the schema. Asserting the SQL text would only prove
 *      the file agrees with itself.
 *   2. IT IS ADDITIVE, AND SURVIVES A REPLAY. The bootstrap list is replayed
 *      once per fresh server process. A run that already states a moment must
 *      still state it afterwards, and a table that predates the columns must
 *      gain them with every existing row reading NULL — "no recorded moment",
 *      which is what every surface already does with a run it cannot name.
 *   3. THE WRITER WRITES ALL THREE, AND CLEARS ALL THREE. A card kind left
 *      behind by a moment that is over is a card a host would still mount, so
 *      clearing is all-or-nothing.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided — EXCEPT in the
 * dedicated lane, which refuses to skip. Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-moment
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { agentRunLifecycleMomentSchemaQueries } from "@/lib/agent-run-lifecycle-moment-schema";
// THE REAL WRITER, and the real entries. This suite used to write the triple
// with its own UPDATE, which proved the COLUMNS work and nothing about the
// code: a production writer that had become a no-op would have passed it.
import { recordRunLifecycleMoment } from "@cinatra-ai/agents/store";
import {
  advanceAgentRun,
  clearRunLifecycleMoment,
  onReviewedWorkChanged,
} from "@cinatra-ai/agents/lifecycle-coordinator";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_LIFECYCLE_MOMENT_REALDB === "1";
const ALLOW_SKIP = process.env.X2928_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the #2928 lifecycle-moment lane needs a live Postgres: set SUPABASE_DB_URL " +
      "to a real connection string (it is unset, empty, or the unused:unused " +
      "placeholder). Refusing to skip — a skipped proof that a column exists " +
      "proves nothing. Pass X2928_ALLOW_SKIP=1 to skip anyway.",
  );
}

const TEST_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2928";
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;

const TEMPLATE_ID = "tpl-x2928";
const ORG_ID = "org-x2928";

let admin: Client;

/**
 * The write authority these calls carry.
 *
 * BUILT HERE, not minted. The mint helpers are named consumers behind the
 * org-write boundary gate, and widening that allowlist for a test would trade a
 * real perimeter for a convenience. The authority interface is what the kernel
 * checks — an org and a capability answer — and the kernel then re-reads the
 * organization itself, which is why this suite seeds a real one and why a
 * missing org still refuses. Nothing here weakens the guard: the write goes
 * through `guardedRunWrite` exactly as production does.
 */
function writeAuthority() {
  return {
    orgId: ORG_ID,
    can: (capability: string) => capability === "run.execute",
  } as unknown as Parameters<typeof recordRunLifecycleMoment>[1];
}

/** Run the bootstrap list exactly as a fresh server process's cold init does. */
async function replayBootstrap(): Promise<void> {
  for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    await admin.query(stmt.text);
  }
}

/**
 * The organization the guarded writer re-reads.
 *
 * The write perimeter refuses an org it cannot find — correctly, and that is
 * why this suite seeds a real one rather than mocking the guard away. The row
 * lives in the Better Auth `public` schema, outside the throwaway app schema
 * this tier builds and drops, so it is created idempotently and left alone.
 */
async function seedOrganization(): Promise<void> {
  await admin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt")
     VALUES ($1, 'x2928', $1, now())
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID],
  );
}

async function seedTemplate(): Promise<void> {
  await admin.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, name, description, source_nl, compiled_plan, input_schema, approval_policy, status, package_name, org_id)
     VALUES ($1, 'x2928', 'lifecycle moment fixture', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/x2928', $2)
     ON CONFLICT (id) DO NOTHING`,
    [TEMPLATE_ID, ORG_ID],
  );
}

async function seedRun(id: string, status = "pending_input"): Promise<void> {
  await admin.query(
    `INSERT INTO ${RUNS} (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', $3, $4)`,
    [id, TEMPLATE_ID, status, ORG_ID],
  );
}

type Triple = {
  lifecycle_moment: string | null;
  lifecycle_card_kind: string | null;
  lifecycle_card_ref: string | null;
};

async function readTriple(id: string): Promise<Triple | null> {
  const res = await admin.query(
    `SELECT lifecycle_moment, lifecycle_card_kind, lifecycle_card_ref FROM ${RUNS} WHERE id = $1`,
    [id],
  );
  return (res.rows[0] ?? null) as Triple | null;
}

/** Write the triple through the PRODUCTION writer, guarded exactly as it is. */
async function writeTriple(
  id: string,
  moment: string | null,
  cardKind: string | null,
  cardRef: string | null,
): Promise<void> {
  await recordRunLifecycleMoment(
    { runId: id, orgId: ORG_ID, moment, cardKind, cardRef },
    writeAuthority(),
  );
}

/**
 * Put a moment on a row WITHOUT the writer.
 *
 * For the cases that are about the SCHEMA — a replay, a table that never had
 * the columns — where routing through the writer would only add a second thing
 * that could be the reason a case failed.
 */
async function seedTriple(
  id: string,
  moment: string | null,
  cardKind: string | null,
  cardRef: string | null,
): Promise<void> {
  await admin.query(
    `UPDATE ${RUNS} SET lifecycle_moment = $2, lifecycle_card_kind = $3, lifecycle_card_ref = $4 WHERE id = $1`,
    [id, moment, cardKind, cardRef],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await replayBootstrap();
  await seedOrganization();
  await seedTemplate();
}, 300_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.end();
});

describeDb("the bootstrap builds the moment triple (cinatra#2928)", () => {
  it("creates all three columns, nullable, on agent_runs", async () => {
    const res = await admin.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_runs'
          AND column_name IN ('lifecycle_moment','lifecycle_card_kind','lifecycle_card_ref')
        ORDER BY column_name`,
      [TEST_SCHEMA],
    );
    expect(res.rows.map((r) => r.column_name)).toEqual([
      "lifecycle_card_kind",
      "lifecycle_card_ref",
      "lifecycle_moment",
    ]);
    for (const row of res.rows) {
      expect(row.data_type, row.column_name).toBe("text");
      // NULLABLE is the whole additive story: every row that predates the
      // columns reads "no recorded moment", which is the behaviour every
      // surface already has.
      expect(row.is_nullable, row.column_name).toBe("YES");
    }
  });

  it("creates the partial index, narrowed to rows that state a moment", async () => {
    const res = await admin.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'agent_runs'
          AND indexname = 'agent_runs_lifecycle_moment_idx'`,
      [TEST_SCHEMA],
    );
    expect(res.rows).toHaveLength(1);
    const def = String(res.rows[0].indexdef);
    expect(def).toContain("lifecycle_moment");
    expect(def).toMatch(/WHERE \(?lifecycle_moment IS NOT NULL\)?/);
    // NON-UNIQUE, deliberately: many runs sit at the same moment at once, and a
    // unique index here would be an outage rather than a constraint.
    expect(def).not.toContain("UNIQUE");
  });

  it("adds NO numbered migration — the columns are additive and ship in the bootstrap", () => {
    // The leaf is the whole schema change. Stated here because the alternative
    // (a migration twin) is what a DESTRUCTIVE change would need, and reading
    // this suite should tell you which of the two this was.
    const stmts = agentRunLifecycleMomentSchemaQueries(TEST_SCHEMA).map((s) => s.text);
    expect(stmts).toHaveLength(4);
    for (const stmt of stmts) {
      expect(stmt).toMatch(/IF NOT EXISTS/);
      // Nothing here writes to an existing row. That is what makes it additive.
      expect(stmt).not.toMatch(/\bUPDATE\b|\bDROP\b|\bSET NOT NULL\b/);
    }
  });
});

describeDb("a stated moment survives a bootstrap replay", () => {
  it("keeps the triple a run already carries", async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-replay");
    await seedTriple("run-replay", "hitl", "agent_hitl_screen", "gate-7");

    // Exactly what a cold init does — the list runs again, whole.
    await replayBootstrap();

    expect(await readTriple("run-replay")).toEqual({
      lifecycle_moment: "hitl",
      lifecycle_card_kind: "agent_hitl_screen",
      lifecycle_card_ref: "gate-7",
    });
  });

  it("gives a table that never had the columns them, with every row reading NULL", async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    // A database from before this change: the columns are gone and a run
    // predates them.
    await admin.query(
      `ALTER TABLE ${RUNS}
         DROP COLUMN lifecycle_moment,
         DROP COLUMN lifecycle_card_kind,
         DROP COLUMN lifecycle_card_ref`,
    );
    await seedRun("run-pre-existing", "running");

    await replayBootstrap();

    expect(await readTriple("run-pre-existing")).toEqual({
      lifecycle_moment: null,
      lifecycle_card_kind: null,
      lifecycle_card_ref: null,
    });
  });
});

describeDb("the writer states and clears the triple together", () => {
  it("writes all three, and reads them back as written", async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-states");

    await writeTriple("run-states", "review", "artifact_review_gate", "review-42");

    expect(await readTriple("run-states")).toEqual({
      lifecycle_moment: "review",
      lifecycle_card_kind: "artifact_review_gate",
      lifecycle_card_ref: "review-42",
    });
  });

  it("a release the CALLER dispatches leaves the clear to that caller", async () => {
    // The clear belongs with the answer about whether the run really got a job.
    // Under `caller_dispatches` that answer is one frame out, so the release
    // moves the run and states nothing: a clear made here would be lost the
    // moment the caller's own compensation put the run back at its wait, and
    // the run would come back to a park with no card.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-cleared", "pending_input");
    await writeTriple("run-cleared", "schedule", "trigger_schedule_proposal", "sched-9");

    const answer = await advanceAgentRun({
      run: { id: "run-cleared", orgId: ORG_ID, status: "pending_input" },
      release: {
        reason: "continue",
        from: "pending_input",
        to: "queued",
        dispatch: { kind: "caller_dispatches", why: "this suite is about the row, not the queue" },
      },
      authority: writeAuthority(),
    });

    expect(answer.moment).toBeNull();
    const res = await admin.query(`SELECT status FROM ${RUNS} WHERE id = $1`, ["run-cleared"]);
    expect(res.rows[0].status).toBe("queued");
    // Released — and still saying what it was waiting at, because nothing has
    // yet told it the dispatch succeeded.
    expect((await readTriple("run-cleared"))?.lifecycle_moment).toBe("schedule");

    // …and the caller's own clear, once it has dispatched, takes all three.
    await clearRunLifecycleMoment("run-cleared", writeAuthority());
    expect(await readTriple("run-cleared")).toEqual({
      lifecycle_moment: null,
      lifecycle_card_kind: null,
      lifecycle_card_ref: null,
    });
  });

  it("a caller's clear takes off the moment it SAW, and nothing newer", async () => {
    // Between the read and the write a run can be released and parked again at
    // something else. A clear that ignored which moment it was removing would
    // take the newer card straight back off.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-reparked", "pending_approval");
    await writeTriple("run-reparked", "hitl", "agent_hitl_screen", "gate-new");

    // The moment the caller is trying to clear is not the one on the row.
    await recordRunLifecycleMoment(
      { runId: "run-reparked", orgId: ORG_ID, moment: null, onlyWhileMoment: "schedule" },
      writeAuthority(),
    );

    expect(await readTriple("run-reparked")).toEqual({
      lifecycle_moment: "hitl",
      lifecycle_card_kind: "agent_hitl_screen",
      lifecycle_card_ref: "gate-new",
    });
  });

  it("a clear still fires on a run a worker has already picked up", async () => {
    // The case a status-pinned clear got wrong. A released run is `running`
    // within moments, and its schedule moment is just as over as it was the
    // instant before — a clear that missed it would leave a card on a working
    // run.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-working", "running");
    await writeTriple("run-working", "schedule", "trigger_schedule_proposal", "sched-w");

    await clearRunLifecycleMoment("run-working", writeAuthority());

    expect(await readTriple("run-working")).toEqual({
      lifecycle_moment: null,
      lifecycle_card_kind: null,
      lifecycle_card_ref: null,
    });
  });

  it("does NOT clear a moment it did not release — a lost race states nothing", async () => {
    // The clear waits on the CAS, and this is why. A release that arrives at a
    // run somebody else already moved has released nothing; wiping the moment
    // there would erase a record a concurrent writer had just made.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-raced", "running");
    await writeTriple("run-raced", "hitl", "agent_hitl_screen", "gate-raced");

    const answer = await advanceAgentRun({
      run: { id: "run-raced", orgId: ORG_ID, status: "pending_input" },
      release: {
        reason: "continue",
        // The row is `running`, so this CAS cannot win.
        from: "pending_input",
        to: "queued",
        dispatch: { kind: "caller_dispatches", why: "this suite is about the row, not the queue" },
      },
      authority: writeAuthority(),
    });

    expect(answer.status).toBe("running");
    expect(await readTriple("run-raced")).toEqual({
      lifecycle_moment: "hitl",
      lifecycle_card_kind: "agent_hitl_screen",
      lifecycle_card_ref: "gate-raced",
    });
  });

  it("records the AUDIT moment WITHOUT moving the run — the audit is a reading", async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-audited", "running");

    // Driven through the real entry, so "does not park" is measured on what the
    // entry does rather than on what this suite chose to write.
    const answer = await onReviewedWorkChanged({
      run: { id: "run-audited", orgId: ORG_ID, status: "running" },
      auditRef: "verification-3",
      authority: writeAuthority(),
    });

    expect(answer.moment).toBe("audit");
    const res = await admin.query(`SELECT status FROM ${RUNS} WHERE id = $1`, ["run-audited"]);
    // UNCHANGED, and that is the invariant: four moments park the run, the audit
    // records and signals its reading and the run goes on.
    expect(res.rows[0].status).toBe("running");
    expect(await readTriple("run-audited")).toEqual({
      lifecycle_moment: "audit",
      lifecycle_card_kind: "verification_summary",
      lifecycle_card_ref: "verification-3",
    });
  });

  it("a status-guarded write lands ONLY on the run the caller believes it has", async () => {
    // A moment and a status are two statements made by two writes, and between
    // them another writer can move the run. The park states its moment a moment
    // after it parks; an approval fast enough to land in that gap would have the
    // run resumed, and the record would then put a card back on a run that is
    // running again. Naming the status folds the check into the write.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-guarded", "running");

    // The caller believes it parked the run; the row says otherwise.
    await recordRunLifecycleMoment(
      {
        runId: "run-guarded",
        orgId: ORG_ID,
        moment: "hitl",
        cardKind: "agent_hitl_screen",
        cardRef: "gate-guarded",
        onlyWhileStatus: "pending_approval",
      },
      writeAuthority(),
    );

    expect(await readTriple("run-guarded")).toEqual({
      lifecycle_moment: null,
      lifecycle_card_kind: null,
      lifecycle_card_ref: null,
    });

    // …and it DOES land when the row really is where the caller thinks.
    await admin.query(`UPDATE ${RUNS} SET status = 'pending_approval' WHERE id = $1`, [
      "run-guarded",
    ]);
    await recordRunLifecycleMoment(
      {
        runId: "run-guarded",
        orgId: ORG_ID,
        moment: "hitl",
        cardKind: "agent_hitl_screen",
        cardRef: "gate-guarded",
        onlyWhileStatus: "pending_approval",
      },
      writeAuthority(),
    );
    expect((await readTriple("run-guarded"))?.lifecycle_moment).toBe("hitl");
  });

  it("the AUDIT write carries no status guard — it is true whatever the run is doing", async () => {
    // The audit does not park, so there is no status it is "only true while".
    // Guarding it would silently drop the reading whenever the run moved on,
    // which is most of the time.
    await admin.query(`DELETE FROM ${RUNS}`);
    await seedRun("run-audit-guard", "completed");

    await onReviewedWorkChanged({
      run: { id: "run-audit-guard", orgId: ORG_ID, status: "completed" },
      auditRef: "verification-9",
      authority: writeAuthority(),
    });

    expect((await readTriple("run-audit-guard"))?.lifecycle_moment).toBe("audit");
  });

  it("the partial index really covers the read it exists for", async () => {
    await admin.query(`DELETE FROM ${RUNS}`);
    for (let i = 0; i < 5; i++) await seedRun(`run-idx-${i}`, "running");
    await writeTriple("run-idx-2", "review", "artifact_review_gate", "review-idx");

    const res = await admin.query(
      `SELECT id FROM ${RUNS} WHERE lifecycle_moment IS NOT NULL`,
    );
    expect(res.rows.map((r) => r.id)).toEqual(["run-idx-2"]);
  });
});
