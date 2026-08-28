import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#3007 — the executor asks about the review BEFORE it writes a terminal
// status, and writes none when the answer holds the run.
//
// The ordering itself is proved on the rows in
// `produced-review-ordering.integration.test.ts`. What is proved HERE is the
// WIRING, at the one place the defect lived: `handleWayflowTaskState`'s terminal
// tail used to await materialization and then transition, with no reference to
// any review. Three properties:
//
//   1. The hold is consulted, and it is consulted BEFORE any transitionRunStatus
//      call — on the success edge and on the materialization-FAILURE edge alike,
//      because a failed run's produced output opens a review just the same.
//   2. A held run writes NO terminal status and announces no terminal AG-UI
//      event: the run is waiting, and a run that is waiting has not finished.
//   3. An unheld run is byte-identical to today — same transition, same meta,
//      same events — so a run whose output opens no review pays nothing.
//
// The withheld terminal write handed to the hold is asserted too: it is the
// transition the executor WOULD have made, verdict, error and derivation capture
// included, because that is what the decision later performs.

const { publishAgUiEventSpy, materializeRunArtifactsSpy, holdSpy } = vi.hoisted(() => ({
  publishAgUiEventSpy: vi.fn(async () => undefined),
  materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
  holdSpy: vi.fn(async () => ({ held: false, reason: "no-produced-output" }) as {
    held: boolean;
    reason: string;
  }),
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

vi.mock("../run-produced-review-hold", () => ({
  holdRunForProducedReview: holdSpy,
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

import { handleWayflowTaskState, CINATRA_ENDNODE_OUTPUTS_SENTINEL } from "../execution";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-3007", can: () => true };

function makeRun(): AgentRunRecord {
  return {
    id: "run-3007",
    templateId: "tmpl-3007",
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
    a2aTaskId: "task-3007",
    a2aContextId: "ctx-3007",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-3007",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function completedTask(outputs: Record<string, unknown>) {
  return {
    id: "task-3007",
    contextId: "ctx-3007",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "here is the draft" }] },
      {
        role: "agent",
        parts: [{ kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: outputs } }],
      },
    ],
  };
}

function holdInput() {
  const call = holdSpy.mock.calls.at(-1) as unknown as [Record<string, unknown>, unknown];
  return call?.[0];
}

function agUiEventTypes(): string[] {
  return publishAgUiEventSpy.mock.calls.map(
    (c) => (c as unknown as [string, { type?: string }])[1]?.type ?? "",
  );
}

async function run(fromStatus: "running" | "pending_approval" = "running") {
  await handleWayflowTaskState({
    authority: TEST_AUTHORITY,
    runId: "run-3007",
    run: makeRun(),
    fromStatus,
    task: completedTask({ title: "T", content: "C" }),
  });
}

describe("cinatra#3007 — the review question precedes the terminal write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
    holdSpy.mockResolvedValue({ held: false, reason: "no-produced-output" });
  });

  it("HELD: no terminal transition, no RUN_FINISHED — the run is waiting, not finished", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "gate-undecided" });

    await run();

    expect(holdSpy).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(agUiEventTypes()).not.toContain("RUN_FINISHED");
    expect(enqueueBackgroundJobSpy).not.toHaveBeenCalled();
  });

  it("HELD carries the terminal write the executor would have made — verdict + derivation", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "gate-undecided" });

    await run();

    const input = holdInput() as {
      runId: string;
      orgId: string;
      fromStatus: string;
      stepResults: Array<Record<string, unknown>>;
      withheld: { status: string; error?: string; derivationOutbox?: Record<string, unknown> };
    };
    expect(input.runId).toBe("run-3007");
    expect(input.orgId).toBe("org-3007");
    expect(input.fromStatus).toBe("running");
    expect(input.withheld.status).toBe("completed");
    expect(input.withheld.error).toBeUndefined();
    // The derivation-outbox capture rides with it: it is committed with the
    // terminal CAS, so the decision has to be able to perform that same write.
    expect(input.withheld.derivationOutbox?.contentHash).toEqual(expect.any(String));
    // ...and the payload is the terminal one, materialization outcomes included.
    expect(input.stepResults[0]?.kind).toBe("wayflow_response");
    expect(input.stepResults[0]?.artifact_materializations).toHaveLength(1);
  });

  it("HELD on the materialization-FAILURE edge too, carrying the failure as the withheld write", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "draft",
        nodeId: "end",
        extension: "@cinatra-ai/blog-post-artifact",
        error: 'contentFrom output "content" did not resolve to a string',
      },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "awaiting-orchestration" });

    await run();

    const input = holdInput() as { withheld: { status: string; error?: string } };
    expect(input.withheld.status).toBe("failed");
    expect(String(input.withheld.error)).toContain("did not resolve to a string");
    // The run is NOT failed yet — it is parked, and the decision performs that
    // failure. No terminal write, no RUN_ERROR announcement.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(agUiEventTypes()).not.toContain("RUN_ERROR");
  });

  it("NOT HELD: the success edge is byte-identical to before — same transition, same meta", async () => {
    await run();

    expect(holdSpy).toHaveBeenCalledTimes(1);
    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    const [runId, from, to, meta] = calls[0];
    expect([runId, from, to]).toEqual(["run-3007", "running", "completed"]);
    expect(meta?.completedAt).toBeInstanceOf(Date);
    expect(meta?.derivationOutbox).toBeDefined();
    expect(agUiEventTypes()).toContain("RUN_FINISHED");
  });

  it("NOT HELD on the failure edge: the #2486 honesty verdict is unchanged", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        error: "failed to load the run package's artifact bindings",
      },
    ]);

    await run();

    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe("failed");
    expect(String(calls[0][3]?.error)).toContain("(binding-resolution)");
    expect(agUiEventTypes()).toContain("RUN_ERROR");
  });

  it("the hold is asked BEFORE any terminal transition, never after", async () => {
    const order: string[] = [];
    holdSpy.mockImplementation(async () => {
      order.push("hold");
      return { held: false, reason: "no-produced-output" };
    });
    storeMock.transitionRunStatus.mockImplementation(async () => {
      order.push("transition");
      return undefined;
    });

    await run();

    expect(order).toEqual(["hold", "transition"]);
  });

  it("a resume from pending_approval asks the same question, with its own fromStatus", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      { ok: true, outputId: "draft", nodeId: "end", extension: "@cinatra-ai/blog-post-artifact" },
    ]);
    holdSpy.mockResolvedValue({ held: true, reason: "gate-undecided" });

    await run("pending_approval");

    expect((holdInput() as { fromStatus: string }).fromStatus).toBe("pending_approval");
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a THROWING hold seam FAILS CLOSED — a broken seam cannot prove the run owes no review", async () => {
    // The seam is total by contract, so this is the broken-seam case. Writing a
    // terminal status on an unanswerable review question is the defect itself, so
    // the run keeps its non-terminal status and the lease-expiry finalizer
    // reconciles it — a run left `running` is recoverable, a run falsely
    // `completed` is not (there is no legal edge out of it).
    holdSpy.mockRejectedValue(new Error("the seam itself is broken"));

    await run();

    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(agUiEventTypes()).not.toContain("RUN_FINISHED");
  });

  it("the WayFlow FAILURE branch asks the same question — `failed` is terminal too", async () => {
    holdSpy.mockResolvedValue({ held: true, reason: "gate-undecided" });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3007",
      run: makeRun(),
      fromStatus: "running",
      task: {
        id: "task-3007",
        contextId: "ctx-3007",
        status: { state: "failed", message: { parts: [{ kind: "text", text: "the flow failed" }] } },
        metadata: {},
        history: [],
      },
    });

    const input = holdInput() as { withheld: { status: string; error?: string } };
    expect(input.withheld).toEqual({ status: "failed", error: "the flow failed" });
    // A run that parks announces no end, because it has not reached one.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(agUiEventTypes()).not.toContain("RUN_ERROR");
  });

  it("the WayFlow FAILURE branch is unchanged when nothing holds the run", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-3007",
      run: makeRun(),
      fromStatus: "running",
      task: {
        id: "task-3007",
        contextId: "ctx-3007",
        status: { state: "failed", message: { parts: [{ kind: "text", text: "the flow failed" }] } },
        metadata: {},
        history: [],
      },
    });

    const calls = storeMock.transitionRunStatus.mock.calls as unknown as Array<
      [string, string, string, Record<string, unknown> | undefined, unknown]
    >;
    expect(calls).toHaveLength(1);
    expect([calls[0][1], calls[0][2]]).toEqual(["running", "failed"]);
    expect(String(calls[0][3]?.error)).toBe("the flow failed");
    expect(agUiEventTypes()).toContain("RUN_ERROR");
  });
});
