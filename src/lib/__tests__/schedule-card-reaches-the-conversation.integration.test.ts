/**
 * THE SCHEDULE CARD REACHES THE CONVERSATION, ON A REAL DATABASE (cinatra#3044).
 *
 * Plan (B) §6, verbatim: "a run a person starts from a conversation reaches the
 * schedule moment with its card in that conversation, never a silent wait".
 *
 * The two fixtures that covered this road before drove the OUTBOX directly and
 * handed it a reference they had invented — `"sched-ref-1"`, `sched-${uuid}` —
 * so both stayed green while the surface was empty: nothing in them asked where
 * a reference comes from, and the answer on the real road was "nowhere". This
 * suite drives the COORDINATOR instead, against a real Postgres, with the real
 * host writer wired into the real seam, and reads back both places the card has
 * to be: the run's own row, and the turn the run is playing out in.
 *
 * THE FOUR LEGS:
 *
 *   1. The moment opened the way the executor opens it — with the run-scoped
 *      reference minted on the run path — lands `lifecycle_card_ref` on the row,
 *      and the `trigger_schedule_proposal` part in the run's own turn, at the
 *      `agent_run` call that dispatched it. No tool call is involved.
 *   2. THE DEFECT, PINNED. A moment opened with NO reference — which is exactly
 *      what the executor did before this change — states the moment and writes
 *      NOTHING into the turn. This is the host's own rule ("nothing here invents
 *      a reference it was not given"), and it is why the missing mint was a
 *      complete account of the empty conversation.
 *   3. A run that is not playing out in a conversation gets no part anywhere —
 *      the ordinary case for a schedule firing, another agent, an outside system.
 *   4. Stating the moment again does not give the person a second card.
 *
 * DB-gated exactly as its sibling in this tier is. Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:lifecycle-moment
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { encodeScheduleRunRef, decodeScheduleRunRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { lifecycleRunOutbox } from "@/lib/lifecycle/lifecycle-run-outbox";
import { setLifecyclePartOutbox } from "@cinatra-ai/agents/lifecycle-part-outbox";
import { stateRunScheduleMoment } from "@cinatra-ai/agents/lifecycle-coordinator";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
// The CI placeholder DSN names `unused` in every field, so a connection string
// carrying it is "no database" rather than one to try. Same reading as the
// sibling suite in this tier, expressed without repeating the literal.
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused");
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_LIFECYCLE_MOMENT_REALDB === "1";
const ALLOW_SKIP = process.env.X2928_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the cinatra#3044 leg of the lifecycle-moment lane needs a live Postgres: set " +
      "SUPABASE_DB_URL to a real connection string. Refusing to skip — a skipped " +
      "proof that a card reaches a conversation proves nothing.",
  );
}

const TEST_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2928";
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;
const THREADS = `"${q(TEST_SCHEMA)}"."assistant_threads"`;
const TURNS = `"${q(TEST_SCHEMA)}"."assistant_turns"`;

const TEMPLATE_ID = "tpl-x3044";
const ORG_ID = "org-x3044";

let admin: Client;

/** The write authority the coordinator's record carries — built, never minted:
 *  the mint helpers are named consumers behind the org-write boundary gate, and
 *  the kernel checks the interface and then re-reads the organization itself. */
function writeAuthority() {
  return {
    orgId: ORG_ID,
    can: (capability: string) => capability === "run.execute",
  } as unknown as Parameters<typeof stateRunScheduleMoment>[0]["authority"];
}

async function seedOrganization(): Promise<void> {
  await admin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt")
     VALUES ($1, 'x3044', $1, now())
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID],
  );
}

async function seedTemplate(): Promise<void> {
  await admin.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, name, description, source_nl, compiled_plan, input_schema, approval_policy, status, package_name, org_id)
     VALUES ($1, 'x3044', 'schedule card fixture', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/x3044', $2)
     ON CONFLICT (id) DO NOTHING`,
    [TEMPLATE_ID, ORG_ID],
  );
}

/** A run as the setup hand-off leaves it: parked, waiting for its schedule. */
async function seedWaitingRun(id: string): Promise<void> {
  await admin.query(
    `INSERT INTO ${RUNS} (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', 'pending_trigger', $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, TEMPLATE_ID, ORG_ID],
  );
}

/**
 * The turn as the STREAM ROUTE persists it: the run's own dispatch pointer, and
 * nothing the model asked for. This is the shape the outbox has to find and
 * inject into — the server's own record, not the client's copy of it.
 */
async function seedConversationTurn(runId: string): Promise<{
  turnId: string;
  dispatchCall: string;
}> {
  const threadId = `thread-${runId}`;
  const turnId = `turn-${runId}`;
  const dispatchCall = `call-${runId}`;
  await admin.query(
    `INSERT INTO ${THREADS} (id, org_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [threadId, ORG_ID],
  );
  await admin.query(
    `INSERT INTO ${TURNS} (id, thread_id, role, status, content)
     VALUES ($1, $2, 'assistant', 'completed', $3::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      turnId,
      threadId,
      JSON.stringify({
        format: "assistant-turn-v1",
        role: "assistant",
        content: "",
        parts: [{ type: "tool_call", id: dispatchCall, name: "agent_run" }],
        dataParts: [{ kind: "agent_run", toolCallId: dispatchCall, runId }],
        dataPartSlots: [dispatchCall],
      }),
    ],
  );
  return { turnId, dispatchCall };
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

type InjectedPart = { viewType?: string; schemaVersion?: number; ref?: string };

async function readTurnContent(turnId: string): Promise<Record<string, unknown>> {
  const res = await admin.query(`SELECT content FROM ${TURNS} WHERE id = $1`, [turnId]);
  return (res.rows[0]?.content ?? {}) as Record<string, unknown>;
}

/** Every schedule card this turn carries, in order. */
function scheduleParts(content: Record<string, unknown>): InjectedPart[] {
  const parts = Array.isArray(content.dataParts) ? (content.dataParts as InjectedPart[]) : [];
  return parts.filter((p) => p.viewType === "trigger_schedule_proposal");
}

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    await admin.query(stmt.text);
  }
  await seedOrganization();
  await seedTemplate();
  // THE REAL SEAM, WIRED TO THE REAL WRITER — the same injection production does
  // through `src/lib/register-lifecycle-part-outbox.ts`.
  setLifecyclePartOutbox(lifecycleRunOutbox);
}, 300_000);

afterAll(async () => {
  if (!HAS_DB) return;
  setLifecyclePartOutbox(null);
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.end();
});

// THE CALL SITE THAT OPENS THE MOMENT IS THE ONE THAT MINTS (cinatra#3044).
//
// Every case below drives the COORDINATOR, which is the right seam for the store
// half — but the coordinator has always accepted a reference, so on its own this
// file would pass against the reverted executor (a convergence finding). The
// behaviour of the executor's call is proven in
// `packages/agents/src/__tests__/schedule-moment-carries-its-ref-3044.test.ts`;
// what is pinned HERE is that the one call site the store half depends on is
// still that call. It is a source read for the same reason
// `schedule-card-host-mounts.test.ts` takes one: the fact is a WIRING fact, and
// this tier cannot boot the whole worker to observe it.
describe("the executor is what mints the reference the store half depends on", () => {
  it("opens the schedule moment with the run-scoped schedule reference", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const source = readFileSync(
      path.join(repoRoot, "packages/agents/src/execution.ts"),
      "utf8",
    );
    // AND IT RECORDS WHERE IT WAS MINTED (cinatra#3044, the eighth graded set).
    // This is the ONE site where the card in a conversation IS the run's own
    // schedule step, and the resolver reads that stamp to keep drawing the card
    // once a one-off has fired instead of withdrawing it. The window is wide
    // because the reason for the stamp is written where it is stated.
    expect(source).toMatch(
      /await stateRunScheduleMoment\(\{[\s\S]{0,1200}cardRef: encodeScheduleRunRef\(\{ runId, fromScheduleStep: true \}\)/,
    );
  });
});

describeDb("a run a person started from a conversation reaches its schedule moment THERE", () => {
  it("lands the reference on the run and the card in the run's own turn", async () => {
    const runId = "run-x3044-in-a-conversation";
    await seedWaitingRun(runId);
    const { turnId, dispatchCall } = await seedConversationTurn(runId);

    // Opened exactly as the executor opens it: the run-scoped schedule reference,
    // minted on the run path.
    await stateRunScheduleMoment({
      run: { id: runId, orgId: ORG_ID },
      cardRef: encodeScheduleRunRef({ runId, fromScheduleStep: true }),
      authority: writeAuthority(),
    });

    // 1. THE RUN SAYS WHAT IT IS WAITING AT, and what addresses the card.
    const triple = await readTriple(runId);
    expect(triple?.lifecycle_moment).toBe("schedule");
    expect(triple?.lifecycle_card_kind).toBe("trigger_schedule_proposal");
    expect(
      triple?.lifecycle_card_ref,
      "the run row carries no card reference, so the outbox has nothing to write",
    ).not.toBeNull();
    expect(decodeScheduleRunRef(triple!.lifecycle_card_ref!)).toEqual({
      runId,
      fromScheduleStep: true,
    });

    // 2. THE CONVERSATION CARRIES THE CARD, durably, at the dispatch it belongs to.
    const content = await readTurnContent(turnId);
    const cards = scheduleParts(content);
    expect(
      cards,
      "no trigger_schedule_proposal part reached the run's turn — the conversation still shows nothing",
    ).toHaveLength(1);
    expect(cards[0].ref).toBe(triple!.lifecycle_card_ref);
    const slots = content.dataPartSlots as unknown[];
    const provenance = content.dataPartProvenance as unknown[];
    const at = (content.dataParts as InjectedPart[]).findIndex(
      (p) => p.viewType === "trigger_schedule_proposal",
    );
    expect(slots[at]).toBe(dispatchCall);
    expect(provenance[at]).toBe("platform_injected");

    // 3. NO ASSISTANT TOOL CALL. The turn still holds the run's own dispatch and
    //    nothing the model asked for — the card arrived without one.
    const toolNames = (content.parts as Array<{ name?: string }>).map((p) => p.name);
    expect(toolNames).toEqual(["agent_run"]);
    expect(content.content).toBe("");
  });

  it("writes NOTHING for a moment opened with no reference — the defect this closes", async () => {
    const runId = "run-x3044-no-reference";
    await seedWaitingRun(runId);
    const { turnId } = await seedConversationTurn(runId);

    // The shape the executor used to open the moment in: no `cardRef` at all.
    await stateRunScheduleMoment({
      run: { id: runId, orgId: ORG_ID },
      authority: writeAuthority(),
    });

    const triple = await readTriple(runId);
    // The run's own record is never withheld — it states the moment either way.
    expect(triple?.lifecycle_moment).toBe("schedule");
    expect(triple?.lifecycle_card_ref).toBeNull();
    // …and the conversation gets nothing, because nothing invents a reference it
    // was not given.
    expect(scheduleParts(await readTurnContent(turnId))).toHaveLength(0);
  });

  it("writes nothing for a run that is not playing out in a conversation", async () => {
    const runId = "run-x3044-no-conversation";
    await seedWaitingRun(runId);
    // No thread, no turn — a schedule firing, another agent, an outside system.

    await stateRunScheduleMoment({
      run: { id: runId, orgId: ORG_ID },
      cardRef: encodeScheduleRunRef({ runId, fromScheduleStep: true }),
      authority: writeAuthority(),
    });

    const triple = await readTriple(runId);
    expect(triple?.lifecycle_card_ref).not.toBeNull();
    const res = await admin.query(
      `SELECT count(*)::int AS n FROM ${TURNS} WHERE content::text LIKE '%trigger_schedule_proposal%'
         AND content::text LIKE $1`,
      [`%${runId}%`],
    );
    expect(res.rows[0].n).toBe(0);
  });

  it("does not give the person a second card when the moment is stated again", async () => {
    const runId = "run-x3044-stated-twice";
    await seedWaitingRun(runId);
    const { turnId } = await seedConversationTurn(runId);
    const input = {
      run: { id: runId, orgId: ORG_ID },
      cardRef: encodeScheduleRunRef({ runId, fromScheduleStep: true }),
      authority: writeAuthority(),
    };

    await stateRunScheduleMoment(input);
    await stateRunScheduleMoment(input);

    expect(scheduleParts(await readTurnContent(turnId))).toHaveLength(1);
  });
});
