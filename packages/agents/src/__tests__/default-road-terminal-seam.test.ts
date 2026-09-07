import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#3029 — THE TERMINAL SEAM of the default road (acceptance items 1-3).
//
// Item 3, "response text takes no road": until this slice the terminal-success
// branch captured the run's whole final RESPONSE TEXT into a one-row derivation
// outbox (`transitionRunStatus`'s `derivationOutbox` meta key) and enqueued a
// post-terminal job to type it against the agent's declared output types. This
// suite pins that BOTH are gone, and that what replaced them runs instead: the
// per-output pickup over the run's END-NODE OUTPUTS, whose outcomes ride the ONE
// terminal stepResults payload beside the declarative binding rung's.
// ---------------------------------------------------------------------------

const { publishAgUiEventSpy, materializeRunArtifactsSpy, runDefaultRoadPickupSpy } =
  vi.hoisted(() => ({
    publishAgUiEventSpy: vi.fn(async () => undefined),
    materializeRunArtifactsSpy: vi.fn(async () => [] as Array<Record<string, unknown>>),
    runDefaultRoadPickupSpy: vi.fn(
      async (_input: Record<string, unknown>) => [] as Array<Record<string, unknown>>,
    ),
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
// The pickup CORE is never imported by the terminal path (route-graph ratchet):
// it is read from the boot-registered runner slot. The test registers its own
// runner into that slot exactly as the system-loops seed phase does.

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

import { handleWayflowTaskState, registerDefaultRoadPickupRunner, CINATRA_ENDNODE_OUTPUTS_SENTINEL } from "../execution";
import type { AgentRunRecord } from "../store";

const TEST_AUTHORITY = { orgId: "org-road", can: () => true };

function makeRun(): AgentRunRecord {
  return {
    id: "run-road-1",
    templateId: "tmpl-road-1",
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
    a2aTaskId: "task-road-1",
    a2aContextId: "ctx-road-1",
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-road",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
  } as unknown as AgentRunRecord;
}

function completedTask(outputs: Record<string, unknown> | null) {
  return {
    id: "task-road-1",
    contextId: "ctx-road-1",
    status: { state: "completed", message: { parts: [] } },
    metadata: {},
    history: [
      { role: "agent", parts: [{ kind: "text", text: "a long final response text" }] },
      ...(outputs === null
        ? []
        : [
            {
              role: "agent",
              parts: [
                { kind: "data", data: { [CINATRA_ENDNODE_OUTPUTS_SENTINEL]: outputs } },
              ],
            },
          ]),
    ],
  };
}

function lastTransition() {
  const calls = storeMock.transitionRunStatus.mock.calls;
  return calls[calls.length - 1] as unknown as [
    string,
    string,
    string,
    Record<string, unknown> | undefined,
    unknown,
  ];
}

describe("cinatra#3029 — the terminal seam of the default road", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    materializeRunArtifactsSpy.mockResolvedValue([]);
    runDefaultRoadPickupSpy.mockResolvedValue([]);
    // The boot-registered slot, registered here the way the system-loops seed
    // phase registers it in a real process.
    registerDefaultRoadPickupRunner({
      pickup: runDefaultRoadPickupSpy as unknown as Parameters<
        typeof registerDefaultRoadPickupRunner
      >[0]["pickup"],
    });
  });

  afterEach(() => {
    globalThis.__cinatraDefaultRoadPickupRunner = undefined;
  });

  it("item 3: the response-text derivation is retired — no outbox capture, no derive job", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-road-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ report: "a value" }),
    });
    const [, , to, meta] = lastTransition();
    expect(to).toBe("completed");
    expect(meta).not.toHaveProperty("derivationOutbox");
    const derives = enqueueBackgroundJobSpy.mock.calls.filter((c) =>
      String((c as unknown as [string])[0]).includes("unbound"),
    );
    expect(derives).toHaveLength(0);
  });

  it("item 1: the pickup runs over the run's END-NODE OUTPUTS, past the bindings the rung already named", async () => {
    materializeRunArtifactsSpy.mockResolvedValue([
      { ok: true, outputId: "boundOne", nodeId: null, extension: "@vendor/x", artifactId: "a1" },
    ]);
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-road-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ boundOne: "b", report: "r" }),
    });
    expect(runDefaultRoadPickupSpy).toHaveBeenCalledTimes(1);
    const call = runDefaultRoadPickupSpy.mock.calls[0]?.[0] as unknown as {
      runId: string;
      orgId: string;
      endNodeOutputs: Record<string, unknown>;
      boundOutputIds: string[];
    };
    expect(call.runId).toBe("run-road-1");
    expect(call.orgId).toBe("org-road");
    expect(call.endNodeOutputs).toEqual({ boundOne: "b", report: "r" });
    expect(call.boundOutputIds).toEqual(["boundOne"]);
  });

  it("the pickup's outcomes ride the ONE terminal stepResults payload", async () => {
    runDefaultRoadPickupSpy.mockResolvedValue([
      {
        ok: true,
        outputId: "report",
        ledgerOutputId: "cinatra:end-node-output:report",
        rung: "structure",
        mime: "text/markdown",
        extension: "@cinatra-ai/markdown-artifact",
        artifactId: "art-1",
        bytes: 2048,
      },
    ]);
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-road-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask({ report: "r" }),
    });
    const [, , , meta] = lastTransition();
    const steps = (meta?.stepResults ?? []) as Array<Record<string, unknown>>;
    const pickups = steps[0]?.default_road_pickups as Array<Record<string, unknown>>;
    expect(pickups).toHaveLength(1);
    expect(pickups[0].rung).toBe("structure");
    expect(pickups[0].artifactId).toBe("art-1");
  });

  it("a run that declared no end-node outputs takes no road at all", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: "run-road-1",
      run: makeRun(),
      fromStatus: "running",
      task: completedTask(null),
    });
    expect(runDefaultRoadPickupSpy).not.toHaveBeenCalled();
    const [, , , meta] = lastTransition();
    const steps = (meta?.stepResults ?? []) as Array<Record<string, unknown>>;
    expect(steps[0]).not.toHaveProperty("default_road_pickups");
  });
});
