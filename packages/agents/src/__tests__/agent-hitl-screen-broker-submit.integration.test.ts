/**
 * THE BROKER ANSWER, AGAINST A REAL STORE (cinatra#2930, lifecycle-b W3).
 *
 * What a mocked store cannot prove, and this does:
 *
 *   · THE RUN ACTUALLY ADVANCES. A real `agent_runs` row parked at
 *     `pending_approval` is answered through `submitAgentHitlScreenForActor`
 *     and comes back `queued`, with the reviewer's value merged into
 *     `input_params` — the same single CAS the run page's Continue drives,
 *     because it IS that write.
 *   · THE GATE BINDING HOLDS ON REAL ROWS. A gate id belonging to ANOTHER real
 *     run is refused against a run this session does own, and the row is
 *     untouched afterwards — still `pending_approval`, still un-merged.
 *   · THE WIDGET BINDING HOLDS ON REAL ROWS. A real run started by someone
 *     else, in the same org, is refused — and that row is untouched too.
 *
 * WHAT IS STUBBED, AND WHY IT IS ONLY THIS. The one non-store side effect: the
 * re-enqueue that wakes the setup loop is a BullMQ (Redis) call that happens
 * AFTER the database commit, and this tier has a database, not a queue. The
 * store, the access ladder, the gate derivation, the org-write kernel guard and
 * the CAS are all REAL — what is asserted is the row Postgres holds afterwards,
 * which is exactly the fact a queue stub cannot fake.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset, mirroring every other suite in
 * this tier.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const enqueueBackgroundJob = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/background-jobs", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  enqueueBackgroundJob: (...a: unknown[]) => enqueueBackgroundJob(...a),
}));

const dbUrl = process.env.SUPABASE_DB_URL;
// The placeholder DSN the no-database lanes export is recognized by its own
// marker word rather than by matching a credential-shaped literal.
const NO_DATABASE_MARKER = "unused";
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes(NO_DATABASE_MARKER);

const ORG = "org-hitl-broker-submit";
const AUTH = { orgId: ORG, can: () => true };
/** The person the widget credential names — the run's own initiator. */
const READER = "user-hitl-broker-reader";
/** Somebody else in the same org. Their run is not this conversation's run. */
const STRANGER = "user-hitl-broker-stranger";
const MEMBERS = [READER, STRANGER] as const;

/** The actor the widget door resolves — the person's REAL standing. */
const WHO = {
  actor: { userId: READER, orgId: ORG } as never,
  roleHints: { orgRole: "owner" } as never,
};

type Store = typeof import("../store");
let store: Store;
let submitAgentHitlScreenForActor: typeof import("../agent-hitl-screen-submit")["submitAgentHitlScreenForActor"];

beforeAll(async () => {
  if (!hasDb) return;
  store = await import("../store");
  ({ submitAgentHitlScreenForActor } = await import("../agent-hitl-screen-submit"));
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  for (const userId of MEMBERS) {
    await c.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@hitl-broker.test`],
    );
    // The reader OWNS the org: `run.execute` + `run.approveHitl` are resolved
    // live against this row, so the standing here is the standing the core
    // enforces against.
    await c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
      [`m-hitl-broker-${userId}`, ORG, userId, userId === READER ? "owner" : "member"],
    );
  }
  await c.end();
});

afterAll(async () => {
  if (!hasDb) return;
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`DELETE FROM public."member" WHERE "userId" = ANY($1)`, [[...MEMBERS]]);
  await c.query(`DELETE FROM public."user" WHERE id = ANY($1)`, [[...MEMBERS]]);
  await c.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]);
  await c.end();
});

/** A template INSTALLED IN THIS ORG — the install scope is what authorizes a
 *  run, so an org-less fixture would be refused before anything else. */
async function makeTemplate(): Promise<string> {
  const templateId = `t_${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `hitl-broker-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: { type: "object", properties: { destination: { type: "string" } } },
    approvalPolicy: { steps: [] },
    packageName: `@cinatra-ai/hitl-broker-${randomUUID().slice(0, 6)}`,
    orgId: ORG,
  });
  return templateId;
}

/**
 * A run PARKED ASKING, for real. No `a2a_task_id`, no readable interrupt and no
 * durable gate row, so the shipped derivation answers the setup-loop identity —
 * `setup-<runId>` with the template's input schema — which is exactly what a
 * run paused before execution started shows on the run page.
 */
async function parkedRun(templateId: string, runBy: string): Promise<string> {
  const run = await store.createAgentRun(
    { id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: ORG, runBy },
    AUTH,
  );
  // Parked with a direct write rather than the tx-bound transition helper: what
  // this suite measures is the row the SUBMIT leaves behind, so the setup only
  // has to put a real row in a real `pending_approval` state.
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`UPDATE cinatra.agent_runs SET status = $2 WHERE id = $1`, [
    run.id,
    "pending_approval",
  ]);
  await c.end();
  return run.id;
}

async function rowOf(runId: string): Promise<{ status: string; inputParams: unknown }> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  const { rows } = await c.query(
    `SELECT status, input_params FROM cinatra.agent_runs WHERE id = $1`,
    [runId],
  );
  await c.end();
  // `input_params` is a TEXT column carrying JSON, so it comes back as a string
  // from a raw client. Read it the way the store reads it.
  const raw = rows[0]?.input_params as unknown;
  let inputParams: unknown = raw;
  if (typeof raw === "string") {
    try {
      inputParams = JSON.parse(raw);
    } catch {
      inputParams = raw;
    }
  }
  return { status: rows[0]?.status as string, inputParams };
}

describe.skipIf(!hasDb)("the broker answer, against a real store", () => {
  it("the run ADVANCES: pending_approval → queued, with the value merged", async () => {
    const runId = await parkedRun(await makeTemplate(), READER);
    expect((await rowOf(runId)).status).toBe("pending_approval");

    const outcome = await submitAgentHitlScreenForActor({
      runId,
      reviewTaskId: `setup-${runId}`,
      // NO `fieldName`: this gate names none — a run parked before execution
      // started derives the generic setup identity — so the answer takes the
      // grouped shape, and the merge validates its keys against the template's
      // declared inputs. Naming a field here would be refused (below).
      values: { destination: "Berlin" },
      actorId: READER,
      who: WHO,
      bindRun: (run) => run.runBy === READER && run.orgId === ORG,
    });
    expect(outcome).toEqual({ ok: true });

    const after = await rowOf(runId);
    expect(after.status, "the run did not advance").toBe("queued");
    expect(after.inputParams).toMatchObject({ destination: "Berlin" });
    // The resume really was handed on — the same re-enqueue the in-app submit
    // makes, with the same job identity.
    expect(enqueueBackgroundJob).toHaveBeenCalled();
  });

  it("a gate id belonging to ANOTHER run is refused, and BOTH rows are untouched", async () => {
    const templateId = await makeTemplate();
    const mine = await parkedRun(templateId, READER);
    const other = await parkedRun(templateId, READER);

    const outcome = await submitAgentHitlScreenForActor({
      runId: mine,
      // The other run's real gate id, against a run this session does own.
      reviewTaskId: `setup-${other}`,
      values: { destination: "Lisbon" },
      actorId: READER,
      who: WHO,
    });
    expect(outcome.ok).toBe(false);
    for (const runId of [mine, other]) {
      const row = await rowOf(runId);
      expect(row.status, `run ${runId === mine ? "named" : "borrowed"} was written`).toBe(
        "pending_approval",
      );
      expect(row.inputParams).not.toMatchObject({ destination: "Lisbon" });
    }
  });

  it("naming a FIELD this gate does not name is refused, and the row is untouched", async () => {
    // The setup loop's questions all share one `setup-<runId>` id; `fieldName`
    // is what selects the input a value lands in. This gate names none, so a
    // caller that names one is trying to write an input it was not asked for.
    const runId = await parkedRun(await makeTemplate(), READER);

    const outcome = await submitAgentHitlScreenForActor({
      runId,
      reviewTaskId: `setup-${runId}`,
      values: { destination: "Rome" },
      fieldName: "destination",
      actorId: READER,
      who: WHO,
      bindRun: (run) => run.runBy === READER && run.orgId === ORG,
    });
    expect(outcome.ok).toBe(false);

    const row = await rowOf(runId);
    expect(row.status, "a field the gate never asked for was written").toBe(
      "pending_approval",
    );
    expect(row.inputParams).not.toMatchObject({ destination: "Rome" });
  });

  it("a run this widget session does not own is refused, and its row is untouched", async () => {
    const runId = await parkedRun(await makeTemplate(), STRANGER);

    const outcome = await submitAgentHitlScreenForActor({
      runId,
      reviewTaskId: `setup-${runId}`,
      values: { destination: "Oslo" },
      actorId: READER,
      who: WHO,
      // The widget branch's binding: this person's own run, in the token's org.
      bindRun: (run) => run.runBy === READER && run.orgId === ORG,
    });
    expect(outcome.ok).toBe(false);

    const row = await rowOf(runId);
    expect(row.status, "a stranger's run was advanced").toBe("pending_approval");
    expect(row.inputParams).not.toMatchObject({ destination: "Oslo" });
  });
});
