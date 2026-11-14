/**
 * cinatra#3745 — THE RESUME DELIVERY'S CLAIM, ON A REAL DATABASE.
 *
 * The artifact-review resume delivery moves a paused run `pending_approval ->
 * running` before it sends. This file drives the real transitionRunStatus, the
 * real gate store and the real sweeper on Postgres, and mocks only the A2A client,
 * the run-token mint and handleWayflowTaskState. It proves:
 *
 *   - a claimed delivery that dies, outlives its lease, loses its lease or
 *     fails before the wire is re-sent, replayed or left alone, never closed early;
 *   - a run another driver holds, with no recorded task of this gate, leaves the
 *     intent for a later lease: a competing claim that fails before its dispatch
 *     never closes the intent, and each deferral uses its attempt (cinatra#4312);
 *   - the sweep claims one row at a time and renews the lease of the row it delivers;
 *   - a claimed intent whose run another driver stopped, failed or finished is
 *     closed by the next lease without a send, its last attempt included;
 *   - a claimed intent stays within its attempts (cinatra#4312): the claim of its
 *     last attempt puts the run back on its gate without a send, and the
 *     dead-letter pass then takes the intent;
 *   - a last claim that dies before its delivery is settled by the next sweep:
 *     the run goes back on its gate, then the intent is dead-lettered; a
 *     last-attempt release is bound to the execution attempt it read.
 *
 * The run edges' lease fence and the claim marks themselves are proven in
 * `resume-intent-run-edge-claim-3745.integration.test.ts`.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-delivery-claim-3745
 *
 * cinatra#4245: the delivery's claim of the run IS the pause fence. It claims the
 * pause at the generation it read, and its `pending_approval -> running` edge
 * carries the fence and the intent's lease together; another driver's claim in
 * these cases takes a fence too (`pauseFenceFor`). The last describe block reads
 * the fence itself: during the send a stop is refused and after it the pause
 * lease is settled; a pause another claimer holds leaves the intent for a later
 * lease; a fence whose intent lease is gone gives the pause claim back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_resume_delivery_claim_3745";
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
  /** Runs inside the run-token mint, after the pause claim and before the fence: another actor's move. */
  duringMint: null as null | (() => Promise<void>),
  scopeDenied: null as null | string,
  /** Runs inside the scope recheck, before the claim: another actor's move. */
  beforeScope: null as null | (() => Promise<void>),
  /** Renewals that throw before they reach the store, counted down. */
  renewThrows: 0,
  /** Runs once the delivery read its claim, before it acts on it: another actor's move. */
  afterClaimRead: null as null | (() => Promise<void>),
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
    if (h.duringMint) await h.duringMint();
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
  readResumeIntentClaim: async (...args: Parameters<typeof actual.readResumeIntentClaim>) => {
    const claim = await actual.readResumeIntentClaim(...args);
    const hook = h.afterClaimRead;
    h.afterClaimRead = null;
    if (hook) await hook();
    return claim;
  },
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
let pauseClaims: typeof import("../run-pause-claim");

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
 *  a case names them. */
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

/** cinatra#4245: another driver's claim of the run is the pause fence. It claims the
 *  pause at the run's live generation and returns the fence for its edge. */
async function pauseFenceFor(runId: string): Promise<{ pauseFence: { token: string; generation: number } }> {
  const r = await pool(`SELECT pause_generation FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const generation = Number((r.rows[0] as { pause_generation: number | string }).pause_generation);
  const claim = await pauseClaims.claimPause({ runId, orgId: ORG, generation }, AUTHORITY as never);
  if (claim.kind !== "claimed") throw new Error(`pauseFenceFor: the pause claim of ${runId} was refused (${claim.reason})`);
  return { pauseFence: { token: claim.token, generation: claim.generation } };
}

async function pauseClaimState(runId: string): Promise<{ status: string; token: string | null; phase: string | null }> {
  const r = await pool(`SELECT status, pause_claim_token, pause_claim_phase FROM ${T("agent_runs")} WHERE id = $1`, [runId]);
  const row = r.rows[0] as { status: string; pause_claim_token: string | null; pause_claim_phase: string | null };
  return { status: row.status, token: row.pause_claim_token, phase: row.pause_claim_phase };
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
  pauseClaims = await import("../run-pause-claim");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
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
  h.duringMint = null;
  h.scopeDenied = null;
  h.beforeScope = null;
  h.renewThrows = 0;
  h.afterClaimRead = null;
});

describe.skipIf(!HAS_DB)("the delivery re-sends, replays or leaves alone; it never closes early", () => {
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

  it("T4 a lost run CAS records no claim, closes nothing and keeps the attempt used", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.beforeScope = async () => { await pool(`UPDATE ${T("agent_runs")} SET status = 'running' WHERE id = $1`, [run.runId]); };
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("retryable");
    expect(h.sends.length).toBe(0);
    expect(await intentState(gateId)).toMatchObject({ claimed: false, status: "delivering", attempts: 1, leaseToken: row.leaseToken });
    await expectNoStrand(run, gateId);
  });

  it("T6 running with no claim mark and nothing recorded is another driver's hold: deferred, not closed or sent", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true });
    const summary = await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(summary).toMatchObject({ attempted: 1, retryable: 1, alreadyAdvanced: 0 });
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false, attempts: 2 });
  });

  it("T22 a competing claim that fails before its dispatch does not close the intent: the next lease sends", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    // An MCP or human resume claims the gate after this delivery read the run ...
    h.beforeScope = async () => {
      await transitions.transitionRunStatus(run.runId, "pending_approval", "running", await pauseFenceFor(run.runId), AUTHORITY as never);
    };
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("retryable");
    h.beforeScope = null;
    expect(h.sends.length).toBe(0);
    // ... and puts it back before its dispatch, as claimGateForResume and the human path do.
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", undefined, AUTHORITY as never);
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false, attempts: 1 });
    await expire(gateId);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, delivered: 1 });
    expect(h.sends.map((x) => x.messageId)).toEqual([`artifact-review-resume-${gateId}`]);
    expect((await runState(run.runId)).status).toBe("running");
    expect((await outboxRow(gateId)).status).toBe("done");
  });

  it("T23 a run another driver holds is left for a later lease; once that driver puts it back, the next lease sends", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", await pauseFenceFor(run.runId), AUTHORITY as never);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, retryable: 1 });
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false, attempts: 1 });
    expect(h.sends.length).toBe(0);
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", undefined, AUTHORITY as never);
    await expire(gateId);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, delivered: 1 });
    expect(h.sends.length).toBe(1);
    expect((await outboxRow(gateId)).status).toBe("done");
  });

  it("T24 a scope refusal that loses its CAS to another driver stamps nothing; the next lease fails the run", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.scopeDenied = "the owning team is gone";
    h.beforeScope = async () => {
      await transitions.transitionRunStatus(run.runId, "pending_approval", "running", await pauseFenceFor(run.runId), AUTHORITY as never);
    };
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("retryable");
    h.beforeScope = null;
    expect(await intentState(gateId)).toMatchObject({ status: "delivering" });
    expect((await runState(run.runId)).status).toBe("running");
    await transitions.transitionRunStatus(run.runId, "running", "pending_approval", undefined, AUTHORITY as never);
    await expire(gateId);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, refusedOutOfScope: 1 });
    expect((await runState(run.runId)).status).toBe("failed");
    expect((await outboxRow(gateId)).status).toBe("done");
    expect(h.sends.length).toBe(0);
  });

  it("T25 a deferral at the last attempt uses it: the dead-letter pass takes the intent (cinatra#4312)", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { attempts: 19, maxAttempts: 20 });
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, retryable: 1 });
    expect(h.sends.length).toBe(0);
    await expire(gateId);
    await gateStore.deadLetterExhaustedResumeIntents();
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", attempts: 20, deadLettered: true });
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).attempted).toBe(0);
  });

  it("T26 the last attempt of a claimed intent with nothing recorded puts the run back on its gate, sends nothing, and is dead-lettered (cinatra#4312)", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 19, maxAttempts: 20 });
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, retryable: 1 });
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false, attempts: 20, deadLettered: false });
    await expire(gateId);
    await gateStore.deadLetterExhaustedResumeIntents();
    expect(await intentState(gateId)).toMatchObject({ deadLettered: true });
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).attempted).toBe(0);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    await expectNoStrand(run, gateId);
  });

  it("T27 a claim that takes the last attempt and dies before its delivery: the next sweep puts the run back on its gate, then dead-letters the intent", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 19, maxAttempts: 20 });
    // The claim of the last attempt; the worker dies before the delivery runs.
    const row = await claimOne(gateId);
    expect(row.attempts).toBe(20);
    await expire(gateId);
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: true, attempts: 20, deadLettered: false, leaseLive: false });
    const summary = await delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    expect(summary).toMatchObject({ attempted: 0, failed: 0 });
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect(await runState(run.runId)).toEqual({ status: "pending_approval", attempt: run.attempt });
    expect(await intentState(gateId)).toMatchObject({ claimed: false, attempts: 20, deadLettered: true });
    expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).attempted).toBe(0);
    await expectNoStrand(run, gateId);
  });

  it("T27 the dead-letter pass alone leaves a claimed intent that used its attempts to its settle", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 20, maxAttempts: 20 });
    await gateStore.deadLetterExhaustedResumeIntents();
    expect(await intentState(gateId)).toMatchObject({ claimed: true, deadLettered: false });
    expect((await runState(run.runId)).status).toBe("running");
  });

  it("T28 a last-attempt release whose run was dispatched again under a fresh attempt leaves the new execution untouched", async () => {
    const run = await seedRun("running");
    const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 19, maxAttempts: 20 });
    const row = await claimOne(gateId);
    const fresh = randomUUID();
    // After the delivery read the run (execution A) and its claim, the run was
    // stopped and dispatched again under a fresh attempt (execution B).
    h.afterClaimRead = async () => {
      await pool(`UPDATE ${T("agent_runs")} SET execution_attempt_id = $2 WHERE id = $1`, [run.runId, fresh]);
    };
    expect(await delivery.deliverArtifactReviewResumeIntent(row)).toBe("retryable");
    expect(await runState(run.runId)).toEqual({ status: "running", attempt: fresh });
    expect(h.sends.length).toBe(0);
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

  it("T19 a pre-wire mint failure after the pause claim gives the claim back and moves no run; the next lease re-sends", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const row = await claimOne(gateId);
    h.mintError = new Error("token store down");
    await expect(delivery.deliverArtifactReviewResumeIntent(row)).rejects.toThrow("token store down");
    expect(h.sends.length).toBe(0);
    expect((await runState(run.runId)).status).toBe("pending_approval");
    expect(await pauseClaimState(run.runId)).toMatchObject({ token: null, phase: null });
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
    await transitions.transitionRunStatus(run.runId, "pending_approval", "running", await pauseFenceFor(run.runId), AUTHORITY as never);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, alreadyAdvanced: 1 });
    expect(h.sends.length).toBe(0);
    expect(h.handled.length).toBe(0);
    expect((await outboxRow(gateId)).status).toBe("done");
  });
});

describe.skipIf(!HAS_DB)("a claimed intent whose run another driver ended is closed, never re-claimed forever", () => {
  // A claimed intent is bounded by its attempts like any other (cinatra#4312).
  // The delivery closes it once its run has left this gate, on its last attempt too.
  for (const ended of ["stopped", "failed", "completed"] as const) {
    it(`a claimed intent at its last attempt, its run ${ended}, closes on that lease without a send`, async () => {
      const run = await seedRun("running");
      const gateId = await seedIntent(run, { status: "delivering", leaseExpired: true, runClaimed: true, attempts: 19, maxAttempts: 20 });
      await pool(`UPDATE ${T("agent_runs")} SET status = $2 WHERE id = $1`, [run.runId, ended]);
      await gateStore.deadLetterExhaustedResumeIntents();
      expect((await intentState(gateId)).deadLettered).toBe(false);
      expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, alreadyAdvanced: 1 });
      expect(h.sends.length).toBe(0);
      expect(h.handled.length).toBe(0);
      expect((await outboxRow(gateId)).status).toBe("done");
      expect((await runState(run.runId)).status).toBe(ended);
      expect((await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).attempted).toBe(0);
    });
  }
});

describe.skipIf(!HAS_DB)("the delivery's claim of the run is the pause fence (cinatra#4245)", () => {
  const OUTBOX = () => T("artifact_review_resume_outbox");
  const steal = (gateId: string) => pool(`UPDATE ${OUTBOX()} SET lease_token = 'other' WHERE gate_id = $1`, [gateId]);
  const expire = (gateId: string) =>
    pool(`UPDATE ${OUTBOX()} SET lease_expires_at = now() - interval '1 second' WHERE gate_id = $1`, [gateId]);

  it("T29 RED during the send the run is running under the delivery's sending lease, a stop is refused, and the lease is settled after", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const entered = deferred();
    const hang = deferred<unknown>();
    h.sendImpl = async () => {
      entered.resolve();
      return hang.promise;
    };
    const sweep = delivery.sweepArtifactReviewResumeIntents({ limit: 1 });
    await entered.promise;
    const during = await pauseClaimState(run.runId);
    expect(during).toMatchObject({ status: "running", phase: "sending" });
    expect(during.token).not.toBeNull();
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: true });
    await expect(transitions.transitionRunStatus(run.runId, "running", "stopped", undefined, AUTHORITY as never))
      .rejects.toMatchObject({ code: "pause_resume_in_flight" });
    hang.resolve(undefined);
    expect((await sweep).delivered).toBe(1);
    // The mocked handler moves nothing: the run stays running, and the settle cleared the lease.
    expect(await pauseClaimState(run.runId)).toEqual({ status: "running", token: null, phase: null });
    expect(h.handled[0]).toMatchObject({ runId: run.runId, fromStatus: "running" });
    expect((await outboxRow(gateId)).status).toBe("done");
  }, 20_000);

  it("T30 a pause another claimer holds leaves the intent for a later lease; once that claim is given back, the next lease sends", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const { pauseFence } = await pauseFenceFor(run.runId);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, retryable: 1 });
    expect(h.sends.length).toBe(0);
    expect(await intentState(gateId)).toMatchObject({ status: "delivering", claimed: false });
    expect(await pauseClaims.releasePauseClaim({ runId: run.runId, orgId: ORG, token: pauseFence.token }, AUTHORITY as never)).toBe("released");
    await expire(gateId);
    expect(await delivery.sweepArtifactReviewResumeIntents({ limit: 1 })).toMatchObject({ attempted: 1, delivered: 1 });
    expect(h.sends.length).toBe(1);
    expect((await outboxRow(gateId)).status).toBe("done");
    await expectNoStrand(run, gateId);
  });

  it("T31 RED a fence whose intent lease was taken gives the pause claim back, moves no run and sends nothing", async () => {
    const run = await seedRun("pending_approval");
    const gateId = await seedIntent(run);
    const [row] = await gateStore.claimPendingResumeIntents({ limit: 1, leaseMs: 60_000 });
    expect(row?.gateId).toBe(gateId);
    h.duringMint = () => steal(gateId).then(() => undefined);
    expect(await delivery.deliverArtifactReviewResumeIntent(row!)).toBe("lease-lost");
    expect(h.sends.length).toBe(0);
    expect(await pauseClaimState(run.runId)).toEqual({ status: "pending_approval", token: null, phase: null });
    expect(await outboxRow(gateId)).toEqual({ status: "delivering", leaseToken: "other" });
  });
});
