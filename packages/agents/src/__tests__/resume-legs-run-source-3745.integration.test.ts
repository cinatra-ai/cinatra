/**
 * cinatra#3745 — A RESUMED LEG IS ADMITTED BY THE RUN-SOURCE GATES, ON A REAL DATABASE.
 *
 * Every callback a WayFlow leg makes (the llm-bridge, a declared run tool, a
 * reviewed artifact action) is admitted only while the run is `running` under the
 * execution attempt its step-tool policy is bound to (`verifyRunExecutedSource`,
 * `isRunExecutedSourceCurrent`; the action consumer's run fence reads the same
 * three fields). This file drives the three resume roads through their REAL status
 * transitions — no mocked "running" — into those gates at the moment the resumed
 * leg calls back (inside `sendTask`), and asserts the approved callback is admitted:
 *
 *   (a) the artifact-review resume delivery (pending_approval -> resumed),
 *   (b) the MCP `agent_run_resume` primitive (pending_approval -> resumed),
 *   (c) the stopped-orchestrator resume (stopped -> queued -> running, fresh attempt).
 *
 * And, per road, that a stale or foreign attempt is still refused.
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
async function seedDispatchedRun(toStatus: "pending_approval" | "stopped") {
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

/** A resolved gate and its intent, leased to this worker: the delivery reads its
 *  claim columns and writes under that lease (cinatra#3745 D1-D4). */
async function approveIntent() {
  const gateId = `gate-${randomUUID()}`;
  const reviewTaskId = `wayflow-${h.taskId}`;
  const responseText = JSON.stringify({ approved: true });
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, 'resolved', '[{"artifactId":"post","representationRevisionId":"r1"}]'::jsonb, 'approve', $5, now())`,
    [gateId, h.runId, ORG, reviewTaskId, `fp-${gateId}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
       (gate_id, run_id, review_task_id, kind, response_text, status, attempts, lease_token, lease_expires_at)
     VALUES ($1, $2, $3, 'approve', $4, 'delivering', 1, 'lease-3745', now() + interval '5 minutes')`,
    [gateId, h.runId, reviewTaskId, responseText],
  );
  return {
    gateId,
    runId: h.runId,
    reviewTaskId,
    kind: "approve" as const,
    responseText,
    status: "delivering",
    attempts: 1,
    leaseToken: "lease-3745",
    leaseExpiresAt: new Date(Date.now() + 300_000),
    runClaimedAt: null,
    resumeTaskResult: null,
  };
}

async function resumeByMcp() {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return (await createAgentBuilderPrimitiveHandlers().agent_run_resume({
    primitiveName: "agent_run_resume",
    input: { runId: h.runId, userResponse: JSON.stringify({ approved: true }) },
    actor: { actorType: "user", source: "mcp", userId: USER },
    mode: "deterministic",
  })) as Record<string, unknown>;
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

describe.skipIf(!HAS_DB)("(a) the artifact-review resume delivery", () => {
  it("dispatches with the run running under its bound attempt, so the approved callback is admitted", async () => {
    const attemptA = await seedDispatchedRun("pending_approval");
    const { deliverArtifactReviewResumeIntent } = await import("../artifact-review-resume-delivery");
    expect(await deliverArtifactReviewResumeIntent((await approveIntent()) as never)).toBe("delivered");
    expect(h.callbacks).toEqual([{ admitted: true, current: true, status: "running", runAttempt: attemptA, boundAttempt: attemptA }]);
    expect(h.handled).toEqual([{ fromStatus: "running" }]);
  });

  it("still refuses the callback when the binding belongs to a stale or foreign attempt", async () => {
    await seedDispatchedRun("pending_approval");
    const foreign = await rebindToForeignAttempt();
    const { deliverArtifactReviewResumeIntent } = await import("../artifact-review-resume-delivery");
    await deliverArtifactReviewResumeIntent((await approveIntent()) as never);
    expect(h.callbacks).toHaveLength(1);
    expect(h.callbacks[0]).toMatchObject({ admitted: false, code: "run_source_mismatch",
      cause: "step_tool_run_source_inactive", boundAttempt: foreign });
  });
});

describe.skipIf(!HAS_DB)("(b) the MCP agent_run_resume primitive", () => {
  it("dispatches with the run running under its bound attempt, so the approved callback is admitted", async () => {
    const attemptA = await seedDispatchedRun("pending_approval");
    const result = await resumeByMcp();
    expect(result).not.toHaveProperty("error");
    expect(h.callbacks).toEqual([{ admitted: true, current: true, status: "running", runAttempt: attemptA, boundAttempt: attemptA }]);
    expect(h.handled).toEqual([{ fromStatus: "running" }]);
  });

  it("still refuses the callback when the binding belongs to a stale or foreign attempt", async () => {
    await seedDispatchedRun("pending_approval");
    const foreign = await rebindToForeignAttempt();
    await resumeByMcp();
    expect(h.callbacks).toHaveLength(1);
    expect(h.callbacks[0]).toMatchObject({ admitted: false, code: "run_source_mismatch",
      cause: "step_tool_run_source_inactive", boundAttempt: foreign });
  });
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
  it("(a) a failed send puts the gate back, so the intent is re-deliverable", async () => {
    const attemptA = await seedDispatchedRun("pending_approval");
    h.sendError = new Error("wayflow unreachable");
    const { deliverArtifactReviewResumeIntent } = await import("../artifact-review-resume-delivery");
    await expect(deliverArtifactReviewResumeIntent((await approveIntent()) as never)).rejects.toThrow("wayflow unreachable");
    expect(await rows()).toEqual({ status: "pending_approval", runAttempt: attemptA, boundAttempt: attemptA });
    expect(h.handled).toEqual([]);
  });

  it("(a) a run another writer already moved off the gate is not sent again", async () => {
    await seedDispatchedRun("pending_approval");
    const { deliverArtifactReviewResumeIntent } = await import("../artifact-review-resume-delivery");
    const { readAgentRunByTaskId } = await import("../store");
    h.staleRead = await readAgentRunByTaskId(h.taskId);
    expect((h.staleRead as { status: string }).status).toBe("pending_approval");
    await transitions.transitionRunStatus(h.runId, "pending_approval", "running", undefined, AUTHORITY as never);
    expect(await deliverArtifactReviewResumeIntent((await approveIntent()) as never)).toBe("already-advanced");
    expect(h.sends).toBe(0);
  });

  it("(b) two resumes of one gate: exactly one is sent, the other is refused", async () => {
    await seedDispatchedRun("pending_approval");
    const results = await Promise.all([resumeByMcp(), resumeByMcp()]);
    expect(h.sends).toBe(1);
    expect(results.filter((r) => "error" in r)).toHaveLength(1);
    expect(h.callbacks).toMatchObject([{ admitted: true, status: "running" }]);
  });

  it("(b) a resume whose run token cannot be minted sends nothing and puts the gate back", async () => {
    const attemptA = await seedDispatchedRun("pending_approval");
    h.mintError = new Error("token store unavailable");
    expect(await resumeByMcp()).toEqual({ error: "Resume failed: token store unavailable" });
    expect(h.sends).toBe(0);
    expect(await rows()).toEqual({ status: "pending_approval", runAttempt: attemptA, boundAttempt: attemptA });
    h.mintError = null;
    expect(await resumeByMcp()).not.toHaveProperty("error");
    expect(h.callbacks).toMatchObject([{ admitted: true, status: "running" }]);
  });

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

/** Barrier: a backend is blocked on a row lock of the binding table (never a sleep alone). */
async function waitForBindingLockWaiter(c: Client) {
  for (let i = 0; i < 200; i++) {
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

describe.skipIf(!HAS_DB)("NOTE 6: the dispatch claim and the binding move commit together", () => {
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

describe.skipIf(!HAS_DB)("NOTE 5 pins: agent_run_resume keeps its claim posture", () => {
  const settle = (p: Promise<Record<string, unknown>>) =>
    p.catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

  it("T8 agent_run_resume: WayFlow unreachable at client creation leaves the gate pending and a retry is sent", async () => {
    const attemptA = await seedDispatchedRun("pending_approval");
    h.createError = new Error("agent card unreachable");
    expect(await settle(resumeByMcp())).toHaveProperty("error");
    expect(h.sends).toBe(0);
    expect(await rows()).toEqual({ status: "pending_approval", runAttempt: attemptA, boundAttempt: attemptA });
    h.createError = null;
    expect(await resumeByMcp()).not.toHaveProperty("error");
    expect(h.sends).toBe(1);
    expect(h.callbacks).toMatchObject([{ admitted: true, status: "running" }]);
  });

  it("T9 agent_run_resume: a send that fails after the claim keeps the claim; the retry is refused as answered", async () => {
    await seedDispatchedRun("pending_approval");
    h.sendError = new Error("wayflow unreachable");
    expect(await settle(resumeByMcp())).toHaveProperty("error");
    expect(h.sends).toBe(1);
    expect((await rows()).status).toBe("running");
    h.sendError = null;
    const retry = await settle(resumeByMcp());
    // The run left pending_approval with the claim: the retry is refused before any send.
    expect(String(retry.error)).toMatch(/not pending approval|already answered/);
    expect(h.sends).toBe(1);
  });
});
