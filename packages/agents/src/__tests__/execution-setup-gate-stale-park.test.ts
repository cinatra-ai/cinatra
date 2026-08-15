/**
 * The setup-gate park seam swallows a stale CAS (cinatra#2758).
 *
 * The WayFlow park site wraps its `parkRun` / `failRun` transitions in a
 * catch that swallows `RunTransitionError` code `stale_from_status`: a
 * concurrent stop or cancel that already moved the run off `queued` is a
 * benign lost race, not a failure. The per-field and grouped setup-gate park
 * sites called `transitionRunStatus` bare instead, so the same benign race
 * escaped the job as an unhandled rejection.
 *
 * No state corruption follows either way — the transition guard refuses and
 * the run keeps its already-advanced status — but the bare call surfaces an
 * error for a run that is already correctly stopped. This test drives a real
 * run through the per-field setup gate with `transitionRunStatus` rejecting
 * the `queued -> pending_approval` edge as stale, and asserts the job
 * resolves cleanly with exactly one attempt at that transition.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/execution-setup-gate-stale-park.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(
    async (_runId: string, _from: string, _to: string, ..._rest: unknown[]): Promise<void> => {},
  ),
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
  setAgentRunTokenHash: vi.fn(async () => undefined),
  writeDurableHitlGateArtifact: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const triggerStoreMock = vi.hoisted(() => ({
  readRunTriggerByRunId: vi.fn(async (): Promise<{ triggerType: string } | null> => null),
}));
vi.mock("../trigger-store", () => triggerStoreMock);

// The install-scope gate reads agent_templates / agent_runs straight from the
// DB; this suite mocks the persistence hub, so it mocks the gate's
// persistence too. The gate's own behavior is proven in
// agent-run-scope-guard.test.ts.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ isTriggerReleased: vi.fn(async () => true) }));
vi.mock("../skill-autosave", () => ({
  runSkillAutosaveOnRunCompletion: vi.fn(async () => undefined),
}));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  WAYFLOW_A2A_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  describeWayflowDispatchError: vi.fn((e: unknown) => String(e)),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, rememberLatestWayflowGateTask: vi.fn(async () => undefined) };
});

// The setup gate's read-back verification (`readLatestAgUiInterrupt`) reads
// the durable run event log; stub it to answer the synthetic setup gate id so
// the park seam reaches its verified `parkRun()` call instead of retrying a
// miss for several seconds.
const readLatestAgUiInterruptMock = vi.hoisted(() =>
  vi.fn(async (runId: string) => ({
    reviewTaskId: `setup-${runId}`,
    xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  })),
);
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    publishAgUiEvent: vi.fn(async () => undefined),
    enrichSchemaWithResolvedData: vi.fn(async (schema: unknown) => ({ ...(schema as object) })),
    readLatestAgUiInterrupt: readLatestAgUiInterruptMock,
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

import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "run-2758-stale-park";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    templateId: "tmpl-2758",
    versionId: null,
    runBy: "user-2758",
    status: "queued",
    // The one required setup field ("brief") is NOT yet answered, so the
    // per-field setup gate fires before any dispatch branch.
    inputParams: {},
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-2758",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    executionAttemptId: null,
    ...overrides,
  };
}

function makeTemplate(extra: Record<string, unknown> = {}) {
  return {
    id: "tmpl-2758",
    orgId: "org-2758",
    creatorId: null,
    name: "Setup Gate Fixture",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: { brief: { type: "string" } }, required: ["brief"] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: null,
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "full",
    approvalPolicy: null,
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...extra,
  };
}

/** Every (from, to) pair transitionRunStatus was asked for. */
function edges(): string[] {
  return storeMock.transitionRunStatus.mock.calls.map((call) => {
    const args = call as unknown as unknown[];
    return `${String(args[1])}->${String(args[2])}`;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readLatestAgUiInterruptMock.mockImplementation(async (runId: string) => ({
    reviewTaskId: `setup-${runId}`,
    xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  }));
  triggerStoreMock.readRunTriggerByRunId.mockResolvedValue(null);
});

describe("execution.ts — setup-gate park seam (cinatra#2758)", () => {
  it("a stale queued->pending_approval park is a no-op: resolves cleanly, one attempt, no failRun", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, from: string, to: string): Promise<void> => {
        if (from === "queued" && to === "pending_approval") {
          // A concurrent stop/cancel already moved the row off `queued`.
          throw new storeMock.RunTransitionError({ code: "stale_from_status" });
        }
      },
    );

    await expect(
      runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-2758"),
    ).resolves.toBeUndefined();

    // Exactly one attempt at the park transition: the catch swallows the
    // stale CAS instead of retrying it or letting it escape the job.
    expect(edges()).toEqual(["queued->pending_approval"]);
    // The benign lost race must not be turned into a forced failure either.
    expect(edges()).not.toContain("queued->failed");
  });
});
