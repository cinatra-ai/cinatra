// @vitest-environment jsdom
/**
 * A DECLARED STEP AND ITS REVIEW ARE ONE RAIL ENTRY (cinatra#3035).
 *
 * A template may mark ONE of its declared pauses as the step that opens its
 * review (the compiled policy step carries `artifactReviewTargetsInput`). The
 * review gate that step raises is named `wayflow-...`, and the gate row stores
 * no step number, so the rail used to draw the declared pause as a spine row
 * AND its review as a second entry trailing the whole spine: selecting the
 * settled pause opened nothing of the decided review, and while the run was
 * parked at the review the steps after it read as passed.
 *
 * What this locks:
 *
 *   A1  a gate raised at the one marked step takes that step's place, label
 *       and ordinal, and the step's own entry is not drawn beside it;
 *   A2  every other kind of rail row keeps its place (a pin);
 *   A3  a template that marks two steps folds nothing (a pin);
 *   A4  the settled folded entry is the decided gate, opened read only in
 *       place through the settled selection `review:<reviewTaskId>`;
 *   A5  the run-frame rail and the stepper column draw the same rows in the
 *       same order, with one gate row for the marked step and its audit
 *       directly after it;
 *   A6  a run parked at a gate standing in a spine step elects that step;
 *   A7  no later declared pause reads passed before the run reached it.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --maxWorkers=2 --no-coverage \
 *     src/__tests__/run-rail-marked-review-one-entry-3035.test.tsx
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  buildRunStepRail,
  type BuildRunStepRailInput,
  type RailGate,
  type RailTemplateStep,
  type RunStepRailEntry,
} from "../run-step-rail";
import {
  electRunRailActiveStep,
  RunStepSelectionProvider,
} from "../run-step-rail-extra-entry";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ClipboardCheck", "Info", "Pause", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  for (const path of [
    "lucide-react",
    "@/lib/cinatra-toast",
    "@/lib/generated/field-renderer-components",
    "@/lib/generated/extensions.server",
    "next/navigation",
    "../orchestrator-actions",
    "../run-actions",
    "../run-recommendation-actions",
    "../run-name-actions",
    "../hitl-actions",
    "../use-ag-ui-run-stream",
    "../use-runtime-field-renderer-bindings",
  ]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

const REVIEW_HREF_BASE = "/agents/run-3035/review";
const MARKED_STEP_NUMBER = 5;
const REVIEW_TASK_ID = "wayflow-task-draft";

/** Four declared pauses; the third marks its review. The policy step numbers
 *  differ from the display indices on purpose, so `onStep` is read as the
 *  step number and the ordinal as the display index. */
function templateSteps(marked: ReadonlyArray<number> = [MARKED_STEP_NUMBER]): RailTemplateStep[] {
  return [
    { index: 1, stepNumber: 1, label: "Pick an idea" },
    { index: 2, stepNumber: 2, label: "Pick the voice" },
    { index: 3, stepNumber: MARKED_STEP_NUMBER, label: "Review the draft" },
    { index: 4, stepNumber: 6, label: "Approve the post" },
  ].map((step) => (marked.includes(step.stepNumber) ? { ...step, marksReview: true } : step));
}

const STEPPER_STEPS: PanelProps["stepperSteps"] = templateSteps([]).map((s) => ({
  index: s.index,
  stepNumber: s.stepNumber,
  label: s.label,
  xRenderer: "schema-field",
}));

const ANSWERED_FIRST_TWO = [
  { stepIndex: 1, answered: true },
  { stepIndex: 2, answered: true },
];

function draftGate(status: RailGate["status"]): RailGate {
  return {
    gateId: "gate-draft",
    reviewTaskId: REVIEW_TASK_ID,
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: "2026-09-29T10:42:00Z",
  };
}

/** The builder's non-spine entries, exactly as the run screen filters them. */
function railExtrasOf(entries: readonly RunStepRailEntry[]): RunStepRailEntry[] {
  const spineEntryKeys = new Set(STEPPER_STEPS.map((s) => `step:${s.stepNumber}`));
  return entries.filter((e) => !spineEntryKeys.has(e.key));
}

function panelProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3035",
    initialStatus: "completed",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/web-research-agent",
    inputParams: {},
    stepperSteps: STEPPER_STEPS,
    agentId: "agent-3035",
    lgThreadId: null,
    templateId: "tmpl-3035",
    templateName: "Pipeline",
    reviewHrefBase: REVIEW_HREF_BASE,
    ...overrides,
  };
}

/** Every drawn rail row, in document order, as `kind:name` — the numeral a
 *  step's circle carries (or the tick that replaces it) is not its name. */
function drawnRows(): string[] {
  const rails = document.querySelectorAll("[data-run-step-rail]");
  expect(rails.length).toBe(1);
  return Array.from(rails[0].querySelectorAll("[data-rail-kind]")).map(
    (row) =>
      `${row.getAttribute("data-rail-kind")}:${(row.textContent ?? "").trim().replace(/^\d+/, "")}`,
  );
}

// ── the census of row kinds ──────────────────────────────────────────────────

function censusInput(marked: ReadonlyArray<number>): BuildRunStepRailInput {
  return {
    templateSteps: templateSteps(marked),
    submissions: ANSWERED_FIRST_TWO,
    // Four results aligned to the spine (none recorded yet) and one surplus
    // result past it, named by its work.
    stepResults: [null, null, null, null, { name: "Publish the post" }],
    gates: [
      {
        gateId: "gate-core",
        reviewTaskId: "lifecycle-review:event-core",
        status: "resolved",
        disposition: "approved",
        createdAt: "2026-09-29T10:30:00Z",
      },
      draftGate("resolved"),
    ],
    verifications: [
      { gateId: "gate-core", reviewTaskId: "lifecycle-review:event-core", outcome: "verified" },
      { gateId: "gate-draft", reviewTaskId: REVIEW_TASK_ID, outcome: "verified" },
    ],
    lifecycleDecisions: [
      // A fired decision whose gate is on the rail contributes nothing.
      {
        eventId: "event-fired-on-rail",
        artifactId: "artifact-1",
        outcome: "fired",
        gateId: "gate-draft",
        decidedBy: "core-default",
        latticeOutcome: "review",
        reason: "Reviewed by default.",
        createdAt: "2026-09-29T10:40:00Z",
      },
      {
        eventId: "event-fired-missing",
        artifactId: "artifact-2",
        outcome: "fired",
        gateId: "gate-absent",
        decidedBy: "core-default",
        latticeOutcome: "review",
        reason: "Reviewed by default.",
        createdAt: "2026-09-29T10:41:00Z",
      },
      {
        eventId: "event-skipped",
        artifactId: "artifact-3",
        outcome: "skipped",
        gateId: null,
        decidedBy: "org-bound",
        latticeOutcome: "skip",
        reason: "The organisation skips this review.",
        createdAt: "2026-09-29T10:43:00Z",
      },
      {
        eventId: "event-pending",
        artifactId: "artifact-4",
        outcome: "pending",
        gateId: null,
        decidedBy: null,
        latticeOutcome: null,
        reason: "Awaiting the policy.",
        createdAt: "2026-09-29T10:44:00Z",
      },
      {
        eventId: "event-not-classifiable",
        artifactId: "artifact-5",
        outcome: "not_classifiable",
        gateId: null,
        decidedBy: "fail-closed",
        latticeOutcome: null,
        reason: "The artifact has no type.",
        createdAt: "2026-09-29T10:45:00Z",
      },
    ],
  };
}

const FOLDING_KEYS = new Set([
  `gate:${REVIEW_TASK_ID}`,
  `verification:${REVIEW_TASK_ID}`,
  `step:${MARKED_STEP_NUMBER}`,
]);

function everyOtherEntry(entries: readonly RunStepRailEntry[]) {
  return entries
    .filter((e) => !FOLDING_KEYS.has(e.key))
    .map((e) => ({ key: e.key, kind: e.kind, label: e.label, status: e.status }));
}

describe("a declared step and its review are ONE rail entry (cinatra#3035)", () => {
  it("a gate raised at the one marked declared step takes that step's place, label and ordinal (cinatra#3035)", () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_FIRST_TWO,
      gates: [draftGate("pending")],
    });

    const gates = rail.entries.filter((e) => e.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      key: `gate:${REVIEW_TASK_ID}`,
      ordinal: 3,
      kind: "gate",
      label: "Review the draft",
      status: "pending",
      onStep: MARKED_STEP_NUMBER,
    });
    expect(rail.entries.some((e) => e.key === `step:${MARKED_STEP_NUMBER}`)).toBe(false);
    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:1",
      "step:2",
      `gate:${REVIEW_TASK_ID}`,
      "step:6",
    ]);
    expect(rail.activeOrdinal).toBe(3);
  });

  it("every other kind keeps its place", () => {
    const folded = buildRunStepRail(censusInput([MARKED_STEP_NUMBER]));
    const unfolded = buildRunStepRail(censusInput([]));

    // The census the builder can draw beside a template spine is all here.
    const kinds = new Set(unfolded.entries.map((e) => e.key.split(":")[0]));
    expect([...kinds].sort()).toEqual(["gate", "lifecycle", "step", "stepResult", "verification"]);
    expect(
      unfolded.entries
        .filter((e) => e.kind === "lifecycleDecision")
        .map((e) => e.lifecycleDecision?.outcome)
        .sort(),
    ).toEqual(["fired", "not_classifiable", "pending", "skipped"]);
    expect(unfolded.entries.some((e) => e.key === "gate:lifecycle-review:event-core")).toBe(true);
    expect(unfolded.entries.some((e) => e.key === `gate:${REVIEW_TASK_ID}`)).toBe(true);

    expect(everyOtherEntry(folded.entries)).toEqual(everyOtherEntry(unfolded.entries));
    // The gate of another prefix keeps trailing, unlabelled by any step.
    const coreGate = folded.entries.find((e) => e.key === "gate:lifecycle-review:event-core");
    expect(coreGate?.label).toBe("Review");
    expect(coreGate?.onStep).toBeUndefined();

    // A transcript spine carries no template step to mark: its turns and a
    // `wayflow-` gate keep today's reading, the gate trailing as "Review".
    const transcript = buildRunStepRail({
      messages: [
        { id: "m1", sequence: 1, role: "assistant", messageType: "text", text: "Drafted the post." },
        { id: "m2", sequence: 2, role: "assistant", messageType: "final", text: "Done." },
      ],
      gates: [draftGate("pending")],
    });
    expect(transcript.entries.map((e) => [e.key, e.kind, e.label, e.status])).toEqual([
      ["message:m1", "step", "Drafted the post.", "completed"],
      ["message:m2", "step", "Done.", "completed"],
      [`gate:${REVIEW_TASK_ID}`, "gate", "Review", "pending"],
    ]);
    expect(transcript.entries[2].onStep).toBeUndefined();
  });

  it("a template that marks two steps folds nothing", () => {
    const twoMarked = buildRunStepRail(censusInput([2, MARKED_STEP_NUMBER]));
    const noneMarked = buildRunStepRail(censusInput([]));
    expect(JSON.stringify(twoMarked)).toBe(JSON.stringify(noneMarked));
    expect(twoMarked.entries.some((e) => e.onStep !== undefined)).toBe(false);
  });

  it("the settled folded entry is the decided gate, read only, in its step's place", async () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: [...ANSWERED_FIRST_TWO, { stepIndex: 4, answered: false }],
      gates: [draftGate("resolved")],
    });
    const atThree = rail.entries.filter((e) => e.ordinal === 3);
    expect(atThree).toHaveLength(1);
    expect(atThree[0]).toMatchObject({
      key: `gate:${REVIEW_TASK_ID}`,
      kind: "gate",
      label: "Review the draft",
      status: "resolved",
      gate: {
        gateId: "gate-draft",
        reviewTaskId: REVIEW_TASK_ID,
        disposition: "approved",
        resolved: true,
      },
    });

    const select = vi.fn();
    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    render(
      <RunStepSelectionProvider value={{ selected: "detail" as never, select }}>
        <RunStepRailPanel
          entries={rail.entries}
          activeOrdinal={rail.activeOrdinal}
          reviewHrefBase={REVIEW_HREF_BASE}
        />
      </RunStepSelectionProvider>,
    );
    const rows = document.querySelectorAll("[data-rail-kind]");
    expect(rows[2].getAttribute("data-rail-kind")).toBe("gate");
    expect(rows[2].getAttribute("data-rail-gate-history")).toBe("true");
    const control = rows[2].querySelector(`[data-rail-gate-open="${REVIEW_TASK_ID}"]`);
    expect(control).not.toBeNull();
    fireEvent.click(control!);
    expect(select).toHaveBeenCalledWith(`review:${REVIEW_TASK_ID}`);
  });

  it("BOTH RAILS AGREE: the run-frame rail and the stepper column draw the same entries in the same order", async () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_FIRST_TWO,
      gates: [draftGate("resolved")],
      verifications: [{ gateId: "gate-draft", reviewTaskId: REVIEW_TASK_ID, outcome: "verified" }],
    });

    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    render(
      <RunStepRailPanel
        entries={rail.entries}
        activeOrdinal={rail.activeOrdinal}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );
    const frameRows = drawnRows();
    cleanup();

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...panelProps({ initialStatus: "completed", railExtras: railExtrasOf(rail.entries) })}
      />,
    );
    const columnRows = drawnRows();

    expect(columnRows).toEqual(frameRows);
    for (const rows of [frameRows, columnRows]) {
      const marked = rows.filter((row) => row.includes("Review the draft"));
      expect(marked).toHaveLength(1);
      expect(marked[0].startsWith("gate:")).toBe(true);
      const at = rows.indexOf(marked[0]);
      expect(rows[at + 1]?.startsWith("verification:")).toBe(true);
      expect(rows.filter((row) => row.startsWith("gate:"))).toHaveLength(1);
    }
  });
});

describe("the entry the run is parked on is the highlighted one (cinatra#3035)", () => {
  it("a run parked at a gate standing in a spine step elects that step", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 2,
        spine: STEPPER_STEPS,
        railExtras: [],
        spineGates: [{ index: 3, status: "pending" }],
      }),
    ).toBe(3);
  });

  it("no later declared pause reads settled before the run reached it", async () => {
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_FIRST_TWO,
      gates: [draftGate("pending")],
    });
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...panelProps({ initialStatus: "pending_approval", railExtras: railExtrasOf(rail.entries) })}
      />,
    );
    const fourth = document.querySelector('[data-rail-kind="step"][data-rail-step-number="6"]');
    expect(fourth).not.toBeNull();
    expect(fourth!.getAttribute("data-rail-status")).not.toBe("completed");
    // The earlier pauses the run answered still read passed.
    expect(
      document
        .querySelector('[data-rail-kind="step"][data-rail-step-number="2"]')
        ?.getAttribute("data-rail-status"),
    ).toBe("completed");
  });

  it("with a settled and a pending gate in the marked step's place, the run-frame rail highlights the pending one", async () => {
    const pendingTaskId = "wayflow-task-draft#2";
    const rail = buildRunStepRail({
      templateSteps: templateSteps(),
      submissions: ANSWERED_FIRST_TWO,
      gates: [
        draftGate("resolved"),
        {
          gateId: "gate-draft-2",
          reviewTaskId: pendingTaskId,
          status: "pending",
          disposition: null,
          createdAt: "2026-09-29T10:50:00Z",
        },
      ],
    });
    expect(rail.entries.map((e) => e.key)).toEqual([
      "step:1",
      "step:2",
      `gate:${REVIEW_TASK_ID}`,
      `gate:${pendingTaskId}`,
      "step:6",
    ]);
    // Every entry keeps an ordinal of its own, so the one `activeOrdinal`
    // names is the pending gate.
    expect(new Set(rail.entries.map((e) => e.ordinal)).size).toBe(rail.entries.length);
    expect(rail.entries.find((e) => e.ordinal === rail.activeOrdinal)?.key).toBe(`gate:${pendingTaskId}`);

    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    render(
      <RunStepRailPanel
        entries={rail.entries}
        activeOrdinal={rail.activeOrdinal}
        reviewHrefBase={REVIEW_HREF_BASE}
      />,
    );
    const rows = Array.from(document.querySelectorAll("[data-rail-kind]"));
    const stateOf = (row: Element) => row.closest("[data-state]")?.getAttribute("data-state");
    expect(stateOf(rows[2])).toBe("completed");
    expect(stateOf(rows[3])).toBe("active");
    expect(stateOf(rows[4])).not.toBe("completed");
  });
});
