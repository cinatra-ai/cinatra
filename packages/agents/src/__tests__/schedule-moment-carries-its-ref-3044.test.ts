/**
 * THE SCHEDULE MOMENT CARRIES ITS CARD'S REFERENCE (cinatra#3044).
 *
 * The defect this suite exists to keep closed: the executor opened the schedule
 * moment with NO card reference, the coordinator recorded that omission as
 * `lifecycle_card_ref = NULL`, and the run outbox writes nothing for a moment
 * with no reference — so a run a person started from a conversation reached its
 * schedule moment and the conversation showed nothing at all.
 *
 * What is pinned here is the FIRST link of that chain, at the one call site that
 * opens the moment: the reference is minted on the RUN path, it decodes back to
 * the run it was minted for, and a host that cannot mint one passes nothing
 * rather than something the server did not mint.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schedule-moment-carries-its-ref-3044.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

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
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
  findSavedConnectionForAgentUrl: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  updateAgentRunA2AContextId: vi.fn(async () => undefined),
  setAgentRunTokenHash: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const triggerStoreMock = vi.hoisted(() => ({
  readRunTriggerByRunId: vi.fn(async (): Promise<{ triggerType: string } | null> => null),
}));
vi.mock("../trigger-store", () => triggerStoreMock);

/**
 * The coordinator is the SEAM this suite reads, so it is observed rather than
 * run: what the executor HANDS IT is the fact under test, and the coordinator's
 * own guards (the park re-read, the status pin) are proven in their own suite.
 */
const coordinatorMock = vi.hoisted(() => ({
  stateRunScheduleMoment: vi.fn(async () => undefined),
  onAgentHitl: vi.fn(async () => undefined),
}));
vi.mock("../lifecycle-coordinator", () => coordinatorMock);

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

import { decodeScheduleRunRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "run-3044-schedule";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    templateId: "tmpl-3044",
    versionId: null,
    runBy: "user-3044",
    status: "queued",
    inputParams: { idea: "a grounded idea" },
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
    orgId: "org-3044",
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
    id: "tmpl-3044",
    orgId: "org-3044",
    creatorId: null,
    name: "Draft Writer",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: { idea: { type: "string" } }, required: ["idea"] },
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

/** The one call the executor makes when it opens the schedule moment. */
function scheduleMomentCall(): Record<string, unknown> | null {
  const call = coordinatorMock.stateRunScheduleMoment.mock.calls[0] as
    | unknown[]
    | undefined;
  return (call?.[0] as Record<string, unknown> | undefined) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  triggerStoreMock.readRunTriggerByRunId.mockResolvedValue(null);
  storeMock.readAgentRunById.mockResolvedValue(makeRun());
  storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
});

describe("the executor opens the schedule moment WITH the card's reference (cinatra#3044)", () => {
  it("passes a run-scoped schedule reference that decodes back to this run", async () => {
    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-3044");

    expect(coordinatorMock.stateRunScheduleMoment).toHaveBeenCalledTimes(1);
    const input = scheduleMomentCall();
    expect(input, "the executor opened the schedule moment with no input at all").not.toBeNull();
    const cardRef = input!.cardRef;
    // THE OMISSION IS THE DEFECT. A moment stated with `cardRef` absent or null
    // is recorded as NULL and the outbox writes nothing.
    expect(
      typeof cardRef === "string" && cardRef.length > 0,
      "the schedule moment was opened with no card reference, so the run outbox has nothing to write into the conversation",
    ).toBe(true);
    // …and it is THIS run's, minted by the server, not a handle assembled from
    // ids a client happens to hold.
    expect(decodeScheduleRunRef(cardRef as string)).toEqual({ runId: RUN_ID });
    expect(cardRef, "the reference must be opaque — it is re-fed to the model").not.toContain(
      RUN_ID,
    );
  });

  it("still states the moment for the run it parked, with the run's own identity", async () => {
    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-3044b");

    const input = scheduleMomentCall()!;
    expect((input.run as { id: string }).id).toBe(RUN_ID);
    // The park itself is unchanged: the hand-off is still the one transition.
    const edges = storeMock.transitionRunStatus.mock.calls.map((call) => {
      const args = call as unknown as unknown[];
      return `${String(args[1])}->${String(args[2])}`;
    });
    expect(edges).toEqual(["queued->pending_trigger"]);
  });

  it("fails CLOSED when the reference cannot be minted — no card rather than a wrong one", async () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-3044c");
    } finally {
      process.env.BETTER_AUTH_SECRET = secret;
    }
    // The moment still OPENS — the run's own record is never withheld — and it
    // opens with nothing to address the card by, which is the codec's own
    // fail-closed answer travelling unchanged.
    expect(coordinatorMock.stateRunScheduleMoment).toHaveBeenCalledTimes(1);
    expect(scheduleMomentCall()!.cardRef).toBeNull();
  });

  it("does not open the moment at all when the trigger step was already answered", async () => {
    triggerStoreMock.readRunTriggerByRunId.mockResolvedValue({ triggerType: "immediate" });
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-3044d");

    expect(coordinatorMock.stateRunScheduleMoment).not.toHaveBeenCalled();
  });
});
