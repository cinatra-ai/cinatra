/**
 * cinatra#3745 (unit 4097-resume2) — THE RESUME DELIVERY'S CLAIM, ON A REAL DATABASE.
 *
 * The artifact-review resume delivery moves a paused run `pending_approval ->
 * running` before it sends. This file drives the real transitionRunStatus, the
 * real gate store and the real sweeper on Postgres, and mocks only the A2A client,
 * the run-token mint and handleWayflowTaskState. It proves:
 *
 *   - D1: every run edge the delivery writes is fenced by the intent's lease, in
 *     the run's own transaction, and carries the claim mark with it;
 *   - D2-D4: a claimed delivery that dies, outlives its lease, loses its lease or
 *     fails before the wire is re-sent, replayed or left alone, never closed early;
 *   - D7: the 0116 rollout guard on populated tables; D8: no claimed dead-letter.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-delivery-claim-3745
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_resume_delivery_claim_3745";
const GUARD_SCHEMA = "cinatra_test_resume_0116_guard";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const T = (table: string) => `"${q(TEST_SCHEMA)}"."${table}"`;
const ORG = "org-3745-claim";
const USER = "user-3745-claim";
const AUTHORITY = { orgId: ORG, can: () => true };
const RUN_TOKEN_KEY = "__cinatra_run_token__";

type SendRequest = { message: { messageId: string; metadata?: Record<string, unknown>; contextId: string } };

const h = vi.hoisted(() => ({
  /** undefined: Redis names the run's own gate task; null: lapsed; a string: another task. */
  latestTask: undefined as undefined | null | string,
  taskByRun: {} as Record<string, string>,
  sends: [] as Array<{ messageId: string; metadata: Record<string, unknown> | undefined }>,
  sendImpl: null as null | ((req: unknown) => Promise<unknown>),
  handled: [] as Array<{ runId: string; fromStatus: string; taskId: string | undefined }>,
  handlerImpl: null as null | ((input: unknown) => Promise<void>),
  mintError: null as null | Error,
  scopeDenied: null as null | string,
  /** Runs inside the scope recheck, before the claim: another actor's move. */
  beforeScope: null as null | (() => Promise<void>),
  /** Renewals that throw before they reach the store, counted down. */
  renewThrows: 0,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: vi.fn(async (req: SendRequest) => {
      h.sends.push({ messageId: req.message.messageId, metadata: req.message.metadata });
      if (h.sendImpl) {
        const task = await h.sendImpl(req);
        if (task !== undefined) return task;
      }
      return {
        id: `task-next-${randomUUID()}`,
        contextId: req.message.contextId,
        status: { state: "input-required" },
        history: [{ role: "user", kind: "message", messageId: req.message.messageId, metadata: req.message.metadata, parts: [] }],
      };
    }),
  })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async (runId: string) =>
    h.latestTask === undefined ? h.taskByRun[runId] ?? null : h.latestTask),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async (input: { runId: string; fromStatus: string; task?: { id?: string } }) => {
    h.handled.push({ runId: input.runId, fromStatus: input.fromStatus, taskId: input.task?.id });
    if (h.handlerImpl) await h.handlerImpl(input);
  }),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => {
    if (h.mintError) throw h.mintError;
    return { __cinatra_run_token__: "raw-run-token-3745" };
  }),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => {
    if (h.beforeScope) await h.beforeScope();
    if (h.scopeDenied) {
      throw Object.assign(new Error("scope denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED", reason: h.scopeDenied });
    }
  }),
}));
vi.mock("../store", async (orig) => {
  const actual = await orig<typeof import("../store")>();
  return {
    ...actual,
    readAgentRunById: (id: string) => actual.readAgentRunById(id),
    readAgentTemplateById: vi.fn(async () => ({
      id: "tpl-3745",
      name: "Resume template",
      packageName: "@cinatra-ai/resume-test-agent",
      sourceType: "internal",
      status: "published",
      type: "leaf",
      agentAuthPolicy: null,
    })),
  };
});
vi.mock("../artifact-review-gate-store", async (orig) => {
  const actual = await orig<typeof import("../artifact-review-gate-store")>();
  return {
  ...actual,
  renewResumeIntentLease: async (...args: Parameters<typeof actual.renewResumeIntentLease>) => {
    if (h.renewThrows > 0) {
      h.renewThrows -= 1;
      throw new Error("renewal blip");
    }
    return actual.renewResumeIntentLease(...args);
  },
  // One resolved gate per run: the per-artifact family is complete.
  listReviewGatesForRun: vi.fn(async (runId: string) => [
    { runId, orgId: ORG, reviewTaskId: `wayflow-${h.taskByRun[runId]}`, status: "resolved",
      pinnedTargets: [{ artifactId: "post", representationRevisionId: "r1" }] },
  ]),
  };
});
vi.mock("../run-produced-review-hold", async (orig) => ({
  ...(await orig<typeof import("../run-produced-review-hold")>()),
  listReleasableHeldRuns: vi.fn(async () => []),
}));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintAgentRunExecutionAuthority: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn(async () => undefined) }));

let transitions: typeof import("../run-transition");
let gateStore: typeof import("../artifact-review-gate-store");
let dbMod: typeof import("../db");
let delivery: typeof import("../artifact-review-resume-delivery");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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

type Run = { runId: string; taskId: string; contextId: string; attempt: string };

async function seedRun(status: "pending_approval" | "running"): Promise<Run> {
  const run = { runId: `run-${randomUUID()}`, taskId: `task-${randomUUID()}`, contextId: `ctx-${randomUUID()}`, attempt: randomUUID() };
  await pool(
    `INSERT INTO ${T("agent_runs")}
       (id, template_id, org_id, status, input_params, run_by, execution_attempt_id, a2a_context_id, a2a_task_id)
     VALUES ($1, 'tpl-3745', $2, $3, '{}', $4, $5, $6, $7)`,
    [run.runId, ORG, status, USER, run.attempt, run.contextId, run.taskId],
  );
  h.taskByRun[run.runId] = run.taskId;
  return run;
}

type IntentSeed = {
  status?: "pending" | "delivering";
  leaseToken?: string | null;
  leaseExpired?: boolean;
  runClaimed?: boolean;
  result?: unknown;
  attempts?: number;
  maxAttempts?: number;
  /** Another gate of the same run (the gates table is unique on run and task). */
  reviewTask?: string;
};

/** Seeds a resolved gate and its intent. The claim columns are written only when
 *  a case names them, so the cases that run red-first on the base touch only the
 *  columns the base has. */
async function seedIntent(run: Run, seed: IntentSeed = {}): Promise<string> {
  const gateId = `gate-${randomUUID()}`;
  const reviewTask = seed.reviewTask ?? `wayflow-${run.taskId}`;
  await pool(
    `INSERT INTO ${T("artifact_review_gates")}
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, 'resolved', '[{"artifactId":"post","representationRevisionId":"r1"}]'::jsonb, 'approve', $5, now())`,
    [gateId, run.runId, ORG, reviewTask, `fp-${gateId}`],
  );
  const status = seed.status ?? "pending";
  const lease = seed.leaseToken === undefined ? (status === "delivering" ? `lease-${randomUUID()}` : null) : seed.leaseToken;
  const claimColumns = seed.runClaimed === true || seed.result !== undefined;
  const values: unknown[] = [gateId, run.runId, reviewTask, status, seed.attempts ?? (status === "delivering" ? 1 : 0),
    seed.maxAttempts ?? 20, lease, seed.leaseExpired === true];
  if (claimColumns) values.push(seed.runClaimed === true, seed.result === undefined ? null : JSON.stringify(seed.result));
  await pool(
    `INSERT INTO ${T("artifact_review_resume_outbox")}
       (gate_id, run_id, review_task_id, kind, response_text, status, attempts, max_attempts,
        lease_token, lease_expires_at${claimColumns ? ", run_claimed_at, resume_task_result" : ""})
     VALUES ($1, $2, $3, 'approve', '{"approved":true}', $4, $5, $6, $7,
        CASE WHEN $7::text IS NULL THEN NULL WHEN $8::boolean THEN now() - interval '1 second' ELSE now() + interval '5 minutes' END
        ${claimColumns ? ", CASE WHEN $9::boolean THEN now() ELSE NULL END, $10::jsonb" : ""})`,
    values,
  );
  return gateId;
}

/** The base's own columns only: what a red-first case may read on the base. */
async function outboxRow(gateId: string): Promise<{ status: string; leaseToken: string | null }> {
  const r = await pool(`SELECT status, lease_token FROM ${T("artifact_review_resume_outbox")} WHERE gate_id = $1`, [gateId]);
  const row = r.rows[0] as { status: string; lease_token: string | null };
  return { status: row.status, leaseToken: row.lease_token };
}

type IntentState = {
  status: string; leaseToken: string | null; claimed: boolean; result: unknown;
  attempts: number; deadLettered: boolean; leaseLive: boolean;
};

async function intentState(gateId: string): Promise<IntentState> {
  const r = await pool(
    `SELECT status, lease_token, run_claimed_at IS NOT NULL AS claimed, resume_task_result AS result,
            attempts, dead_lettered_at IS NOT NULL AS dead, COALESCE(lease_expires_at > now(), false) AS live
       FROM ${T("artifact_review_resume_outbox")} WHERE gate_id = $1`,
    [gateId],
  );
  const row = r.rows[0] as { status: string; lease_token: string | null; claimed: boolean; result: unknown;
    attempts: number; dead: boolean; live: boolean };
  return { status: row.status, leaseToken: row.lease_token, claimed: row.claimed, result: row.result,
    attempts: row.attempts, deadLettered: row.dead, leaseLive: row.live };
}

async function runState(runId: string): Promise<{ status: string; attempt: string | null }> {
  const r = await pool(`SELECT status, execution_attempt_id FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const row = r.rows[0] as { status: string; execution_attempt_id: string | null };
  return { status: row.status, attempt: row.execution_attempt_id };
}

/** The invariant every case ends with: an intent is closed only when the run left this gate. */
async function expectNoStrand(run: Run, gateId: string) {
  const intent = await intentState(gateId);
  const state = await runState(run.runId);
  if (intent.status === "done") expect(state.status).not.toBe("pending_approval");
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
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
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  transitions = await import("../run-transition");
  gateStore = await import("../artifact-review-gate-store");
  dbMod = await import("../db");
  delivery = await import("../artifact-review-resume-delivery");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await c.query(`DROP SCHEMA IF EXISTS "${q(GUARD_SCHEMA)}" CASCADE`);
  });
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
});

beforeEach(async () => {
  vi.useRealTimers();
  // Each case starts with no claimable intent of an earlier case in the schema.
  if (HAS_DB && dbMod) {
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET status = 'done', lease_token = NULL WHERE status <> 'done'`);
  }
  h.latestTask = undefined;
  h.sends = [];
  h.sendImpl = null;
  h.handled = [];
  h.handlerImpl = null;
  h.mintError = null;
  h.scopeDenied = null;
  h.beforeScope = null;
  h.renewThrows = 0;
});

describe.skipIf(!HAS_DB)("D1: the delivery's run edges are fenced by its lease, in the run's transaction", () => {
  const lease = (gateId: string, leaseToken: string) => ({ resumeIntentLease: { gateId, leaseToken } });

  it("the claim sets the mark under the live lease, and the release clears mark and result", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(gateId, "L1"), AUTHORITY as never);
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: run.attempt });
    expect(await intentState(gateId)).toMatchObject({ claimed: true, result: null, status: "delivering" });
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET resume_task_result = '{"id":"t"}' WHERE gate_id = $1`, [gateId]);
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", lease(gateId, "L1"), AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await intentState(gateId)).toMatchObject({ claimed: false, result: null, status: "delivering" });
  });

  it("T5 a claim under a stolen lease rolls back the run CAS", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other" });
    await expect(transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(gateId, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect((await intentState(gateId)).claimed).toBe(false);
    await expectNoStrand(run, gateId);
  });

  it("a stale worker's running -> failed lands only under its lease; a done or dead-lettered row is no lease", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "other", runClaimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "L1") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    expect((await runState(run.runId)).status).toBe("running");
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = now() WHERE gate_id = $1`, [gateId]);
    await expect(transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never))
      .rejects.toMatchObject({ code: "resume_intent_lease_lost" });
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET dead_lettered_at = NULL WHERE gate_id = $1`, [gateId]);
    await transitions.transitionRunStatus(run.runId, "running", "failed", { error: "refused", ...lease(gateId, "other") }, AUTHORITY as never);
    expect((await runState(run.runId)).status).toBe("failed");
  });

  it("T21 every entry into running clears the run's other claim marks; the claim keeps its own", async () => {
    const run = await seedRun("pending_approval");
    const earlier = await seedIntent(run, { status: "delivering", leaseToken: "L0", runClaimed: true, result: { id: "t-old" },
      reviewTask: `wayflow-task-earlier-${randomUUID()}` });
    const own = await seedIntent(run, { status: "delivering", leaseToken: "L1" });
    const otherRun = await seedRun("running");
    const otherRunIntent = await seedIntent(otherRun, { status: "delivering", leaseToken: "L2", runClaimed: true });
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", lease(own, "L1"), AUTHORITY as never);
    expect(await intentState(own)).toMatchObject({ claimed: true, result: null });
    expect(await intentState(earlier)).toMatchObject({ claimed: false, result: null, status: "delivering", leaseToken: "L0" });
    // An entry with no lease (the human or MCP resume) clears every mark of the run, its own run only.
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", lease(own, "L1"), AUTHORITY as never);
    await pool(`UPDATE ${T("artifact_review_resume_outbox")} SET run_claimed_at = now() WHERE gate_id = $1`, [own]);
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", undefined, AUTHORITY as never);
    expect((await intentState(own)).claimed).toBe(false);
    expect((await intentState(otherRunIntent)).claimed).toBe(true);
  });

  it("the lease key on any other edge is illegal before any write", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseToken: "L1", runClaimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "completed", lease(gateId, "L1"), AUTHORITY as never))
      .rejects.toMatchObject({ code: "illegal_transition" });
    expect((await runState(run.runId)).status).toBe("running");
    expect((await intentState(gateId)).claimed).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("D2-D4: the delivery re-sends, replays or leaves alone; it never closes early", () => {
  const OUTBOX = () => T("artifact_review_resume_outbox");
  const expire = (gateId: string) =>
    pool(`UPDATE ${OUTBOX()} SET lease_expires_at = now() - interval '1 second' WHERE gate_id = $1`, [gateId]);
  const steal = (gateId: string) => pool(`UPDATE ${OUTBOX()} SET lease_token = 'other' WHERE gate_id = $1`, [gateId]);
  async function claimOne(gateId: string) {
    const [row] = await gateStore.claimPendingResumeIntents({ limit: 1, leaseMs: 60_000 });
    expect(row?.gateId).toBe(gateId);
    return row!;
  }
  /** The first send is entered and hangs until the test settles it; later sends answer at once. */
  function hangFirstSend() {
    const entered = deferred();
    const hang = deferred<unknown>();
    let first = true;
    h.sendImpl = async () => {
      if (!first) return undefined;
      first = false;
      entered.resolve();
      return hang.promise;
    };
    return { entered, hang };
  }

  it("T1 RED (i) a delivery that dies after its claim is re-sent by the next lease, not closed", async () => {
    // A dead process renews nothing: the renewal timer never fires.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const { entered, hang } = hangFirstSend();
    const first = delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    await entered.promise;
    await expire(gateId);
    await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(h.sends.length).toBe(2);
    expect(h.sends.map((x) => x.messageId)).toEqual([`artifact-review-resume-${gateId}`, `artifact-review-resume-${gateId}`]);
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: run.attempt });
    expect(h.handled.length).toBe(1);
    expect((await outboxRow(gateId)).status).toBe("done");
    hang.resolve(undefined);
    await first;
    expect(h.handled.length).toBe(1);
    await expectNoStrand(run, gateId);
  }, 20_000);

  it("T2 RED (ii) a send longer than the lease keeps its lease; no second delivery takes the gate", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const { entered, hang } = hangFirstSend();
    const first = delivery.sweepArtifactReviewResumeIntents({ limit: 1, leaseMs: 1000 });
    await entered.promise;
    await sleep(2500);
    const second = await delivery.sweepArtifactReviewResumeIntents({ limit: 1, leaseMs: 1000 });
    expect(second.attempted).toBe(0);
    expect(h.sends.length).toBe(1);
    hang.reject(new Error("wayflow timed out"));
    expect((await first).failed).toBe(1);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await intentState(gateId)).toMatchObject({ claimed: false, result: null, status: "delivering" });
    await expectNoStrand(run, gateId);
  }, 20_000);

  it("T3 RED (ii) a first send that fails after it lost its lease does not park the decided gate", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    const { entered, hang } = hangFirstSend();
    const outcome = delivery.deliverArtifactReviewResumeIntent(row, { leaseMs: 60_000 });
    await entered.promise;
    await steal(gateId);
    hang.reject(new Error("wayflow unreachable"));
    await expect(outcome).resolves.toBe("lease-lost");
    expect((await runState(run.runId)).status).toBe("running");
    expect(await outboxRow(gateId)).toEqual({ status: "delivering", leaseToken: "other" });
    await expectNoStrand(run, gateId);
  });

  it("T4 a lost run CAS records no claim and closes as already advanced", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.beforeScope = async () => { await pool(`UPDATE ${T("agent_runs")} SET status = 'running' WHERE id = $1`, [run.runId]); };
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("already-advanced");
    expect(h.sends.length).toBe(0);
    expect(await intentState(gateId)).toMatchObject({ claimed: false, status: "done" });
    await expectNoStrand(run, gateId);
  });

  it("T6 running with no claim mark is another actor's resume: closed, not re-sent", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true });
    const summary = await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(summary.alreadyAdvanced).toBe(1);
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect((await outboxRow(gateId)).status).toBe("done");
  });

  it("T12 RED (iii) a handler that wrote Redis and died before its CAS is replayed from the recorded result, not closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const entered = deferred();
    const hang = deferred();
    let firstHandler = true;
    h.handlerImpl = async (input) => {
      if (!firstHandler) return;
      firstHandler = false;
      // The handler names the next gate in Redis, then dies before its status CAS.
      h.latestTask = (input as { task: { id: string } }).task.id;
      entered.resolve();
      await hang.promise;
    };
    const first = delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    await entered.promise;
    await expire(gateId);
    await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(h.sends.length).toBe(1);
    expect(h.handled.length).toBe(2);
    expect(h.handled[1]).toEqual({ runId: run.runId, fromStatus: "running", taskId: h.handled[0]!.taskId });
    expect((await outboxRow(gateId)).status).toBe("done");
    hang.resolve();
    await first;
    await expectNoStrand(run, gateId);
  }, 20_000);

  it("T13 running, claimed, nothing recorded, Redis names another task: retryable, never closed or sent", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true });
    h.latestTask = "task-another";
    const summary = await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(summary.retryable).toBe(1);
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: true, result: null });
  });

  it("T14 RED the sweep claims one row at a time: a row behind a long send stays pending and unleased", async () => {
    const runA = await seedRun("pending_approval");
    const gateA = await seedIntent(runA);
    const runB = await seedRun("pending_approval");
    const gateB = await seedIntent(runB);
    const { entered, hang } = hangFirstSend();
    const sweep = delivery.sweepArtifactReviewResumeIntents({ limit: 5 });
    await entered.promise;
    const rows = [await outboxRow(gateA), await outboxRow(gateB)];
    expect(rows.map((r) => r.status).sort()).toEqual(["delivering", "pending"]);
    expect(rows.find((r) => r.status === "pending")!.leaseToken).toBeNull();
    hang.resolve(undefined);
    const summary = await sweep;
    expect(summary.attempted).toBe(2);
    expect(h.sends.length).toBe(2);
    await expectNoStrand(runA, gateA);
    await expectNoStrand(runB, gateB);
  }, 20_000);

  it("T15 a refused renewal stops the delivery before the send", async () => {
    // Row 5 (claimed, nothing recorded): no claim CAS runs, so the fence is the only guard.
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true });
    const [row] = await gateStore.claimPendingResumeIntents({ limit: 1, leaseMs: 60_000 });
    h.beforeScope = () => steal(gateId).then(() => undefined);
    expect(await delivery.deliverArtifactReviewResumeIntent(row!)).toBe("lease-lost");
    expect(h.sends.length).toBe(0);
    expect((await runState(run.runId)).status).toBe("running");
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", leaseToken: "other", claimed: true });
  });

  it("T15 a renewal that throws is retried, not fatal", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const { entered, hang } = hangFirstSend();
    const first = delivery.sweepArtifactReviewResumeIntents({ limit: 1, leaseMs: 1000 });
    await entered.promise;
    h.renewThrows = 2;
    await sleep(1500);
    expect(h.renewThrows).toBe(0);
    expect((await intentState(gateId)).leaseLive).toBe(true);
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1, leaseMs: 1000 })).attempted).toBe(0);
    hang.resolve(undefined);
    expect((await first).delivered).toBe(1);
    expect((await outboxRow(gateId)).status).toBe("done");
  }, 20_000);

  it("T16 a stale worker's scope refusal cannot fail the run", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.scopeDenied = "the owning team is gone";
    h.beforeScope = () => steal(gateId).then(() => undefined);
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("lease-lost");
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await outboxRow(gateId)).toEqual({ status: "delivering", leaseToken: "other" });
    expect(h.sends.length).toBe(0);
  });

  it("T16 a release error other than a lost lease rethrows the send error, intent kept", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    const { entered, hang } = hangFirstSend();
    const outcome = delivery.deliverArtifactReviewResumeIntent(row, { leaseMs: 60_000 });
    await entered.promise;
    await pool(`UPDATE ${T("agent_runs")} SET status = 'stopped' WHERE id = $1`, [run.runId]);
    hang.reject(new Error("wayflow unreachable"));
    await expect(outcome).rejects.toThrow("wayflow unreachable");
    expect(await outboxRow(gateId)).toEqual({ status: "delivering", leaseToken: row.leaseToken });
    // The next lease finds the run stopped and closes the intent (row 8).
    await expire(gateId);
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).alreadyAdvanced).toBe(1);
    expect(h.sends.length).toBe(1);
  });

  it("T19 a pre-wire mint failure after the claim releases under the lease; the next lease re-sends", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.mintError = new Error("token store down");
    await expect(delivery.deliverArtifactReviewResumeIntent(row)).rejects.toThrow("token store down");
    expect(h.sends.length).toBe(0);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false, result: null });
    h.mintError = null;
    await expire(gateId);
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).delivered).toBe(1);
    expect(h.sends.length).toBe(1);
    expect((await outboxRow(gateId)).status).toBe("done");
    await expectNoStrand(run, gateId);
  });

  it("T19 the recorded task result carries no run token", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    let recorded: unknown = undefined;
    h.handlerImpl = async () => { recorded = (await intentState(gateId)).result; };
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).delivered).toBe(1);
    expect(h.sends[0]!.metadata).toEqual({ [RUN_TOKEN_KEY]: "raw-run-token-3745" });
    expect(recorded).toMatchObject({ id: h.handled[0]!.taskId });
    expect(JSON.stringify(recorded)).not.toContain("raw-run-token-3745");
    expect(JSON.stringify(recorded)).not.toContain(RUN_TOKEN_KEY);
  });

  it("T20 a delivery whose handler moved the run on closes once another driver resumed the run", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true,
      result: { id: "task-recorded", status: { state: "input-required" } } });
    // The human or MCP resume of the run's later gate: an entry into running with no lease.
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", undefined, AUTHORITY as never);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, alreadyAdvanced: 1 });
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect((await outboxRow(gateId)).status).toBe("done");
  });
});

describe.skipIf(!HAS_DB)("D8: a claimed intent is never dead-lettered", () => {
  it("T17 a claimed intent at its final attempt is not dead-lettered; an unclaimed one is", async () => {
    const claimedRun = await seedRun("running");
    const claimedGate = await seedIntent(claimedRun, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 20, maxAttempts: 20 });
    const freeRun = await seedRun("pending_approval");
    const freeGate = await seedIntent(freeRun, { status: "delivering", leaseExpired: true, attempts: 20, maxAttempts: 20 });
    await gateStore.deadLetterExhaustedResumeIntents();
    expect((await intentState(claimedGate)).deadLettered).toBe(false);
    expect((await intentState(freeGate)).deadLettered).toBe(true);
    // The claimed one stays claimable, so a delivery can still close it.
    const reclaimed = await gateStore.claimPendingResumeIntents({ limit: 200, leaseMs: 60_000 });
    expect(reclaimed.map((r) => r.gateId)).toContain(claimedGate);
    expect(reclaimed.map((r) => r.gateId)).not.toContain(freeGate);
  });
});

describe.skipIf(!HAS_DB)("D7: the 0116 rollout guard on populated tables", () => {
  async function withGuardSchema<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    return admin(async (c) => {
      await c.query(`DROP SCHEMA IF EXISTS "${q(GUARD_SCHEMA)}" CASCADE`);
      await c.query(`CREATE SCHEMA "${q(GUARD_SCHEMA)}"`);
      await c.query(`SET search_path TO "${q(GUARD_SCHEMA)}"`);
      // The pre-0116 shapes: no claim columns.
      await c.query(`CREATE TABLE agent_runs (id text PRIMARY KEY, status text NOT NULL)`);
      await c.query(`CREATE TABLE artifact_review_resume_outbox (gate_id text PRIMARY KEY, run_id text NOT NULL,
        status text NOT NULL, dead_lettered_at timestamptz)`);
      await c.query(`CREATE TABLE pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`);
      return fn(c);
    });
  }
  type MigModule = { up: (pgm: { sql: (s: string) => void }) => void };
  /** Runs one module's up() the way the runner does: its statements in one transaction on this session. */
  async function migrate(c: Client, file: "core__0115_agent-run-outward-action-policy" | "core__0116_resume-intent-run-claim"): Promise<void> {
    const mod = (file === "core__0115_agent-run-outward-action-policy"
      ? await import("../../../../migrations/core/core__0115_agent-run-outward-action-policy.mjs")
      : await import("../../../../migrations/core/core__0116_resume-intent-run-claim.mjs")) as unknown as MigModule;
    const statements: string[] = [];
    mod.up({ sql: (s) => statements.push(s) });
    await c.query("BEGIN");
    try {
      for (const s of statements) await c.query(s);
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ($1, NOW())`, [file]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  }
  const columns = async (c: Client) => (await c.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'artifact_review_resume_outbox' ORDER BY column_name`, [GUARD_SCHEMA],
  )).rows.map((r) => (r as { column_name: string }).column_name);
  const seedClaimedByOldDelivery = (c: Client) => c.query(
    `INSERT INTO agent_runs VALUES ('run-old', 'running');
     INSERT INTO artifact_review_resume_outbox VALUES ('gate-old', 'run-old', 'delivering', NULL)`);

  it("T18 0115 applied in this same session: the columns are added and every row is kept, with NULLs", async () => {
    await withGuardSchema(async (c) => {
      await seedClaimedByOldDelivery(c);
      await migrate(c, "core__0115_agent-run-outward-action-policy");
      await migrate(c, "core__0116_resume-intent-run-claim");
      expect(await columns(c)).toEqual(expect.arrayContaining(["resume_task_result", "run_claimed_at"]));
      const rows = (await c.query(`SELECT gate_id, status, run_claimed_at, resume_task_result FROM artifact_review_resume_outbox`)).rows;
      expect(rows).toEqual([{ gate_id: "gate-old", status: "delivering", run_claimed_at: null, resume_task_result: null }]);
    });
  });

  it("T18 0115 from an earlier session with an unmarked claimed run: the migration refuses and changes nothing", async () => {
    await withGuardSchema(async (c) => {
      await seedClaimedByOldDelivery(c);
      // An earlier boot ran 0115 (its row, recorded a minute "in the future" so no clock
      // can call it this session's); this session never ran 0115's statements.
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('core__0115_agent-run-outward-action-policy', now() + interval '1 minute')`);
      await expect(migrate(c, "core__0116_resume-intent-run-claim")).rejects.toThrow(/core__0116: 1 resume intent\(s\) .*agent_run_stop/);
      expect(await columns(c)).not.toContain("run_claimed_at");
      expect((await c.query(`SELECT count(*)::int AS n FROM artifact_review_resume_outbox`)).rows[0]).toEqual({ n: 1 });
      expect((await c.query(`SELECT count(*)::int AS n FROM pgmigrations WHERE name = 'core__0116_resume-intent-run-claim'`)).rows[0]).toEqual({ n: 0 });
    });
  });

  it("T18 0115 from an earlier session with no unmarked claimed run: the migration passes", async () => {
    await withGuardSchema(async (c) => {
      await c.query(`INSERT INTO agent_runs VALUES ('run-p', 'pending_approval'), ('run-r', 'running'), ('run-d', 'running');
        INSERT INTO artifact_review_resume_outbox VALUES ('gate-p', 'run-p', 'delivering', NULL), ('gate-r', 'run-r', 'done', NULL),
          ('gate-d', 'run-d', 'delivering', now())`);
      await c.query(`INSERT INTO pgmigrations (name, run_on) VALUES ('core__0115_agent-run-outward-action-policy', now() - interval '1 day')`);
      await migrate(c, "core__0116_resume-intent-run-claim");
      expect(await columns(c)).toEqual(expect.arrayContaining(["resume_task_result", "run_claimed_at"]));
    });
  });
});
