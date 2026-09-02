import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#3002 — a run executed on the agent runtime must leave its produced
// text where the run page reads it.
//
// The runtime completion path recorded the response in TWO places a reader
// cannot see: ephemeral AG-UI `TEXT_MESSAGE_*` frames (gone once the stream
// ends) and one `wayflow_response` entry in `agent_runs.step_results` (no
// screen renders that kind). The run's TRANSCRIPT — `agent_run_messages`, the
// rows the run page renders — was never written on this path, while the
// completion card told the reader the output was "in the run transcript
// below". This suite pins the missing writer:
//
//   1. terminal success persists the runtime's final response as the run's own
//      `final` transcript message;
//   2. it is written BEFORE the terminal transition, so the instant a reader
//      can see `completed` the text that card names already exists;
//   3. a run that returned no text writes no receipt (there is nothing to
//      show, and an empty row would be a false claim of output);
//   4. a re-entered terminal handling writes no second copy of the answer;
//   5. a run that lands `failed` on the materialization gate gets no receipt
//      at all — a success-shaped transcript row on a failed run is the same
//      lie this issue closes, pointed the other way.
//
// Harness mirrors wayflow-materialization-outcome-honesty.test.ts.
//
// Run:
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/wayflow-run-transcript-receipt.test.ts

const { publishAgUiEventSpy, materializeRunArtifactsSpy, recordRunFinalResponseMessageSpy } =
  vi.hoisted(() => ({
    publishAgUiEventSpy: vi.fn(async () => undefined),
    materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
    recordRunFinalResponseMessageSpy: vi.fn(async () => null),
  }));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: publishAgUiEventSpy,
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

vi.mock("../run-final-response-receipt", () => ({
  recordRunFinalResponseMessage: recordRunFinalResponseMessageSpy,
}));

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

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-3002", can: () => true };

/** The four named findings a real runtime run returned in the issue's own proof. */
const RUNTIME_ANSWER =
  "Four findings about the flow you handed me: the trigger never fires twice, " +
  "the retry budget is unbounded, the end node drops its structured outputs, " +
  "and the schedule is read in the wrong time zone.";

function makeRun(): AgentRunRecord {
  return {
    id: "run-3002",
    templateId: "tmpl-3002",
    versionId: null,
    runBy: "user-a",
    status: "running",
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
    a2aTaskId: "task-3002",
    a2aContextId: "ctx-3002",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-3002",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function completedTask(parts: Array<Record<string, unknown>>) {
  return {
    id: "task-3002",
    contextId: "ctx-3002",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [{ role: "agent", parts }],
  };
}

describe("cinatra#3002 — the runtime run's transcript receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
  });

  it("persists the runtime's final response as the run's own transcript message", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask([{ kind: "text", text: RUNTIME_ANSWER }]),
    });

    expect(recordRunFinalResponseMessageSpy).toHaveBeenCalledTimes(1);
    expect(recordRunFinalResponseMessageSpy).toHaveBeenCalledWith({
      runId: "run-3002",
      text: RUNTIME_ANSWER,
    });
  });

  it("writes the receipt BEFORE the terminal transition, never after it", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask([{ kind: "text", text: RUNTIME_ANSWER }]),
    });

    const receiptOrder =
      recordRunFinalResponseMessageSpy.mock.invocationCallOrder[0];
    const transitionOrder =
      storeMock.transitionRunStatus.mock.invocationCallOrder[0];
    expect(receiptOrder).toBeDefined();
    expect(transitionOrder).toBeDefined();
    expect(receiptOrder).toBeLessThan(transitionOrder);
    // …and after the materialization gate that can still route this handling
    // to `failed`, so no receipt is written for a run that does not complete.
    const materializeOrder = materializeRunArtifactsSpy.mock.invocationCallOrder[0];
    expect(materializeOrder).toBeDefined();
    expect(materializeOrder).toBeLessThan(receiptOrder);
    // and the transition that followed is the terminal-success one.
    const [, , to] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(to).toBe("completed");
  });

  it("writes no receipt when the run returned no text", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask([{ kind: "data", data: { note: "no text part" } }]),
    });

    expect(recordRunFinalResponseMessageSpy).not.toHaveBeenCalled();
  });

  it("writes NO receipt when the run lands failed on the materialization gate", async () => {
    // cinatra#2486 routes this same handling to `failed` when a declared
    // artifact was not delivered. A receipt written before that gate would
    // leave a success-shaped transcript row on a failed run — the same class of
    // lie this issue closes, pointed the other way.
    materializeRunArtifactsSpy.mockResolvedValue([
      { ok: false, outputId: "draft", nodeId: null, extension: null, error: "no binding" },
    ]);

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask([{ kind: "text", text: RUNTIME_ANSWER }]),
    });

    expect(recordRunFinalResponseMessageSpy).not.toHaveBeenCalled();
    const [, , to] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ];
    expect(to).toBe("failed");
  });

  it("writes no second receipt when the terminal handling is re-entered", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3002",
      run: { ...makeRun(), status: "completed" } as AgentRunRecord,
      fromStatus: "completed",
      task: completedTask([{ kind: "text", text: RUNTIME_ANSWER }]),
    });

    expect(recordRunFinalResponseMessageSpy).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});
