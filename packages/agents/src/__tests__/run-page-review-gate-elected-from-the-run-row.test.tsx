// @vitest-environment jsdom
//
// THE WORK REVIEW GATE'S RAIL ENTRY IS ELECTED, TOO (cinatra#3221, fix leg 7).
//
// WHAT THE THIRD PROOF ROUND MEASURED. Fix leg 6 closed the mid-run CONTEXT
// gate: its park stated no lifecycle moment, so the rail's one classifier read
// false and the page elected nothing. The same reading came back FAILING at a
// third gate class — a run parked on the WORK REVIEW gate still elected no rail
// entry — and the cause is the same shape twice over:
//
//   1. the review gate's own park (`handleWayflowTaskState`'s marked-review
//      branch) transitioned the run to `pending_approval` and stated NO moment
//      at all, so the row a run stopped at its review leaves behind carried
//      whatever the previous gate had left, or nothing. Measured on the lane's
//      own row: a run that reached its review gate at 08:25 still said
//      `hitl` / `agent_hitl_screen` from the context gate it had answered at
//      08:22.
//   2. the rail's election asked the SPINE first. A review gate opens at a
//      marked step, so the live interrupt carries that step's number, and the
//      spine branch answered with the settled work step — never the gate entry
//      the reader was standing at.
//
// So this file follows the same three arrows leg 6 followed, for this gate
// class: the park writes the row -> the row is read -> the rail elects the
// entry.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/run-page-review-gate-elected-from-the-run-row.test.tsx

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";

const { enrichSpy, onInterruptSpy } = vi.hoisted(() => {
  const enrichSpy = vi.fn(async (schema: unknown) => ({ ...(schema as object) }));
  const onInterruptSpy = vi.fn();
  return { enrichSpy, onInterruptSpy };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    enrichSchemaWithResolvedData: enrichSpy,
    readLatestAgUiInterrupt: async () => {
      const last = onInterruptSpy.mock.calls.at(-1) as
        | [Record<string, unknown>, string, Record<string, unknown>, string, string?]
        | undefined;
      if (!last) return null;
      const [schema, xRenderer, values, reviewTaskId, fieldName] = last;
      return { schema, xRenderer, values, reviewTaskId, fieldName };
    },
    DualAdapterDispatch: class MockDualAdapterDispatch {
      onInterrupt = onInterruptSpy;
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

/** The gate's server-minted card reference, deterministic here. */
const GATE_CARD_REF = "gate-card-ref-3221-leg7";
vi.mock("@/lib/lifecycle/lifecycle-card-ref", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    encodeLifecycleGateRef: () => GATE_CARD_REF,
  };
});

type Row = {
  status: string;
  lifecycleMoment: string | null;
  lifecycleCardKind: string | null;
  lifecycleCardRef: string | null;
};
const row = vi.hoisted(() => ({
  current: {
    status: "running",
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
  } as Row,
}));

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentTemplates: vi.fn(async () => []),
  readAgentTemplateVersionBySemver: vi.fn(async () => null),
  readAgentTemplateVersionById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(
    async (_runId: string, _from: string, _to: string): Promise<undefined> => undefined,
  ),
  recordRunLifecycleMoment: vi.fn(
    async (_input: {
      runId: string;
      orgId: string | null;
      moment: string | null;
      cardKind: string | null;
      cardRef: string | null;
      onlyWhileStatus?: string;
      onlyWhileMoment?: string | null;
    }): Promise<undefined> => undefined,
  ),
  createAgentRun: vi.fn(async () => null),
  createAgentRunPendingInput: vi.fn(async () => null),
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
  writeDurableHitlGateArtifact: vi.fn(async () => undefined),
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
vi.mock("../lifecycle-part-outbox", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, emitLifecycleMomentOpened: vi.fn(async () => undefined) };
});
vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, rememberLatestWayflowGateTask: vi.fn(async () => undefined) };
});

import { handleWayflowTaskState } from "../execution";
import type { AgentRunRecord } from "../store";
import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";
import { electRunRailActiveStep } from "../run-step-rail-extra-entry";

const TEST_AUTHORITY = { orgId: "org-test", can: () => true };
const RUN_ID = "run-3221-leg7";
const TASK_ID = "task-3221-leg7";
const REVIEW_TASK_ID = `wayflow-${TASK_ID}`;
const TARGETS_INPUT = "reviewTargets";

/** The gate seam the marked-review branch resolves from the global hook. */
function installGateSeam(overrides: Record<string, unknown> = {}) {
  (globalThis as Record<string, unknown>).__cinatraArtifactReviewGateSeam = {
    decideDeclaredReview: async () => ({ review: true }),
    emit: async () => ({ ok: true }),
    readGate: async () => null,
    ...overrides,
  };
}

function makeRun(): AgentRunRecord {
  return {
    id: RUN_ID,
    templateId: "tmpl-1",
    versionId: null,
    runBy: "user-a",
    status: row.current.status,
    inputParams: {
      [TARGETS_INPUT]: [{ artifactId: "a1", representationRevisionId: "r1" }],
    },
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
    orgId: "org-test",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: null,
    lifecycleMoment: row.current.lifecycleMoment,
    lifecycleCardKind: row.current.lifecycleCardKind,
    lifecycleCardRef: row.current.lifecycleCardRef,
    executionAttemptId: null,
  } as unknown as AgentRunRecord;
}

/** A template whose ONE renderer gate is the marked artifact-review gate. */
function makeTemplate() {
  return {
    id: "tmpl-1",
    orgId: null,
    creatorId: null,
    name: "Blog Draft Writer",
    description: "",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { properties: {}, required: [] },
    outputSchema: null,
    taskSpec: null,
    status: "published",
    packageName: null,
    packageVersion: null,
    gatedSteps: [],
    triggerMode: "none",
    approvalPolicy: {
      steps: [
        {
          stepNumber: 2,
          requiresApproval: true,
          hitlOwnedBy: "childAgent",
          xRenderer: "@cinatra-ai/reviewer-agent:output",
          schema: { properties: {} },
          artifactReviewTargetsInput: TARGETS_INPUT,
        },
      ],
    },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function taskWithAgentJson(json: unknown, taskId = TASK_ID) {
  return {
    id: taskId,
    contextId: "ctx-3221-leg7",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [{ role: "agent", parts: [{ kind: "text", text: JSON.stringify(json) }] }],
  };
}

const WORK_OUTPUT = { draft: "the finished post", wordCount: 800 };

beforeEach(() => {
  vi.clearAllMocks();
  installGateSeam();
  row.current = {
    status: "running",
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
  };
  enrichSpy.mockImplementation(async (schema: unknown) => ({ ...(schema as object) }));
  storeMock.readAgentTemplateById.mockResolvedValue(makeTemplate());
  storeMock.readAgentRunById.mockImplementation(async () => makeRun());
  storeMock.transitionRunStatus.mockImplementation(
    async (_runId: string, from: string, to: string) => {
      if (row.current.status !== from) {
        throw new storeMock.RunTransitionError("stale_from_status", "stale");
      }
      row.current.status = to;
      return undefined;
    },
  );
  storeMock.recordRunLifecycleMoment.mockImplementation(async (input) => {
    if (input.onlyWhileStatus !== undefined && row.current.status !== input.onlyWhileStatus) {
      return undefined;
    }
    row.current.lifecycleMoment = input.moment;
    row.current.lifecycleCardKind = input.cardKind;
    row.current.lifecycleCardRef = input.cardRef;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__cinatraArtifactReviewGateSeam;
});

describe("the review gate's park writes the moment the rail reads (fix leg 7)", () => {
  it("parks the run AND states its `review` moment, naming this gate's card", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(WORK_OUTPUT),
    });

    expect(row.current.status).toBe("pending_approval");
    // The whole defect, in one field: this was the PREVIOUS gate's moment on
    // the live row, or nothing at all.
    expect(row.current.lifecycleMoment).toBe("review");
    expect(row.current.lifecycleCardKind).toBe("artifact_review_gate");
    expect(row.current.lifecycleCardRef).toBe(GATE_CARD_REF);
  });

  it("states the moment AFTER the winning transition, never before it", async () => {
    const order: string[] = [];
    storeMock.transitionRunStatus.mockImplementation(
      async (_runId: string, _from: string, to: string) => {
        order.push(`transition:${to}`);
        row.current.status = to;
        return undefined;
      },
    );
    storeMock.recordRunLifecycleMoment.mockImplementation(async (input) => {
      order.push(`moment:${input.moment}`);
      row.current.lifecycleMoment = input.moment;
      return undefined;
    });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(WORK_OUTPUT),
    });

    expect(order).toEqual(["transition:pending_approval", "moment:review"]);
  });

  it("records nothing at all when the park's compare-and-set is lost", async () => {
    storeMock.transitionRunStatus.mockImplementation(async () => {
      throw new storeMock.RunTransitionError("stale_from_status", "stale");
    });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(WORK_OUTPUT),
    });

    expect(storeMock.recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(row.current.lifecycleMoment).toBeNull();
  });

  it("a gate re-emitted onto an ALREADY-PARKED run states this gate's card", async () => {
    row.current = {
      status: "pending_approval",
      lifecycleMoment: "hitl",
      lifecycleCardKind: "agent_hitl_screen",
      lifecycleCardRef: "wayflow-an-earlier-context-gate",
    };

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "pending_approval",
      task: taskWithAgentJson(WORK_OUTPUT),
    });

    // No transition: `pending_approval -> pending_approval` is not a legal edge.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    // The stale reading the live row carried is replaced by where the run
    // actually stands.
    expect(row.current.lifecycleMoment).toBe("review");
    expect(row.current.lifecycleCardKind).toBe("artifact_review_gate");
    expect(row.current.lifecycleCardRef).toBe(GATE_CARD_REF);
  });

  it("emits the review redirect interrupt for this gate", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(WORK_OUTPUT),
    });
    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(onInterruptSpy.mock.calls[0]![3]).toBe(REVIEW_TASK_ID);
  });
});

// ---------------------------------------------------------------------------
// The election itself, for the gate class that arrives at a marked STEP.
// ---------------------------------------------------------------------------

const SPINE = [
  { index: 1, stepNumber: 1 },
  { index: 2, stepNumber: 2 },
];
const PENDING_GATE = { status: "pending" };

describe("the rail elects the gate the run is parked at, not the step that produced the work", () => {
  it("elects the trailing review entry while the interrupt names a SPINE step", () => {
    // The measured live reading: a review gate opens at the marked step, so the
    // interrupt carries that step's number and the spine branch answered with
    // the settled work step — the gate entry elected nothing.
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: 2,
        awaitingNextStep: false,
        highestStepNumber: 2,
        spine: SPINE,
        railExtras: [PENDING_GATE],
      }),
    ).toBe(SPINE.length + 1);
  });

  it("keeps electing the trailing entry when the interrupt names no spine step", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 2,
        spine: SPINE,
        railExtras: [PENDING_GATE],
      }),
    ).toBe(SPINE.length + 1);
  });

  it("leaves a gate that arrives ON the spine with no trailing row of its own", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: 2,
        awaitingNextStep: false,
        highestStepNumber: 2,
        spine: SPINE,
        railExtras: [{ status: "resolved" }],
      }),
    ).toBe(2);
  });
});

describe("the composed panel rail draws exactly one elected entry on the review gate", () => {
  const entries: RunStepRailEntry[] = [
    { key: "step:1", ordinal: 1, kind: "step", label: "Fetched Q3 cohort", status: "completed", sources: [] },
    { key: "step:2", ordinal: 2, kind: "step", label: "Drafted the post", status: "completed", sources: [] },
    {
      key: "gate:r1",
      ordinal: 3,
      kind: "gate",
      label: "Review",
      status: "pending",
      sources: [],
      gate: { gateId: "g1", reviewTaskId: "r1", disposition: null, resolved: false },
    },
  ] as RunStepRailEntry[];

  it("elects the pending review row and nothing else", () => {
    const { container } = render(
      <RunStepRailPanel entries={entries} activeOrdinal={3} reviewHrefBase="/agents/v/p/run/review" />,
    );
    const items = Array.from(container.querySelectorAll('[data-slot="stepper-item"]'));
    const active = items.filter((i) => i.getAttribute("data-state") === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.textContent).toContain("Review");
  });

  it("elects nothing at all once every entry is settled", () => {
    const settled = entries.map((e) =>
      e.kind === "gate" ? { ...e, status: "resolved" } : e,
    ) as RunStepRailEntry[];
    const { container } = render(
      <RunStepRailPanel entries={settled} activeOrdinal={null} reviewHrefBase="/agents/v/p/run/review" />,
    );
    const items = Array.from(container.querySelectorAll('[data-slot="stepper-item"]'));
    expect(items.filter((i) => i.getAttribute("data-state") === "active")).toHaveLength(0);
  });
});
