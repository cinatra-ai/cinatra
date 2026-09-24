/**
 * THE LAST DECLARED SETUP FIELD MUST ACTUALLY RE-ENTER THE RUN — the sequential
 * per-field setup road, against a real database and the real queue.
 *
 * WHAT THIS PROVES, AND WHY A MOCKED QUEUE CANNOT. The per-field setup gate
 * synthesises ONE gate identity for the whole road (`setup-<runId>`, the same
 * string for every field it asks about), and the approval's resume enqueue used
 * to derive its job id from that identity ALONE — one id for every decision.
 * The queue KEEPS its finished jobs, so the SECOND field's resume asked to
 * create a job whose id a COMPLETED job already held — and an id-carrying add
 * is a no-op against an existing twin, so the enqueue handed back the finished
 * job and nothing ran: the run stayed `queued` at the `hitl` moment on its
 * decided gate, never reached the Schedule step, and no trigger row was ever
 * written. The id now names the DECISION (the field), so each field's resume is
 * its own job. Only a real queue reproduces the defect; a stubbed enqueue
 * records a call that never became work.
 *
 * THE ROAD THIS DRIVES IS THE PRODUCT'S OWN. The run's first execution pass
 * parks it on the first declared field; `approveReviewTaskInternal` — the
 * server action the run page's Continue calls — decides the brief; the resume
 * job travels the real queue and is consumed by the app's own worker (the
 * enqueue itself starts the runtime, and its registry dispatcher runs the
 * registered execution handler), which parks the run on the second field; the
 * same action decides the LAST field; and the run must then park on the
 * Schedule step (`pending_trigger`, stating the `schedule` moment) and, once a
 * schedule is chosen through `setRunTriggerForActor`, hold its trigger row and
 * leave the wait for dispatch.
 *
 * WHAT THE TWO WAITS MEAN. The park on the SECOND field can only come from the
 * first field's resume, and the park on the Schedule step can only come from
 * the last field's resume — so the two readings ARE the two resumes, measured
 * on the rows rather than counted at the queue.
 *
 * WHERE THE ROAD STOPS HERE. The fixture agent is served by nothing, so the
 * dispatch the started run reaches is its cheapest terminal; what is asserted
 * at the end is that the run LEFT the Schedule wait with its trigger row
 * written. The A2A task and the execution attempt a SERVED agent mints belong
 * to a tier that serves one, not to this one.
 *
 * DB-gated: skips unless SUPABASE_DB_URL is set and
 * CINATRA_DB_INTEGRATION_TESTS=1, like every sibling *.integration.test.ts.
 *
 * Run:
 *   cd packages/agents && CINATRA_TEST_DB_URL="$SUPABASE_DB_URL" \
 *     CINATRA_DB_INTEGRATION_TESTS=1 pnpm exec vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/setup-field-sequential-resume.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const dbUrl = process.env.SUPABASE_DB_URL;
// The placeholder DSN a no-database checkout exports is recognized by its own
// marker word rather than by matching a credential-shaped literal.
const NO_DATABASE_MARKER = "unused";
const hasDb =
  typeof dbUrl === "string" && dbUrl.length > 0 && !dbUrl.includes(NO_DATABASE_MARKER);
const enabled = hasDb && process.env.CINATRA_DB_INTEGRATION_TESTS === "1";

// FIXTURE IDENTITIES ARE UNIQUE PER TEST PROCESS. This suite runs against a
// SHARED test database, so fixed organization/user ids would let two overlapping
// runs of this file delete each other's rows in teardown (the membership delete
// is by user id). A fresh identity per process owns only what it created.
const FIXTURE_KEY = randomUUID().slice(0, 12);

// THE QUEUE NAME IS READ FROM THE ENVIRONMENT AT MODULE LOAD, so it is set here
// — before the first dynamic import below pulls the queue module in. A name
// private to this suite's own process keeps these jobs off any queue a running
// app is working, and any such app off these; it is keyed by the SAME fresh
// fixture identity rather than by the pid alone, because a pid repeats across
// two machines that share one Redis. Every module this suite drives is imported
// inside `beforeAll` for that reason alone. Set ONLY when this suite actually
// runs, and put back in `afterAll`, so a file that loads after it in the same
// process reads the environment it would have read without it. The queue runtime
// itself is process-global and the module exposes no close, so the process exit
// is what releases it — the keys it leaves behind are its own private name's.
const PRIOR_QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME;
if (enabled) {
  process.env.BULLMQ_QUEUE_NAME = `cinatra-jobs-w11-setup-resume-${FIXTURE_KEY}`;
}
const ORG = `org-w11-setup-resume-${FIXTURE_KEY}`;
const USER = `user-w11-setup-resume-${FIXTURE_KEY}`;
const MEMBER = `m-w11-setup-resume-${FIXTURE_KEY}`;
const AUTH = { orgId: ORG, can: () => true };

let store: typeof import("../store");
let runAgentBuilderExecutionJob: typeof import("../execution")["runAgentBuilderExecutionJob"];
let approveReviewTaskInternal: typeof import("../review-task-actions")["approveReviewTaskInternal"];
let setRunTriggerForActor: typeof import("../trigger-service")["setRunTriggerForActor"];

/** Every run this suite created, for teardown. */
const createdRunIds: string[] = [];
/** Every template this suite created, for teardown. */
const createdTemplateIds: string[] = [];

async function query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const { rows } = await c.query(sql, params);
    return rows as T[];
  } finally {
    await c.end();
  }
}

type RunRow = {
  status: string;
  lifecycle_moment: string | null;
  a2a_task_id: string | null;
  execution_attempt_id: string | null;
};

async function readRun(runId: string): Promise<RunRow> {
  const rows = await query<RunRow>(
    `SELECT status, lifecycle_moment, a2a_task_id, execution_attempt_id
       FROM cinatra.agent_runs WHERE id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) throw new Error(`run ${runId} has no row`);
  return row;
}

/** The field the run's most recently materialized setup gate asks for. */
async function lastGateField(runId: string): Promise<string | null> {
  const rows = await query<{ field_name: string | null }>(
    `SELECT field_name FROM cinatra.agent_run_hitl_gates
      WHERE run_id = $1 ORDER BY materialized_at DESC LIMIT 1`,
    [runId],
  );
  return rows[0]?.field_name ?? null;
}

async function triggerRowCount(runId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM cinatra.agent_run_triggers WHERE run_id = $1`,
    [runId],
  );
  return Number(rows[0]?.n ?? "0");
}

/** Poll a real row until it says what is expected, or report what it said instead. */
async function waitUntil<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!ready(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${what} — last reading: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

/** A template INSTALLED IN THIS ORG with TWO declared setup fields, undecorated
 *  — two pending fields and no grouped-form renderer is the sequential
 *  per-field road, which is the road the pipeline's setup takes. */
async function makeTemplate(): Promise<string> {
  const templateId = `t_${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `w11-setup-resume-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", title: "Brief" },
        ideaCount: { type: "integer", title: "How many ideas" },
      },
      required: ["brief", "ideaCount"],
    },
    approvalPolicy: { steps: [] },
    packageName: `@test/w11-setup-resume-${randomUUID().slice(0, 6)}`,
    orgId: ORG,
  });
  createdTemplateIds.push(templateId);
  return templateId;
}

describe.skipIf(!enabled)(
  "the sequential setup road: the last decided field parks the run on Schedule and starts it",
  () => {
    beforeAll(async () => {
      await query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt")
         VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
        [ORG],
      );
      await query(
        `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [USER, `${USER}@w11-setup-resume.test`],
      );
      // The person OWNS the org: the install-scope gate and the approval's
      // membership read both resolve this row live.
      await query(
        `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
        [MEMBER, ORG, USER],
      );

      store = await import("../store");
      ({ runAgentBuilderExecutionJob } = await import("../execution"));
      ({ approveReviewTaskInternal } = await import("../review-task-actions"));
      ({ setRunTriggerForActor } = await import("../trigger-service"));
    }, 120_000);

    afterAll(async () => {
      for (const runId of createdRunIds) {
        await query(`DELETE FROM cinatra.agent_run_triggers WHERE run_id = $1`, [runId]).catch(
          () => [],
        );
        await query(`DELETE FROM cinatra.agent_runs WHERE id = $1`, [runId]).catch(() => []);
      }
      for (const templateId of createdTemplateIds) {
        await query(`DELETE FROM cinatra.agent_templates WHERE id = $1`, [templateId]).catch(
          () => [],
        );
      }
      // BY THE MEMBERSHIP ROW'S OWN ID, never by the user id: the identities are
      // unique per process, and a delete scoped to the row this process
      // inserted cannot reach another run's fixtures.
      await query(`DELETE FROM public."member" WHERE id = $1`, [MEMBER]).catch(() => []);
      await query(`DELETE FROM public."user" WHERE id = $1`, [USER]).catch(() => []);
      await query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => []);
      if (PRIOR_QUEUE_NAME === undefined) delete process.env.BULLMQ_QUEUE_NAME;
      else process.env.BULLMQ_QUEUE_NAME = PRIOR_QUEUE_NAME;
    }, 60_000);

    it(
      "decides both declared fields through the product's own action: the run parks on the Schedule step, and a chosen schedule writes its trigger row and starts it",
      async () => {
        const templateId = await makeTemplate();
        const run = await store.createAgentRun(
          { id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: ORG, runBy: USER },
          AUTH as never,
        );
        createdRunIds.push(run.id);

        // 1. The run's first pass parks it on the FIRST declared field.
        await runAgentBuilderExecutionJob({ runId: run.id }, `w11-first-pass-${run.id}`);
        expect((await readRun(run.id)).status).toBe("pending_approval");
        expect(await lastGateField(run.id)).toBe("brief");

        // 2. The brief is decided on the product's own server action; its resume
        //    travels the real queue and the run parks on the SECOND field.
        await approveReviewTaskInternal(
          `setup-${run.id}`,
          USER,
          { brief: "A practical post on migrations." },
          "brief",
        );
        await waitUntil(
          async () => ({
            status: (await readRun(run.id)).status,
            field: await lastGateField(run.id),
          }),
          (r) => r.status === "pending_approval" && r.field === "ideaCount",
          "the run to park on the second declared field",
        );

        // 3. The LAST declared field is decided. THIS is the enqueue that a
        //    finished twin of the same job id used to swallow.
        await approveReviewTaskInternal(`setup-${run.id}`, USER, { ideaCount: 3 }, "ideaCount");

        // 4. THE RUN PARKS ON THE SCHEDULE STEP. Before the fix the resume never
        //    ran: the run stayed `queued` at the `hitl` moment on its decided
        //    gate, and this wait is where that was measured.
        const parked = await waitUntil(
          () => readRun(run.id),
          (r) => r.status === "pending_trigger",
          "the run to park on the Schedule step",
        );
        expect(parked.status).toBe("pending_trigger");
        expect(parked.lifecycle_moment).toBe("schedule");
        expect(await triggerRowCount(run.id)).toBe(0);

        // 5. The schedule is chosen on the Schedule step: the trigger row exists
        //    and the run leaves the wait.
        const scheduled = await setRunTriggerForActor(
          { userId: USER },
          { runId: run.id, triggerType: "immediate" },
        );
        expect(scheduled.ok).toBe(true);
        expect(await triggerRowCount(run.id)).toBe(1);
        // THE READING IS NAMED, NOT MERELY "NOT PARKED". A run that left the
        // wait because it was cancelled, or because it parked on ANOTHER
        // approval, would satisfy a bare `!== pending_trigger` — so the states
        // dispatch may reach are named. On this tier the fixture agent is
        // served by nothing, so `failed` (the dispatch's cheapest terminal) is
        // the ordinary reading and is listed with `running`/`completed`; the
        // A2A task and the execution attempt a SERVED agent mints belong to the
        // tier that serves one.
        const DISPATCHED = ["running", "completed", "failed"] as const;
        const started = await waitUntil(
          () => readRun(run.id),
          (r) => (DISPATCHED as readonly string[]).includes(r.status),
          `the run to leave the Schedule wait for dispatch (one of ${DISPATCHED.join(", ")})`,
        );
        expect(DISPATCHED).toContain(started.status);
        // The decided setup gate is behind it: it did not re-park on a field.
        expect(started.lifecycle_moment).not.toBe("hitl");
      },
      180_000,
    );
  },
);
