/**
 * The setup → trigger hand-off (cinatra#2523 — owner ruling 2026-08-09, remedy (c)).
 *
 * Before this arm, a run whose setup form was submitted fell straight through
 * to dispatch. On an agent with no gated steps — `gatedSteps: []`, which the
 * compiler emits for every agent whose steps carry no side-effect risk class —
 * the trigger gate does not apply at all, so the run EXECUTED and landed
 * `completed` before the user ever reached the trigger form. "Run right after
 * setup" then had nothing left to dispatch, and the refusal was swallowed
 * (cinatra#2523's headline defect).
 *
 * The arm ends setup in `pending_trigger` instead — the shipped state for "the
 * trigger step is open, awaiting the user's choice" — from which
 * `setRunTriggerForActor` dispatches through a normal legal edge.
 *
 * The three cases that matter are the arm's exact boundary:
 *   1. the wizard's setup-resume leg with NO trigger row  → hand off, do not run;
 *   2. the same leg once a trigger EXISTS                 → the trigger step is
 *      already answered, so dispatch normally (no second hand-off, no loop);
 *   3. any OTHER producer (no `resumedFromSetup` flag)    → byte-identical to
 *      before: chat, MCP `agent_run`, recurring clones, dev child preview,
 *      orchestrator children and the Run button all reach dispatch untouched.
 *
 * Cases 2 and 3 observe "dispatch proceeded" through the cheapest terminal the
 * dispatch branches offer: an `external` template with no `agentUrl`, which
 * fails the run immediately instead of opening a network connection.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/execution-setup-trigger-handoff.test.ts
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

// The install-scope gate reads agent_templates / agent_runs straight from the
// DB; this suite mocks the persistence hub, so it mocks the gate's persistence
// too. The gate's own behavior is proven in agent-run-scope-guard.test.ts.
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

import { runAgentBuilderExecutionJob } from "../execution";

const RUN_ID = "run-2523-handoff";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    templateId: "tmpl-2523",
    versionId: null,
    runBy: "user-2523",
    status: "queued",
    // Setup is DONE: the one required field is answered, so the setup interrupt
    // loop falls through to the hand-off / dispatch boundary.
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
    orgId: "org-2523",
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
    id: "tmpl-2523",
    orgId: "org-2523",
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
    // The exact shape that made this bug reachable: nothing to gate, so the
    // trigger gate never held the run back.
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
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  triggerStoreMock.readRunTriggerByRunId.mockResolvedValue(null);
});

describe("execution.ts — setup-success hand-off (cinatra#2523)", () => {
  it("hands a finished setup with no trigger row to pending_trigger instead of running it", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-1");

    expect(edges()).toEqual(["queued->pending_trigger"]);
    // It asked whether the user had already chosen a trigger — that question IS
    // the arm's boundary.
    expect(triggerStoreMock.readRunTriggerByRunId).toHaveBeenCalledWith(RUN_ID);
  });

  it("does NOT hand off a second time once a trigger exists — it dispatches", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );
    triggerStoreMock.readRunTriggerByRunId.mockResolvedValue({ triggerType: "immediate" });

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-2");

    expect(edges()).not.toContain("queued->pending_trigger");
    // Reached the dispatch branches (the external template's missing-agentUrl
    // refusal is the cheapest observable terminal there).
    expect(edges()).toContain("queued->failed");
  });

  // cinatra#2523 (codex round-2 finding). The pre-transition row read and the
  // transition are two statements. A trigger configured in that window would
  // otherwise be handed back to the step it had just answered — an enqueued run
  // parked forever. The RE-READ after the transition is the correctness boundary.
  it("returns the run to queued when a trigger lands DURING the hand-off (no stranding)", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );
    triggerStoreMock.readRunTriggerByRunId
      .mockResolvedValueOnce(null) // the fast-path read: nothing chosen yet
      .mockResolvedValueOnce({ triggerType: "immediate" }); // …chosen in the window

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-race");

    expect(edges().slice(0, 2)).toEqual([
      "queued->pending_trigger",
      "pending_trigger->queued",
    ]);
    // …and the run really goes on to dispatch rather than sitting parked.
    expect(edges()).toContain("queued->failed");
  });

  // A SCHEDULE chosen in the same window must not be reverted to `queued` —
  // that would run the agent immediately, the opposite of what was asked (codex
  // round-3 finding). It is armed instead: `setRunTriggerForActor` could not arm
  // it at the time (the run was still `queued`, so both of its arming rungs
  // missed), and without the arm the release job would find a run that is not
  // armed and skip the fire forever.
  it("ARMS — never runs — a schedule chosen during the hand-off", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );
    triggerStoreMock.readRunTriggerByRunId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ triggerType: "scheduled" });

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-armed");

    expect(edges()).toEqual(["queued->pending_trigger", "pending_trigger->armed"]);
    // The agent did NOT run.
    expect(edges()).not.toContain("queued->failed");
  });

  it("defers to whichever writer took the run out of pending_trigger first", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );
    triggerStoreMock.readRunTriggerByRunId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ triggerType: "immediate" });
    // The trigger form beat us to it: the run already left `pending_trigger`, so
    // the revert loses its CAS and this job must not dispatch a second time.
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, from: string, to: string): Promise<void> => {
        if (from === "pending_trigger" && to === "queued") {
          throw new storeMock.RunTransitionError("stale_from_status", "already taken");
        }
      },
    );

    await runAgentBuilderExecutionJob({ runId: RUN_ID, resumedFromSetup: true }, "job-taken");

    expect(edges()).toEqual(["queued->pending_trigger", "pending_trigger->queued"]);
    expect(edges()).not.toContain("queued->failed");
  });

  it("leaves every non-setup producer untouched — no flag, no hand-off", async () => {
    storeMock.readAgentRunById.mockResolvedValue(makeRun());
    storeMock.readAgentTemplateById.mockResolvedValue(
      makeTemplate({ sourceType: "external", agentUrl: null }),
    );

    await runAgentBuilderExecutionJob({ runId: RUN_ID }, "job-3");

    expect(edges()).not.toContain("queued->pending_trigger");
    expect(edges()).toContain("queued->failed");
    // The trigger row is not even consulted on a non-setup leg.
    expect(triggerStoreMock.readRunTriggerByRunId).not.toHaveBeenCalled();
  });
});
