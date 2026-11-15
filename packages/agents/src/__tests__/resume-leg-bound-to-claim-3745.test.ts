import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#3745 — WAYFLOW'S ANSWER TO A CLAIMED RESUME IS BOUND TO THAT CLAIM, AND
// THE ANSWER'S TASK ID IS WRITTEN BEFORE THE RUN CAN PARK AT IT.
//
// `handleWayflowTaskState` is the one place a resume's answer moves the run. Two
// rules are proved here, on its wiring (the CAS itself is proved on the rows in
// `resume-intent-run-edge-claim-3745.integration.test.ts`):
//
//   1. With `claimedGate` (the MCP resume's claim), the answer is applied only
//      after `bindResumeLegToTask` found the run still at that claim; an answer
//      that comes back after the run was stopped and dispatched again writes
//      nothing at all. A bound answer's edges carry `resumeLeg` (the answer's
//      task, the claim's attempt), the produced-review hold included.
//   2. Without a claim, from `running` (the worker's dispatch, the human
//      resume), the answer's task id is the gate identity a later claim binds
//      to, so a failed write of it stops the handler before any edge: the run is
//      not parked under the earlier gate's id.
//   3. From `pending_approval` without a claim (the resume delivery), a failed
//      write of the answer's task id is logged and the answer is applied, as
//      before: stopping there would leave the run parked under the earlier
//      gate's id with the intent re-claimed, and the delivery would send the
//      earlier gate's decision again into the answer's context.

const { publishAgUiEventSpy, materializeRunArtifactsSpy, holdSpy, readBackSpy, bindSpy } = vi.hoisted(
  () => ({
    publishAgUiEventSpy: vi.fn(async () => undefined),
    materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
    holdSpy: vi.fn(async () => ({ held: false, reason: "no-produced-output" }) as {
      held: boolean;
      reason: string;
    }),
    readBackSpy: vi.fn(
      async () => null as { reviewTaskId: string; xRenderer: string | null } | null,
    ),
    bindSpy: vi.fn(async (_input: Record<string, unknown>) => true),
  }),
);

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
    readLatestAgUiInterrupt: readBackSpy,
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    DualAdapterDispatch: class MockDualAdapterDispatch {
      onInterrupt = vi.fn();
      onText = vi.fn();
      onTextChunk = vi.fn();
      onToolCall = vi.fn();
      onState = vi.fn();
      onError = vi.fn();
      onFinish = vi.fn();
      onResume = vi.fn();
    },
  };
});

vi.mock("@/lib/artifacts/run-artifact-materializer", () => ({
  materializeRunArtifacts: materializeRunArtifactsSpy,
}));

vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: holdSpy,
}));

// The handler imports the bind at the call (only on a claimed leg).
vi.mock("../run-transition", () => ({ bindResumeLegToTask: bindSpy }));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(args: { code: string }) {
      super(args.code);
      this.code = args.code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    rememberLatestWayflowGateTask: vi.fn(async () => undefined),
    rememberWayflowGateTask: vi.fn(async () => undefined),
    getOrAddWayflowRendererGateIndex: vi.fn(async () => 0),
  };
});
const enqueueBackgroundJobSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueueBackgroundJobSpy }));

import { handleWayflowTaskState, CINATRA_ENDNODE_OUTPUTS_SENTINEL } from "../execution";
import type { AgentRunRecord } from "../store";

const AUTHORITY = { orgId: "org-3745", can: () => true };
const GATE_TASK = "task-gate-a";
const NEXT_TASK = "task-next-b";
const CLAIM = { a2aTaskId: GATE_TASK, executionAttemptId: "attempt-e1" };

function makeRun(): AgentRunRecord {
  return {
    id: "run-3745",
    templateId: "tmpl-3745",
    versionId: null,
    runBy: "user-a",
    status: "pending_approval",
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: "1.0.0",
    a2aTaskId: GATE_TASK,
    a2aContextId: "ctx-3745",
    executionAttemptId: "attempt-e1",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-3745",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function failedTask() {
  return {
    id: NEXT_TASK,
    contextId: "ctx-3745-b",
    status: { state: "failed", message: { parts: [{ kind: "text", text: "the flow failed" }] } },
    metadata: {},
    history: [],
  };
}

function completedTask() {
  return {
    id: NEXT_TASK,
    contextId: "ctx-3745-b",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "here is the draft" }] },
      {
        role: "agent",
        parts: [{ kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: { title: "T", content: "C" } } }],
      },
    ],
  };
}

type Edge = [string, string, string, Record<string, unknown> | undefined, unknown];
const edges = () => storeMock.transitionRunStatus.mock.calls as unknown as Edge[];

describe("cinatra#3745 — the answer of a claimed resume is applied only while the run holds the claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
    holdSpy.mockResolvedValue({ held: false, reason: "no-produced-output" });
    readBackSpy.mockResolvedValue(null);
    bindSpy.mockResolvedValue(true);
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
  });

  it("an answer that returns after the run left the claim (stopped and dispatched again) writes nothing", async () => {
    bindSpy.mockResolvedValue(false);
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "running", task: failedTask(), claimedGate: CLAIM,
    });
    // No edge, no task-id or context overwrite, no hold, no announcement on the newer execution.
    expect(edges()).toEqual([]);
    expect(storeMock.updateAgentRunA2ATaskId).not.toHaveBeenCalled();
    expect(storeMock.updateAgentRunA2AContextId).not.toHaveBeenCalled();
    expect(holdSpy).not.toHaveBeenCalled();
    expect(publishAgUiEventSpy).not.toHaveBeenCalled();
    expect(bindSpy).toHaveBeenCalledWith({
      runId: "run-3745", orgId: "org-3745", claimed: CLAIM, taskId: NEXT_TASK, contextId: "ctx-3745-b",
    });
  });

  it("a bound answer's failure edge carries the leg in its CAS: the answer's task, the claim's attempt", async () => {
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "running", task: failedTask(), claimedGate: CLAIM,
    });
    expect(edges()).toHaveLength(1);
    const [runId, from, to, meta] = edges()[0];
    expect([runId, from, to]).toEqual(["run-3745", "running", "failed"]);
    expect(meta?.resumeLeg).toEqual({ a2aTaskId: NEXT_TASK, executionAttemptId: "attempt-e1" });
    expect(meta?.error).toBe("the flow failed");
    // The bind wrote the answer's task and context; the unconditional writers are not used.
    expect(storeMock.updateAgentRunA2ATaskId).not.toHaveBeenCalled();
    expect(storeMock.updateAgentRunA2AContextId).not.toHaveBeenCalled();
    expect(bindSpy).toHaveBeenCalledTimes(1);
  });

  it("a bound answer's completed edge and the produced-review hold it asks first carry the leg", async () => {
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "running", task: completedTask(), claimedGate: CLAIM,
    });
    const holdInput = (holdSpy.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined)?.[0];
    expect(holdInput?.resumeLeg).toEqual({ a2aTaskId: NEXT_TASK, executionAttemptId: "attempt-e1" });
    expect(edges()).toHaveLength(1);
    const [, from, to, meta] = edges()[0];
    expect([from, to]).toEqual(["running", "completed"]);
    expect(meta?.resumeLeg).toEqual({ a2aTaskId: NEXT_TASK, executionAttemptId: "attempt-e1" });
  });
});

describe("cinatra#3745 — without a claim, from running, the answer's task id is written before any edge, or nothing moves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
    holdSpy.mockResolvedValue({ held: false, reason: "no-produced-output" });
    readBackSpy.mockResolvedValue(null);
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
  });

  for (const [state, task] of [["failed", failedTask], ["completed", completedTask]] as const) {
    it(`a ${state} answer whose task id write fails stops before any edge or hold`, async () => {
      const writeError = new Error("could not write a2a_task_id");
      storeMock.updateAgentRunA2ATaskId.mockRejectedValue(writeError);
      await expect(
        handleWayflowTaskState({ authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "running", task: task() }),
      ).rejects.toBe(writeError);
      expect(edges()).toEqual([]);
      expect(holdSpy).not.toHaveBeenCalled();
      expect(bindSpy).not.toHaveBeenCalled();
    });
  }

  it("control: the answer's task id is written, then the edge, with no leg", async () => {
    const order: string[] = [];
    storeMock.updateAgentRunA2ATaskId.mockImplementation(async () => {
      order.push("task-id");
      return undefined;
    });
    storeMock.transitionRunStatus.mockImplementation(async () => {
      order.push("edge");
      return undefined;
    });
    await handleWayflowTaskState({
      authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "running", task: failedTask(),
    });
    expect(storeMock.updateAgentRunA2ATaskId).toHaveBeenCalledWith("run-3745", NEXT_TASK);
    expect(order).toEqual(["task-id", "edge"]);
    expect(edges()[0][3]?.resumeLeg).toBeUndefined();
    expect(bindSpy).not.toHaveBeenCalled();
  });
});

describe("cinatra#3745 — the resume delivery (from pending_approval, no claim) applies its answer when the task-id write fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
    holdSpy.mockResolvedValue({ held: false, reason: "no-produced-output" });
    readBackSpy.mockResolvedValue(null);
    storeMock.updateAgentRunA2ATaskId.mockResolvedValue(undefined);
  });

  for (const [state, task] of [["failed", failedTask], ["completed", completedTask]] as const) {
    it(`a ${state} answer whose task id write fails still moves the run off the gate`, async () => {
      storeMock.updateAgentRunA2ATaskId.mockRejectedValue(new Error("could not write a2a_task_id"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await handleWayflowTaskState({
          authority: AUTHORITY, runId: "run-3745", run: makeRun(), fromStatus: "pending_approval", task: task(),
        });
        expect(storeMock.updateAgentRunA2ATaskId).toHaveBeenCalledWith("run-3745", NEXT_TASK);
        // The run leaves pending_approval, so a re-claimed intent closes on the
        // delivery's status guard instead of sending the decision again.
        expect(edges()).toHaveLength(1);
        const [runId, from, to, meta] = edges()[0];
        expect([runId, from, to]).toEqual(["run-3745", "pending_approval", state]);
        expect(meta?.resumeLeg).toBeUndefined();
        expect(bindSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  }
});
