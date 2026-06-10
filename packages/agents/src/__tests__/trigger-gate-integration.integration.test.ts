/**
 * Integration tests for the side-effects gate at the WayFlow A2A dispatch
 * boundary in `runAgentBuilderExecutionJob`.
 *
 * Covers the expected gate behaviors:
 *   1. Gated template + closed gate → throws TriggerGateClosedError BEFORE
 *      `client.sendTask` is invoked.
 *   2. Gated template + open gate → proceeds past the gate; `client.sendTask`
 *      IS invoked.
 *   3. Empty gatedSteps + closed gate → proceeds past the gate (gate skipped).
 *   4. Null gatedSteps (legacy template) + closed gate → proceeds past the
 *      gate (defensive default of [] for null).
 *   5. gateBackoffMs(N) returns the correct exponential-backoff curve:
 *      30s → 60s → 120s → 240s → 300s (capped).
 *   6. TriggerGateClosedError exposes runId, nextAttempt, delayMs.
 *   7. currentAttempt = 4 in job.data.gateAttempt → thrown error has
 *      nextAttempt: 5, delayMs: 300_000.
 *
 * The gate check fires BEFORE `transitionRunStatus(runId, "queued", "running")`
 * so a parked run's DB status stays "queued" while the BullMQ job re-queues
 * via `moveToDelayed`.
 *
 * Mocking strategy:
 *   - vi.mock("../store") — partial mock; replace template/run getters with
 *     test-controlled fixtures.
 *   - vi.mock("../trigger-gate") — control isTriggerReleased per test.
 *   - vi.mock("../wayflow-url") — return a deterministic URL.
 *   - vi.mock("@cinatra-ai/a2a") — sendTask is a spy so we can assert the gate
 *     fired BEFORE the dispatch.
 *   - vi.mock("./skill-autosave"), vi.mock("@cinatra-ai/agent-ui-protocol/server")
 *     — best-effort no-ops; the dispatch path never reaches them when the gate
 *     is closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted shared state — accessed from inside vi.mock() factories.
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => ({
  isTriggerReleased: vi.fn(),
  sendTask: vi.fn(),
  transitionRunStatus: vi.fn(),
  templateOverride: null as null | Record<string, unknown>,
  runOverride: null as null | Record<string, unknown>,
}));

// Mock store.ts — replace template + run getters and transitions.
vi.mock("../store", async () => {
  const actual = await vi.importActual<typeof import("../store")>("../store");
  return {
    ...actual,
    readAgentRunById: vi.fn(async (runId: string) => {
      if (hoisted.runOverride) {
        return { ...hoisted.runOverride, id: runId };
      }
      return null;
    }),
    readAgentTemplateById: vi.fn(async (_templateId: string) => {
      return hoisted.templateOverride;
    }),
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

vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(() => "http://localhost:9999"),
}));

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

// Import AFTER all mocks so the real runAgentBuilderExecutionJob runs through
// the mocked surface.
import {
  runAgentBuilderExecutionJob,
  TriggerGateClosedError,
  gateBackoffMs,
} from "../execution";

function makeRun(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

function makeTemplate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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
    gatedSteps: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.isTriggerReleased.mockReset();
  hoisted.sendTask.mockReset();
  hoisted.transitionRunStatus.mockReset();
  hoisted.transitionRunStatus.mockResolvedValue(undefined);
  hoisted.sendTask.mockResolvedValue({ id: "task-1", status: { state: "completed" } });
  hoisted.templateOverride = null;
  hoisted.runOverride = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// gateBackoffMs — pure function (Behavior 5)
// ---------------------------------------------------------------------------
describe("gateBackoffMs", () => {
  it("returns 30_000 for attempt 1", () => {
    expect(gateBackoffMs(1)).toBe(30_000);
  });
  it("returns 60_000 for attempt 2", () => {
    expect(gateBackoffMs(2)).toBe(60_000);
  });
  it("returns 120_000 for attempt 3", () => {
    expect(gateBackoffMs(3)).toBe(120_000);
  });
  it("returns 240_000 for attempt 4", () => {
    expect(gateBackoffMs(4)).toBe(240_000);
  });
  it("returns 300_000 for attempt 5 (capped)", () => {
    expect(gateBackoffMs(5)).toBe(300_000);
  });
  it("returns 300_000 for attempt 99 (capped)", () => {
    expect(gateBackoffMs(99)).toBe(300_000);
  });
  it("returns 30_000 for attempt 0 or negative (defensive)", () => {
    expect(gateBackoffMs(0)).toBe(30_000);
    expect(gateBackoffMs(-1)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// TriggerGateClosedError — class shape (Behavior 6)
// ---------------------------------------------------------------------------
describe("TriggerGateClosedError", () => {
  it("exposes runId, nextAttempt, delayMs", () => {
    const err = new TriggerGateClosedError({
      runId: "run-x",
      nextAttempt: 3,
      delayMs: 120_000,
    });
    expect(err).toBeInstanceOf(TriggerGateClosedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.runId).toBe("run-x");
    expect(err.nextAttempt).toBe(3);
    expect(err.delayMs).toBe(120_000);
    expect(err.name).toBe("TriggerGateClosedError");
    expect(err.message).toContain("run-x");
  });
});

// ---------------------------------------------------------------------------
// runAgentBuilderExecutionJob — gate behaviors (1, 2, 3, 4, 7)
// ---------------------------------------------------------------------------
describe("runAgentBuilderExecutionJob — side-effects gate", () => {
  it("Behavior 1: throws TriggerGateClosedError when gate closed AND gatedSteps non-empty (BEFORE sendTask)", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: "full",
      gatedSteps: [{ stepId: "send-1", stepNumber: 1, agentPath: ["root"], label: "Send email", toolName: "gmail_send", inferredOrManual: "inferred" }],
    });
    hoisted.isTriggerReleased.mockResolvedValue(false);

    await expect(
      runAgentBuilderExecutionJob({ runId: "run-test-1" }, "job-1"),
    ).rejects.toBeInstanceOf(TriggerGateClosedError);

    // Critical: sendTask MUST NOT have been invoked
    expect(hoisted.sendTask).not.toHaveBeenCalled();

    // Critical: transitionRunStatus(runId, "queued", "running") MUST NOT
    // have been invoked — the gate fires BEFORE the running transition.
    const runningTransitions = hoisted.transitionRunStatus.mock.calls.filter(
      (c) => c[1] === "queued" && c[2] === "running",
    );
    expect(runningTransitions.length).toBe(0);
  });

  it("Behavior 2: proceeds past gate when isTriggerReleased=true (sendTask invoked)", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: "full",
      gatedSteps: [{ stepId: "send-1", stepNumber: 1, agentPath: ["root"], label: "Send email", toolName: "gmail_send", inferredOrManual: "inferred" }],
    });
    hoisted.isTriggerReleased.mockResolvedValue(true);

    await runAgentBuilderExecutionJob({ runId: "run-test-1" }, "job-1");

    expect(hoisted.sendTask).toHaveBeenCalledTimes(1);
  });

  it("Behavior 3: proceeds past gate when gatedSteps is empty array (gate skipped)", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: "full",
      gatedSteps: [],
    });
    hoisted.isTriggerReleased.mockResolvedValue(false);

    await runAgentBuilderExecutionJob({ runId: "run-test-1" }, "job-1");

    expect(hoisted.sendTask).toHaveBeenCalledTimes(1);
    // gate must not even have been consulted because gatedSteps.length === 0
    expect(hoisted.isTriggerReleased).not.toHaveBeenCalled();
  });

  it("Behavior 4: proceeds past gate when gatedSteps is null (legacy template; defensive default)", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: null,
      gatedSteps: null,
    });
    hoisted.isTriggerReleased.mockResolvedValue(false);

    await runAgentBuilderExecutionJob({ runId: "run-test-1" }, "job-1");

    expect(hoisted.sendTask).toHaveBeenCalledTimes(1);
    expect(hoisted.isTriggerReleased).not.toHaveBeenCalled();
  });

  it("Behavior 7: currentAttempt=4 → thrown error has nextAttempt=5, delayMs=300_000 (capped)", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: "full",
      gatedSteps: [{ stepId: "send-1", stepNumber: 1, agentPath: ["root"], label: "Send", toolName: "gmail_send", inferredOrManual: "inferred" }],
    });
    hoisted.isTriggerReleased.mockResolvedValue(false);

    let caught: unknown;
    try {
      await runAgentBuilderExecutionJob({ runId: "run-test-1", gateAttempt: 4 }, "job-1");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TriggerGateClosedError);
    const e = caught as TriggerGateClosedError;
    expect(e.runId).toBe("run-test-1");
    expect(e.nextAttempt).toBe(5);
    expect(e.delayMs).toBe(300_000);
  });

  it("Behavior 7b: gateAttempt absent → first attempt → nextAttempt=1, delayMs=30_000", async () => {
    hoisted.runOverride = makeRun();
    hoisted.templateOverride = makeTemplate({
      triggerMode: "full",
      gatedSteps: [{ stepId: "send-1", stepNumber: 1, agentPath: ["root"], label: "Send", toolName: "gmail_send", inferredOrManual: "inferred" }],
    });
    hoisted.isTriggerReleased.mockResolvedValue(false);

    let caught: unknown;
    try {
      await runAgentBuilderExecutionJob({ runId: "run-test-1" }, "job-1");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TriggerGateClosedError);
    const e = caught as TriggerGateClosedError;
    expect(e.nextAttempt).toBe(1);
    expect(e.delayMs).toBe(30_000);
  });
});
