/**
 * cinatra#3745 — A RESUMED ORCHESTRATOR LEG KEEPS ITS RUN-SOURCE BINDING, ON A REAL DATABASE.
 *
 * A run's step-tool policy is bound to the execution attempt that dispatched it
 * (`bindRunStepToolPolicy`, at the first dispatch). The source checks
 * (`verifyRunExecutedSource`, `isRunExecutedSourceCurrent`) admit a callback only
 * while the run is `running` under that bound attempt. A stopped orchestrator
 * resumes under a FRESH attempt, so its resume must carry the binding to that
 * attempt in the same transaction as its `queued -> running` claim, or refuse.
 * This file drives that resume through its REAL status transitions (no mocked
 * "running") and reads the source checks at the moment the resumed leg calls back
 * (inside `sendTask`):
 *
 *   the stopped-orchestrator resume (stopped -> queued -> running, fresh attempt).
 *
 * And that a stale or foreign attempt is still refused, and nothing is sent.
 * Nothing in the request path calls the source checks yet; this file reads them
 * directly, the way the callbacks will.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@localhost:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration resume-legs-run-source-3745
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_resume_run_source_3745";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3745-resume";
const USER = "user-3745-resume";
const AUTHORITY = { orgId: ORG, can: () => true };
const STEP = "call_llm_bridge";
const RAW_SOURCE = readFileSync(join(__dirname, "fixtures", "synthetic-gemini-agent.json"), "utf-8");

type Callback = {
  admitted: boolean;
  code?: string;
  cause?: string;
  current?: boolean;
  status: string | null;
  runAttempt: string | null;
  boundAttempt: string | null;
};

const h = vi.hoisted(() => ({
  runId: "",
  contextId: "",
  taskId: "",
  callbacks: [] as unknown[],
  handled: [] as Array<{ fromStatus: string }>,
  onSend: null as null | (() => Promise<unknown>),
  sendError: null as null | Error,
  sends: 0,
  staleRead: null as unknown,
  mintError: null as null | Error,
  createError: null as null | Error,
  runPatch: null as null | Record<string, unknown>,
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => {
    if (h.createError) throw h.createError;
    return {
      sendTask: vi.fn(async () => {
        h.sends++;
        if (h.onSend) h.callbacks.push(await h.onSend());
        if (h.sendError) throw h.sendError;
        return { id: `task-next-${randomUUID()}`, contextId: h.contextId, status: { state: "completed" } };
      }),
    };
  }),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => h.taskId),
  // The terminal edge's best-effort stream expiry (a stop is terminal).
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../execution", () => ({
  handleWayflowTaskState: vi.fn(async (input: { fromStatus: string }) => {
    h.handled.push({ fromStatus: input.fromStatus });
  }),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => {
    if (h.mintError) throw h.mintError;
    return { cinatra_run_token: "token" };
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
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../store", async (orig) => {
  const actual = await orig<typeof import("../store")>();
  return {
    ...actual,
    // The real row read, without the session-derived visibility filter. `runPatch`
    // models a caller snapshot taken before another writer moved the row (T11).
    readAgentRunById: async (id: string) => {
      const run = await actual.readAgentRunById(id);
      const patch = h.runPatch;
      h.runPatch = null;
      return run && patch ? { ...run, ...patch } : run;
    },
    // A read taken before another writer moved the run (the race the claim closes).
    readAgentRunByTaskId: async (taskId: string) => {
      const stale = h.staleRead as Awaited<ReturnType<typeof actual.readAgentRunByTaskId>> | null;
      h.staleRead = null;
      return stale ?? actual.readAgentRunByTaskId(taskId);
    },
    readAgentTemplateById: vi.fn(async () => ({
      id: "tpl-3745",
      name: "Resume template",
      packageName: "@cinatra-ai/resume-test-agent",
      sourceType: "internal",
      status: "published",
      type: "leaf",
      agentAuthPolicy: null,
    })),
    readRunCoOwners: vi.fn(async () => []),
    writeHitlPrompt: vi.fn(async () => undefined),
  };
});
vi.mock("../artifact-review-gate-store", async (orig) => ({
  ...(await orig<typeof import("../artifact-review-gate-store")>()),
  listReviewGatesForRun: vi.fn(async () => [
    { runId: h.runId, orgId: ORG, reviewTaskId: `wayflow-${h.taskId}`, status: "resolved",
      pinnedTargets: [{ artifactId: "post", representationRevisionId: "r1" }] },
  ]),
}));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintAgentRunExecutionAuthority: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("@/lib/org-write/authority", async (orig) => ({
  ...(await orig<typeof import("@/lib/org-write/authority")>()),
  sessionAuthorityFromResolvedRole: () => ({ orgId: ORG, can: () => true }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: USER, role: "user" },
    session: { id: "s", userId: USER, activeOrganizationId: ORG },
  })),
  requireAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForUser: vi.fn(async () => "owner"),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn(async () => undefined) }));

let serde: typeof import("../agent-run-serde");
let transitions: typeof import("../run-transition");
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

function attestation() {
  const policy = serde.createRunStepToolPolicy({ contextId: h.contextId, rawSource: RAW_SOURCE });
  return {
    policy,
    attestation: {
      contextId: h.contextId,
      stepId: STEP,
      sourceSha256: policy.sourceSha256,
      executedSourceSha256: policy.executedSourceSha256,
      declarationSourceSha256: policy.declarationSourceSha256,
    },
  };
}

async function rows() {
  const r = await pool(
    `SELECT r.status, r.execution_attempt_id AS run_attempt, b.execution_attempt_id AS bound_attempt
       FROM "${q(TEST_SCHEMA)}"."agent_runs" r
       LEFT JOIN "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" b ON b.run_id = r.id
      WHERE r.id = $1`,
    [h.runId],
  );
  const row = r.rows[0] as { status: string; run_attempt: string | null; bound_attempt: string | null } | undefined;
  return { status: row?.status ?? null, runAttempt: row?.run_attempt ?? null, boundAttempt: row?.bound_attempt ?? null };
}

/** THE RESUMED LEG CALLS BACK: the llm-bridge's own gate (a refusal there is the
 *  route's 403 `run_source_mismatch`), then the declared-tool currency check, and
 *  the three fields the reviewed-action run fence reads. */
async function callback(): Promise<Callback> {
  const state = await rows();
  try {
    const proof = await serde.verifyRunExecutedSource(h.runId, ORG, attestation().attestation);
    const current = await serde.isRunExecutedSourceCurrent(h.runId, ORG, proof);
    return { admitted: true, current, ...state };
  } catch (err) {
    return { admitted: false, code: "run_source_mismatch", cause: (err as { code?: string }).code, ...state };
  }
}

/** A run that dispatched for real: running under attempt A, its graph bound to A
 *  by the real first-dispatch bind, then moved to `toStatus` by the real CAS. */
async function seedDispatchedRun(toStatus: "pending_approval" | "stopped" | "failed") {
  h.runId = `run-${randomUUID()}`;
  h.contextId = `ctx-${randomUUID()}`;
  h.taskId = `task-${randomUUID()}`;
  const attemptA = randomUUID();
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, status, input_params, run_by, execution_attempt_id, a2a_context_id, a2a_task_id)
     VALUES ($1, 'tpl-3745', $2, 'running', '{}', $3, $4, $5, $6)`,
    [h.runId, ORG, USER, attemptA, h.contextId, h.taskId],
  );
  await serde.bindRunStepToolPolicy({ orgId: ORG, runId: h.runId, executionAttemptId: attemptA,
    policy: attestation().policy, authority: AUTHORITY as never });
  await transitions.transitionRunStatus(h.runId, "running", toStatus, undefined, AUTHORITY as never);
  return attemptA;
}

/** A binding held by an attempt the run never carried: a stale or foreign one. */
async function rebindToForeignAttempt() {
  const foreign = randomUUID();
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" SET execution_attempt_id = $2 WHERE run_id = $1`,
    [h.runId, foreign],
  );
  return foreign;
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
  serde = await import("../agent-run-serde");
  transitions = await import("../run-transition");
  dbMod = await import("../db");
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin((c) => c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`));
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
});

beforeEach(() => {
  h.callbacks = [];
  h.handled = [];
  h.onSend = callback;
  h.sendError = null;
  h.sends = 0;
  h.staleRead = null;
  h.mintError = null;
  h.createError = null;
  h.runPatch = null;
});

describe.skipIf(!HAS_DB)("(c) the stopped-orchestrator resume", () => {
  it("claims a fresh attempt and carries the bound graph to it before the dispatch, so the approved callback is admitted", async () => {
    const attemptA = await seedDispatchedRun("stopped");
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: true });
    expect(h.callbacks).toHaveLength(1);
    const cb = h.callbacks[0] as Callback;
    expect(cb).toMatchObject({ admitted: true, current: true, status: "running" });
    expect(cb.runAttempt).not.toBe(attemptA);
    expect(cb.boundAttempt).toBe(cb.runAttempt);
    expect(await rows()).toEqual({ status: "running", runAttempt: cb.runAttempt, boundAttempt: cb.runAttempt });
  });

  it("a proof minted under the old attempt is no longer current after the resume", async () => {
    const attemptA = await seedDispatchedRun("stopped");
    const oldProof = { ...attestation().attestation, executionAttemptId: attemptA };
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    await resumeStoppedOrchestratorAction(h.runId);
    expect(await serde.isRunExecutedSourceCurrent(h.runId, ORG, oldProof)).toBe(false);
  });

  it("never admits a callback under a binding held by a foreign attempt", async () => {
    await seedDispatchedRun("stopped");
    const foreign = await rebindToForeignAttempt();
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    await resumeStoppedOrchestratorAction(h.runId);
    for (const cb of h.callbacks) expect(cb).toMatchObject({ admitted: false, code: "run_source_mismatch" });
    expect(await callback()).toMatchObject({ admitted: false, code: "run_source_mismatch", boundAttempt: foreign });
  });
});

describe.skipIf(!HAS_DB)("the claim's other exits", () => {
  it("(c) a binding held by a foreign attempt sends nothing and puts the run back to stopped", async () => {
    await seedDispatchedRun("stopped");
    const foreign = await rebindToForeignAttempt();
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: false, error: "resume failed" });
    expect(h.sends).toBe(0);
    expect(await rows()).toMatchObject({ status: "stopped", boundAttempt: foreign });
  });

  it("(c) a failed send puts the run back to stopped, and its binding stays on the attempt that dispatched", async () => {
    await seedDispatchedRun("stopped");
    h.sendError = new Error("wayflow unreachable");
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: false, error: "resume failed" });
    const after = await rows();
    expect(after.status).toBe("stopped");
    expect(after.boundAttempt).toBe(after.runAttempt);
    // A second resume carries it forward again from that attempt.
    h.sendError = null;
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: true });
    expect(h.callbacks.at(-1)).toMatchObject({ admitted: true, current: true, status: "running" });
  });

  it("(c) a run that was never bound stays unbound: the resume is not a first bind", async () => {
    h.runId = `run-${randomUUID()}`;
    h.contextId = `ctx-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
         (id, template_id, org_id, status, input_params, run_by, execution_attempt_id, a2a_context_id)
       VALUES ($1, 'tpl-3745', $2, 'stopped', '{}', $3, $4, $5)`,
      [h.runId, ORG, USER, randomUUID(), h.contextId],
    );
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: true });
    expect(h.callbacks).toMatchObject([{ admitted: false, code: "run_source_mismatch", boundAttempt: null }]);
  });
});

describe.skipIf(!HAS_DB)("a failed run retried under a fresh attempt (reset, then run again)", () => {
  /** A dispatched run that failed, was reset (`failed -> pending_input`) and run again (`-> queued`), now
   *  claimed `queued -> running` by the canonical dispatch under a fresh attempt B, before its select and bind. */
  async function retried() {
    const attemptA = await seedDispatchedRun("failed");
    await transitions.transitionRunStatus(h.runId, "failed", "pending_input", undefined, AUTHORITY as never);
    await transitions.transitionRunStatus(h.runId, "pending_input", "queued", undefined, AUTHORITY as never);
    const attemptB = randomUUID();
    await transitions.transitionRunStatus(h.runId, "queued", "running", { dispatch: { attemptId: attemptB } }, AUTHORITY as never);
    return { attemptA, attemptB };
  }
  const otherGraph = () => {
    const graph = JSON.parse(RAW_SOURCE) as { $referenced_components: Record<string, Record<string, unknown>> };
    graph.$referenced_components[STEP]!.metadata = { cinatra: { tools: ["objects_get"] } };
    return JSON.stringify(graph);
  };

  it("the identical graph moves to the new attempt, so the retry dispatches and its callback is admitted", async () => {
    const { attemptA, attemptB } = await retried();
    expect(await rows()).toEqual({ status: "running", runAttempt: attemptB, boundAttempt: attemptA });
    await serde.bindRunStepToolPolicy({ orgId: ORG, runId: h.runId, executionAttemptId: attemptB,
      policy: attestation().policy, authority: AUTHORITY as never });
    expect(await rows()).toEqual({ status: "running", runAttempt: attemptB, boundAttempt: attemptB });
    expect(await callback()).toMatchObject({ admitted: true, current: true });
  });

  it("another graph is refused, and the binding stays on the attempt that dispatched it", async () => {
    const { attemptA, attemptB } = await retried();
    const other = serde.createRunStepToolPolicy({ contextId: h.contextId, rawSource: otherGraph() });
    await expect(serde.bindRunStepToolPolicy({ orgId: ORG, runId: h.runId, executionAttemptId: attemptB,
      policy: other, authority: AUTHORITY as never })).rejects.toThrow("step_tool_dispatch_rebind_refused");
    expect(await rows()).toEqual({ status: "running", runAttempt: attemptB, boundAttempt: attemptA });
    expect(await callback()).toMatchObject({ admitted: false, code: "run_source_mismatch" });
  });
});

describe.skipIf(!HAS_DB)("the dispatch transaction carries the bound graph, or refuses and commits nothing", () => {
  /** A dispatched run, stopped and re-queued for resume: the next `queued -> running` carries. */
  async function queuedForResume() {
    const attemptA = await seedDispatchedRun("stopped");
    await transitions.transitionRunStatus(h.runId, "stopped", "queued", undefined, AUTHORITY as never);
    return attemptA;
  }
  const dispatch = (attemptId: string) =>
    transitions.transitionRunStatus(h.runId, "queued", "running",
      { dispatch: { attemptId, carryBoundStepToolPolicy: true } }, AUTHORITY as never);

  it("carries the binding from the locked prior attempt to the dispatching one, once", async () => {
    await queuedForResume();
    const attemptB = randomUUID();
    await dispatch(attemptB);
    expect(await rows()).toEqual({ status: "running", runAttempt: attemptB, boundAttempt: attemptB });
    await expect(dispatch(randomUUID())).rejects.toMatchObject({ code: "stale_from_status" });
    expect((await rows()).boundAttempt).toBe(attemptB);
  });

  it("refuses a foreign or other-org binding, and commits neither the CAS nor the move", async () => {
    await queuedForResume();
    const foreign = await rebindToForeignAttempt();
    await expect(dispatch(randomUUID())).rejects.toThrow("step_tool_dispatch_rebind_refused");
    expect(await rows()).toMatchObject({ status: "queued", boundAttempt: foreign });
    const attemptA = await queuedForResume();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" SET org_id = 'org-other' WHERE run_id = $1`, [h.runId]);
    await expect(dispatch(randomUUID())).rejects.toThrow("step_tool_dispatch_rebind_refused");
    expect(await rows()).toEqual({ status: "queued", runAttempt: attemptA, boundAttempt: attemptA });
  });

  it("refuses an equal, empty or missing prior attempt, and leaves the binding where it was", async () => {
    const attemptA = await queuedForResume();
    await expect(dispatch(attemptA)).rejects.toThrow("step_tool_dispatch_rebind_refused");
    await expect(dispatch("")).rejects.toThrow("step_tool_dispatch_binding_mismatch");
    expect(await rows()).toEqual({ status: "queued", runAttempt: attemptA, boundAttempt: attemptA });
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET execution_attempt_id = NULL WHERE id = $1`, [h.runId]);
    await expect(dispatch(randomUUID())).rejects.toThrow("step_tool_dispatch_rebind_refused");
    expect(await rows()).toEqual({ status: "queued", runAttempt: null, boundAttempt: attemptA });
  });

  it("refuses a binding whose graph names another context", async () => {
    const attemptA = await queuedForResume();
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET a2a_context_id = $2 WHERE id = $1`, [h.runId, `ctx-${randomUUID()}`]);
    await expect(dispatch(randomUUID())).rejects.toThrow("step_tool_dispatch_rebind_refused");
    expect(await rows()).toMatchObject({ status: "queued", boundAttempt: attemptA });
  });

  it("leaves an unbound run unbound", async () => {
    await queuedForResume();
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" WHERE run_id = $1`, [h.runId]);
    const attemptB = randomUUID();
    await dispatch(attemptB);
    expect(await rows()).toEqual({ status: "running", runAttempt: attemptB, boundAttempt: null });
  });
});

/** Barrier: a backend is blocked on a row lock of the binding table (never a sleep alone).
 * `c` is the lock holder, inside its open transaction. Postgres reads the activity of all sessions once per
 * transaction, at the first access, and shows that same snapshot until the transaction ends, so every poll first
 * discards the snapshot; without that the barrier only ever sees the sessions as they were at its first poll. */
async function waitForBindingLockWaiter(c: Client) {
  for (let i = 0; i < 200; i++) {
    await c.query("SELECT pg_stat_clear_snapshot()");
    const r = await c.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
          AND query ILIKE '%agent_run_outward_action_policies%'`,
    );
    if ((r.rows[0] as { n: number }).n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("barrier: no backend ever waited on the binding lock");
}

describe.skipIf(!HAS_DB)("a resumed dispatch moves its step-tool binding in the same transaction", () => {
  it("T10 (c) the dispatch claim and the binding move commit together", async () => {
    const attemptA = await seedDispatchedRun("stopped");
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" WHERE run_id = $1 FOR UPDATE`, [h.runId]);
      const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
      const resumed = resumeStoppedOrchestratorAction(h.runId);
      await waitForBindingLockWaiter(holder);
      const seen = await admin(async (c) => (await c.query(
        `SELECT r.status, b.execution_attempt_id AS bound
           FROM "${q(TEST_SCHEMA)}"."agent_runs" r
           JOIN "${q(TEST_SCHEMA)}"."agent_run_outward_action_policies" b ON b.run_id = r.id
          WHERE r.id = $1`, [h.runId])).rows[0] as { status: string; bound: string });
      // Never `running` while the binding still names the prior attempt.
      expect({ status: seen.status, boundToPrior: seen.bound === attemptA }).not.toEqual({ status: "running", boundToPrior: true });
      await holder.query("COMMIT");
      expect(await resumed).toEqual({ ok: true });
      const after = await rows();
      expect(after.status).toBe("running");
      expect(after.runAttempt).not.toBe(attemptA);
      expect(after.boundAttempt).toBe(after.runAttempt);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end().catch(() => {});
    }
  });

  it("T11 (c) the prior attempt comes from the locked run row, never from the caller", async () => {
    const attemptB = await seedDispatchedRun("stopped");
    // The caller's snapshot carries attempt A; the locked row carries B, bound to B.
    h.runPatch = { executionAttemptId: randomUUID() };
    const { resumeStoppedOrchestratorAction } = await import("../orchestrator-actions");
    expect(await resumeStoppedOrchestratorAction(h.runId)).toEqual({ ok: true });
    const after = await rows();
    expect(after.status).toBe("running");
    expect(after.runAttempt).not.toBe(attemptB);
    expect(after.boundAttempt).toBe(after.runAttempt);
  });
});
