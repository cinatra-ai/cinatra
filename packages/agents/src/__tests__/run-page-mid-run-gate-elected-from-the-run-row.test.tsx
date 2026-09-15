// @vitest-environment jsdom
//
// THE MID-RUN GATE'S RAIL ENTRY IS ELECTED FROM THE RUN'S OWN ROW
// (cinatra#3221, fix leg 6).
//
// WHAT THE PROOF ROUND MEASURED, AND WHY THE GREEN SUITE MISSED IT. Fix legs 2
// and 3 shipped the election itself and pinned it, exhaustively, with a suite
// that hands `runParkedAtTrailingGate` a `lifecycleMoment` of `"hitl"`. On the
// live surface the same reading came back EMPTY: a run standing at the mid-run
// "Draft Context" gate drew one rail entry and elected nothing. Both readings
// were true. The election was never the defect — its INPUT was: the row a run
// parked at a mid-run context gate leaves behind states NO moment at all, so
// the one classifier reads false and the rail is right to elect nothing.
//
// The row is written by `handleWayflowTaskState`'s park, and only the setup
// loop's own gates stated their moment there; the generic WayFlow branch parked
// the run and said nothing. So this file starts where the defect starts — at
// the WRITE — and follows the same row all the way to the composed rail, which
// is the seam the two pure-function suites could not cross:
//
//   the park writes the row  ->  the row is read  ->  the rail elects the entry
//
// A hand-fed `"hitl"` proves the third arrow only. This proves all three.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/run-page-mid-run-gate-elected-from-the-run-row.test.tsx

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
    // The park seam reads the emitted gate back before a run may enter
    // `pending_approval`; serving it from the adapter spy keeps the suite
    // hermetic and still drives the real verification.
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

/**
 * THE RUN'S ROW, AS THE STORE HOLDS IT. Not a spy on the coordinator: the whole
 * question is what the ROW says afterwards, so the park's transition and the
 * moment record both land here and the page reads what they left.
 */
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
  // The park's durable fallback row (cinatra#2748). Inert here — the verified
  // event-log frame is the gate's artifact and the row is a safety net.
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
// The moment's outbox part is a separate concern (cinatra#2930) and needs no
// store here; the row is what this file follows.
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
import {
  runParkedAtTrailingGate,
  runDetailInitialStep,
  parkedGateRailStepLabel,
} from "../instance-screens";
import {
  RunSurfaceRail,
  RunSurfaceRailRow,
  type RunSurfaceRailStep,
} from "../run-surface-rail";
import { runSurfaceRailNumberedCount } from "../run-surface-rail-step";

const TEST_AUTHORITY = { orgId: "org-test", can: () => true };
const RUN_ID = "run-3221-leg6";
const TASK_ID = "task-3221-leg6";
const GATE_ID = `wayflow-${TASK_ID}`;

const CONTEXT_GATE_PAYLOAD = {
  candidates: [
    { artifactId: "a1", representationRevisionId: "r1", semanticAssertionId: "s1" },
  ],
  selectedRefs: [],
  slotMeta: {
    slotId: "draftContext",
    resolutionMode: "accumulate",
    selectionMode: "interactive",
  },
};

function makeRun(): AgentRunRecord {
  return {
    id: RUN_ID,
    templateId: "tmpl-1",
    versionId: null,
    runBy: "user-a",
    status: row.current.status,
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
    approvalPolicy: { steps: [] },
    agentDependencies: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}

function taskWithAgentJson(json: unknown, taskId = TASK_ID) {
  return {
    id: taskId,
    contextId: "ctx-3221",
    status: { state: "input-required", message: { parts: [] } },
    metadata: {},
    history: [{ role: "agent", parts: [{ kind: "text", text: JSON.stringify(json) }] }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  storeMock.recordRunLifecycleMoment.mockImplementation(
    async (input) => {
      // The writer's own compare-and-set: a record never lands on a run that
      // has left the status the caller parked it in.
      if (input.onlyWhileStatus !== undefined && row.current.status !== input.onlyWhileStatus) {
        return undefined;
      }
      row.current.lifecycleMoment = input.moment;
      row.current.lifecycleCardKind = input.cardKind;
      row.current.lifecycleCardRef = input.cardRef;
      return undefined;
    },
  );
});

afterEach(() => {
  cleanup();
});

/** The gate context the approval surfaces derive from the emitted frame. */
function derivedGateContext() {
  const last = onInterruptSpy.mock.calls.at(-1) as
    | [Record<string, unknown>, string, Record<string, unknown>, string, string?]
    | undefined;
  if (!last) return null;
  const [, xRenderer, values, , fieldName] = last;
  return { xRenderer, currentValues: values, fieldName: fieldName ?? null };
}

/**
 * THE RUN PAGE'S RAIL, COMPOSED FROM THE ROW — the same three questions
 * `SetupScreen` asks of one fact, in the same order: does the run stand at a
 * trailing gate, which step does the detail open on, and which rows does the
 * rail draw.
 */
function RunPageRail(props: { row: Row; gateContext: ReturnType<typeof derivedGateContext> }) {
  const parkedGateStep = runParkedAtTrailingGate({
    runStatus: props.row.status,
    lifecycleMoment: props.row.lifecycleMoment,
    gateContextUsable: (props.gateContext?.xRenderer ?? "").length > 0,
    recommendationHeld: false,
    openInputStepKey: null,
  });
  const initialSelection = runDetailInitialStep({
    hasRecommendationStep: false,
    recommendationHeld: false,
    hasScheduleStep: false,
    hasExecution: true,
    openInputStepKey: null,
    parkedGateStep,
  });
  const steps: RunSurfaceRailStep[] = [
    {
      key: "input:0",
      reached: true,
      settled: true,
      surface: <div data-testid="setup-surface" />,
      row: (
        <RunSurfaceRailRow
          selectionKey="input:0"
          label="Setup"
          displayStep={1}
          reached
          settled
          selectable
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          action="open-input-step"
        />
      ),
    },
  ];
  if (parkedGateStep) {
    const label = parkedGateRailStepLabel({
      values: props.gateContext?.currentValues ?? null,
      fieldName: props.gateContext?.fieldName ?? null,
    });
    steps.push({
      key: "gate",
      reached: true,
      settled: false,
      surface: null,
      row: (
        <RunSurfaceRailRow
          selectionKey="gate"
          label={label}
          displayStep={runSurfaceRailNumberedCount(steps.map((s) => s.key)) + 1}
          reached
          settled={false}
          selectable
          conformanceId="run-surface-rail-step"
          indicatorConformanceId="run-surface-rail-indicator"
          action="open-gate-step"
        />
      ),
    });
  }
  return (
    <div className="flex items-start gap-6" data-run-detail-contract="" data-conformance-id="run-surface">
      <RunSurfaceRail
        steps={steps}
        rail={null}
        detail={<section data-testid="run-detail-panel" />}
        initialSelection={initialSelection}
      />
    </div>
  );
}

/** The rail's DOM, read exactly as the live proof round reads it. */
function railReading(container: HTMLElement) {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
  );
  return {
    surfaceRailStepCount: rows.length,
    selectedCount: rows.filter(
      (r) => r.getAttribute("data-run-surface-rail-selected") === "true",
    ).length,
    ariaCurrentStep: container.querySelectorAll('[aria-current="step"]').length,
    electedKeys: rows
      .filter((r) => r.getAttribute("data-run-surface-rail-selected") === "true")
      .map((r) => r.getAttribute("data-run-surface-rail-step-key")),
  };
}

describe("the park writes the moment the rail reads (cinatra#3221, fix leg 6)", () => {
  it("a mid-run CONTEXT gate parks the run AND states its `hitl` moment on the row", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(row.current.status).toBe("pending_approval");
    // The whole defect, in one field: this was `null` on the live row.
    expect(row.current.lifecycleMoment).toBe("hitl");
    expect(row.current.lifecycleCardKind).toBe("agent_hitl_screen");
    // …and it names THIS gate's screen, so the card the row points at is the
    // card the reader is standing in front of.
    expect(row.current.lifecycleCardRef).toBe(GATE_ID);
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
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    expect(order).toEqual(["transition:pending_approval", "moment:hitl"]);
  });

  it("a run that LOST the park's compare-and-set records no moment at all", async () => {
    storeMock.transitionRunStatus.mockImplementation(async () => {
      throw new storeMock.RunTransitionError("stale_from_status", "stale");
    });

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    expect(storeMock.recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(row.current.lifecycleMoment).toBeNull();
  });

  it("a gate RE-EMITTED onto an already-parked run states the NEW gate's screen", async () => {
    row.current = {
      status: "pending_approval",
      lifecycleMoment: "hitl",
      lifecycleCardKind: "agent_hitl_screen",
      lifecycleCardRef: "wayflow-an-earlier-gate",
    };

    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "pending_approval",
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    // No transition: `pending_approval -> pending_approval` is not a legal edge.
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(row.current.lifecycleMoment).toBe("hitl");
    expect(row.current.lifecycleCardRef).toBe(GATE_ID);
  });

  it("an ORDINARY WayFlow approval gate still states NO moment (unchanged)", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson({ draft: "the finished post", wordCount: 800 }),
    });

    expect(onInterruptSpy).toHaveBeenCalledTimes(1);
    expect(row.current.status).toBe("pending_approval");
    // The caution beside the setup loop: an approval of work already done is not
    // an input ask, and telling it as one would mislabel every review gate.
    expect(storeMock.recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(row.current.lifecycleMoment).toBeNull();
  });
});

describe("the composed run page elects the mid-run gate from that row", () => {
  it("draws ONE elected entry on the gate — the row the park just wrote", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    const { container } = render(
      <RunPageRail row={row.current} gateContext={derivedGateContext()} />,
    );
    const reading = railReading(container);

    // The live reading before this leg: 2 entries drawn, 0 elected.
    expect(reading.surfaceRailStepCount).toBe(2);
    expect(reading.selectedCount).toBe(1);
    expect(reading.ariaCurrentStep).toBe(1);
    expect(reading.electedKeys).toEqual(["gate"]);
  });

  it("names the row after the context slot the gate is selecting for", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson(CONTEXT_GATE_PAYLOAD),
    });

    const { container } = render(
      <RunPageRail row={row.current} gateContext={derivedGateContext()} />,
    );
    const gateRow = container.querySelector<HTMLElement>(
      '[data-run-surface-rail-step-key="gate"]',
    );
    expect(gateRow).not.toBeNull();
    expect(gateRow!.textContent).toContain("Draft Context");
  });

  it("an ordinary approval gate's row still elects nothing on the rail", async () => {
    await handleWayflowTaskState({
      authority: TEST_AUTHORITY,
      runId: RUN_ID,
      run: makeRun(),
      fromStatus: "running",
      task: taskWithAgentJson({ draft: "the finished post", wordCount: 800 }),
    });

    const { container } = render(
      <RunPageRail row={row.current} gateContext={derivedGateContext()} />,
    );
    const reading = railReading(container);

    expect(reading.surfaceRailStepCount).toBe(1);
    expect(reading.selectedCount).toBe(0);
  });
});
