// ---------------------------------------------------------------------------
// A GATED RUN WITH NO TRIGGER EVER MINTED LANDS TERMINAL, NOT PARKED FOREVER
// (cinatra#3033 — the queued-forever dispatch).
//
// MEASURED on a development boot of this branch: two real dispatches of the blog
// idea generator (from the chat and from the run-start page) left their rows at
// `queued`, `started_at` null, `error` null, with ZERO rows in
// `agent_run_triggers` — and the job queue looked perfectly healthy, because a
// job parked with `moveToDelayed` counts as neither waiting, active nor failed.
//
// THE SEAM. The side-effects gate in `runAgentBuilderExecutionJobInner` holds a
// run whose template gates steps (`triggerMode: "full"` with a non-empty
// `gatedSteps`) until a trigger is RELEASED. The trigger row itself is minted by
// the person's own trigger choice, which only ever runs against a run PARKED at
// `pending_trigger`. Every road that dispatches straight to the queue — the
// run-start page's create-and-trigger, an agent-as-tool call, an A2A send —
// therefore reaches the gate with no trigger row at all, and nothing on those
// roads will ever mint one. The gate then re-queued on its backoff forever.
//
// The park stays indefinite when a trigger row EXISTS and is simply unreleased:
// that is a person who has been asked and has not answered. What this pins is
// the other case — nothing is coming — where the drawn floor applies: a run that
// can never start says so in one line and never sits blank.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  isTriggerReleased: vi.fn(),
  readRunTriggerByRunId: vi.fn(),
  sendTask: vi.fn(),
  transitionRunStatus: vi.fn(),
  templateOverride: null as null | Record<string, unknown>,
  runOverride: null as null | Record<string, unknown>,
}));

vi.mock("../store", async () => {
  const actual = await vi.importActual<typeof import("../store")>("../store");
  return {
    ...actual,
    readAgentRunById: vi.fn(async (runId: string) =>
      hoisted.runOverride ? { ...hoisted.runOverride, id: runId } : null,
    ),
    readAgentTemplateById: vi.fn(async () => hoisted.templateOverride),
    readAgentTemplateVersionBySemver: vi.fn(async () => null),
    readAgentTemplates: vi.fn(async () => ({ items: [], total: 0 })),
    transitionRunStatus: hoisted.transitionRunStatus,
    findSavedConnectionForAgentUrl: vi.fn(() => null),
    updateAgentRunA2ATaskId: vi.fn(async () => undefined),
    updateAgentRunA2AContextId: vi.fn(async () => undefined),
  };
});

vi.mock("../trigger-gate", () => ({
  isTriggerReleased: hoisted.isTriggerReleased,
  markTriggerReleased: vi.fn(async () => undefined),
}));

vi.mock("../trigger-store", async () => {
  const actual = await vi.importActual<typeof import("../trigger-store")>("../trigger-store");
  return { ...actual, readRunTriggerByRunId: hoisted.readRunTriggerByRunId };
});

// The fire-time scope recheck runs before the gate and is not this suite's
// subject — let it pass so the gate is what the assertions read.
vi.mock("../agent-run-serde", async () => {
  const actual =
    await vi.importActual<typeof import("../agent-run-serde")>("../agent-run-serde");
  return { ...actual, assertAgentRunScopeAuthorized: vi.fn(async () => undefined) };
});

vi.mock("../wayflow-url", async () => {
  const actual = await vi.importActual<typeof import("../wayflow-url")>("../wayflow-url");
  return { ...actual, resolveWayflowUrl: vi.fn(() => "http://localhost:9999") };
});

vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({
    sendTask: hoisted.sendTask,
    streamTask: vi.fn(),
  })),
  startExternalSseProxyFromStream: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  AgUiAdapter: class {
    constructor(_a: unknown, _b: unknown, _c: unknown) {}
    onInterrupt() {}
  },
  A2UiAdapter: class {
    constructor(_a: unknown, _b: unknown, _c: unknown) {}
    onInterrupt() {}
  },
  DualAdapterDispatch: class {
    constructor(_a: unknown, _b: unknown) {}
    onInterrupt() {}
  },
  publishAgUiEvent: vi.fn(async () => undefined),
  publishA2UiEvent: vi.fn(async () => undefined),
  enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => schema),
}));

import {
  runAgentBuilderExecutionJob,
  TriggerGateClosedError,
  GATE_ATTEMPTS_BEFORE_NO_TRIGGER_FLOOR,
} from "../execution";

const GATED_STEP = {
  stepId: "send-1",
  stepNumber: 1,
  agentPath: ["root"],
  label: "Send email",
  toolName: "gmail_send",
  inferredOrManual: "inferred",
};

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-test-1",
    templateId: "tmpl-test-1",
    status: "queued",
    inputParams: {},
    versionId: null,
    runBy: null,
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    parentRunId: null,
    timeoutSeconds: null,
    ...overrides,
  };
}

function makeTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tmpl-test-1",
    orgId: null,
    creatorId: null,
    name: "test-template",
    description: null,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: { type: "object", properties: {} },
    outputSchema: null,
    approvalPolicy: { steps: [] },
    status: "published",
    type: "leaf",
    taskSpec: null,
    packageName: "@cinatra/test-agent",
    packageVersion: "1.0.0",
    currentVersionId: null,
    hitlScreens: null,
    agentDependencies: {},
    ioSpec: null,
    hitlRequired: false,
    executionProvider: "wayflow",
    lgGraphCode: null,
    lgGraphId: null,
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    triggerMode: "full",
    gatedSteps: [GATED_STEP],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.isTriggerReleased.mockReset();
  hoisted.readRunTriggerByRunId.mockReset();
  hoisted.sendTask.mockReset();
  hoisted.transitionRunStatus.mockReset();
  hoisted.transitionRunStatus.mockResolvedValue(undefined);
  hoisted.sendTask.mockResolvedValue({ id: "task-1", status: { state: "completed" } });
  hoisted.isTriggerReleased.mockResolvedValue(false);
  hoisted.runOverride = makeRun();
  hoisted.templateOverride = makeTemplate();
});

afterEach(() => {
  vi.clearAllMocks();
});

const failTransitions = () =>
  hoisted.transitionRunStatus.mock.calls.filter((c) => c[1] === "queued" && c[2] === "failed");

describe("the gate's no-trigger floor", () => {
  it("keeps parking while the backoff sequence still has room to run", async () => {
    hoisted.readRunTriggerByRunId.mockResolvedValue(null);
    await expect(
      runAgentBuilderExecutionJob(
        { runId: "run-test-1", gateAttempt: GATE_ATTEMPTS_BEFORE_NO_TRIGGER_FLOOR - 1 },
        "job-1",
      ),
    ).rejects.toBeInstanceOf(TriggerGateClosedError);
    expect(failTransitions().length).toBe(0);
  });

  it("lands the run terminal, with one line, once the whole backoff ran and no trigger was ever minted", async () => {
    hoisted.readRunTriggerByRunId.mockResolvedValue(null);

    await expect(
      runAgentBuilderExecutionJob(
        { runId: "run-test-1", gateAttempt: GATE_ATTEMPTS_BEFORE_NO_TRIGGER_FLOOR },
        "job-1",
      ),
    ).resolves.toBeUndefined();

    const failed = failTransitions();
    expect(failed.length).toBe(1);
    const line = (failed[0]?.[3] as { error?: string } | undefined)?.error ?? "";
    expect(line).toContain("could not be started");
    expect(line).toContain("no trigger was ever set");
    // The floor is a sentence, not a dump: no run id, no status token, no
    // internal name in the text a person reads.
    expect(line).not.toContain("run-test-1");
    expect(line).not.toContain("queued");
    expect(line).not.toContain("gatedSteps");
    // And it never dispatched.
    expect(hoisted.sendTask).not.toHaveBeenCalled();
  });

  it("keeps parking indefinitely when a trigger row EXISTS but is unreleased — that is a person still deciding", async () => {
    hoisted.readRunTriggerByRunId.mockResolvedValue({ runId: "run-test-1", releasedAt: null });
    await expect(
      runAgentBuilderExecutionJob(
        { runId: "run-test-1", gateAttempt: GATE_ATTEMPTS_BEFORE_NO_TRIGGER_FLOOR + 40 },
        "job-1",
      ),
    ).rejects.toBeInstanceOf(TriggerGateClosedError);
    expect(failTransitions().length).toBe(0);
  });

  it("never consults the floor for an ungated template — the gate is off entirely", async () => {
    hoisted.templateOverride = makeTemplate({ gatedSteps: [] });
    hoisted.readRunTriggerByRunId.mockResolvedValue(null);
    // What happens AFTER the gate (the dispatch itself) is another suite's
    // subject; this one asserts only that the gate — and therefore the floor —
    // was never entered for a template that gates nothing.
    await runAgentBuilderExecutionJob(
      { runId: "run-test-1", gateAttempt: GATE_ATTEMPTS_BEFORE_NO_TRIGGER_FLOOR + 1 },
      "job-1",
    ).catch(() => undefined);
    expect(hoisted.isTriggerReleased).not.toHaveBeenCalled();
    expect(hoisted.readRunTriggerByRunId).not.toHaveBeenCalled();
  });
});
