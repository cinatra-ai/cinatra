// @vitest-environment jsdom
/**
 * THE STEP THE RUN IS PAUSED ON IS HIGHLIGHTED (cinatra#3221).
 *
 * The ratified drawing, agent run and review surface, "The step rail — merged
 * steps and gate entries":
 *
 *   "The step the run is paused on is highlighted; steps already passed sit
 *    above it, steps still to come below."
 *
 * and, in the same section, "so the rail is the run's whole lifecycle at a
 * glance, not just its live tip."
 *
 * The run page's live rail elects its highlighted entry from ONE number, the
 * stepper's `value`. That number used to be derived from the run's status and
 * the live interrupt's spine step alone, so a gate that arrives as a TRAILING
 * entry — a context-selection gate, a review gate past the spine — was never
 * its target: on a gate reading no entry highlighted at all. The election now
 * lives in `run-step-rail-extra-entry.tsx`, pure, and is read here twice — as a unit
 * (item 2) and through the mounted panel's DOM (items 1, 3, 4).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-active-step.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { electRunRailActiveStep } from "../run-step-rail-extra-entry";

const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
  usePathname: () => "/agents/cinatra-ai/email-outreach-agent/run-3221",
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
  ),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
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
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3221",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts?: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: stream.interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    lifecycleInterrupt: null,
    isLive: true,
    error: null,
  }),
}));

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
type RailEntry = import("../run-step-rail").RunStepRailEntry;

const REVIEW_HREF_BASE = "/agents/cinatra-ai%2Femail-outreach-agent/run-3221/review";

/** Two spine steps: the setup gate and one renderer gate. */
const SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Campaign setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
  { index: 2, stepNumber: 1, label: "Review recipients", xRenderer: "@cinatra-ai/email-recipient-selection-agent:output" },
];

const resolvedGate = (): RailEntry => ({
  key: "gate:task-resolved",
  ordinal: 3,
  kind: "gate",
  label: "Review",
  status: "resolved",
  sources: ["gate"],
  gate: { gateId: "gate-1", reviewTaskId: "task-resolved", disposition: "approved", resolved: true },
});

/** The context-selection gate the graded run was parked on: a TRAILING entry. */
const pendingGate = (): RailEntry => ({
  key: "gate:task-pending",
  ordinal: 4,
  kind: "gate",
  label: "Context selection",
  status: "pending",
  sources: ["gate"],
  gate: { gateId: "gate-2", reviewTaskId: "task-pending", disposition: null, resolved: false },
});

const skippedDecision = (ordinal: number): RailEntry => ({
  key: `lifecycle:event-${ordinal}`,
  ordinal,
  kind: "lifecycleDecision",
  label: "Review skipped",
  status: "skipped",
  sources: ["lifecycleDecision"],
  lifecycleDecision: {
    eventId: `event-${ordinal}`,
    artifactId: "artifact-9",
    outcome: "skipped",
    decidedBy: "org-bound",
    latticeOutcome: "skip",
    reason: "The org policy skips review for outreach drafts.",
  },
});

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3221",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true,
    agentPackageName: "@cinatra-ai/email-outreach-agent",
    inputParams: {},
    stepperSteps: SPINE,
    agentId: "cinatra-ai/email-outreach-agent",
    lgThreadId: null,
    templateId: "tmpl-3221",
    templateName: "Email Outreach Agent",
    railExtras: [],
    reviewHrefBase: REVIEW_HREF_BASE,
    ...overrides,
  };
}

function items(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-run-step-rail] [data-slot="stepper-item"]'),
  );
}

function activeItems(): HTMLElement[] {
  return items().filter((item) => item.getAttribute("data-state") === "active");
}

beforeEach(() => {
  stream.interruptContext = null;
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ status: "pending_approval", inputParams: {} }) })),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Item 2 — the election, as a unit: the elected index is the parked entry's own.
// ---------------------------------------------------------------------------
describe("activeStep resolves to the display index of the entry the run is parked on (item 2)", () => {
  const spine = SPINE.map((s) => ({ index: s.index, stepNumber: s.stepNumber }));
  const trailing = [resolvedGate(), pendingGate()];
  /** Two spine rows, then the resolved gate (3) and the parked gate (4). */
  const PARKED_GATE_DISPLAY_INDEX = 4;

  it("elects the parked trailing gate in the awaitingNextStep case, not the index after the spine step", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: 1,
        awaitingNextStep: true,
        highestStepNumber: 1,
        spine,
        railExtras: trailing,
      }),
    ).toBe(PARKED_GATE_DISPLAY_INDEX);
  });

  it("elects the parked trailing gate when the interrupt carries no spine step number", () => {
    // This case used to fall through to the election's final `return 1`.
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 1,
        spine,
        railExtras: trailing,
      }),
    ).toBe(PARKED_GATE_DISPLAY_INDEX);
  });

  it("elects the gate reached on a stopped run", () => {
    expect(
      electRunRailActiveStep({
        status: "stopped",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 1,
        spine,
        railExtras: trailing,
      }),
    ).toBe(PARKED_GATE_DISPLAY_INDEX);
  });

  it("keeps electing a gate that arrives ON the spine by its own row", () => {
    expect(
      electRunRailActiveStep({
        status: "pending_approval",
        currentStepNumber: 1,
        awaitingNextStep: false,
        highestStepNumber: 1,
        spine,
        railExtras: [resolvedGate()],
      }),
    ).toBe(2);
  });

  it("elects nothing on a run with no gate open and nothing pending", () => {
    // Past every row the rail draws — spine AND trailing — so no entry can
    // read as active, whichever kind stands first among the trailing rows.
    const extras = [skippedDecision(3), resolvedGate()];
    expect(
      electRunRailActiveStep({
        status: "completed",
        currentStepNumber: null,
        awaitingNextStep: false,
        highestStepNumber: 1,
        spine,
        railExtras: extras,
      }),
    ).toBe(spine.length + extras.length + 1);
  });

  it("leaves the pre-execution and running readings as they were", () => {
    const base = { currentStepNumber: null, awaitingNextStep: false, highestStepNumber: 0, spine, railExtras: [] };
    expect(electRunRailActiveStep({ ...base, status: "queued" })).toBe(1);
    expect(electRunRailActiveStep({ ...base, status: "pending_input" })).toBe(1);
    expect(electRunRailActiveStep({ ...base, status: "running", highestStepNumber: 0 })).toBe(2);
    expect(electRunRailActiveStep({ ...base, status: "failed", highestStepNumber: 1 })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Items 1, 3, 4 — the mounted rail.
// ---------------------------------------------------------------------------
describe("a run parked on a gate elects exactly one highlighted rail entry (item 1)", () => {
  it("highlights the parked gate that arrives as a TRAILING entry", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({ railExtras: [resolvedGate(), pendingGate(), skippedDecision(5)] })}
      />,
    );
    await waitFor(() => expect(items().length).toBe(5));

    const active = activeItems();
    expect(active.length).toBe(1);
    expect(active[0]!.querySelector('[data-rail-gate-pending="true"]')).not.toBeNull();
  });

  it("highlights the parked gate that arrives ON the spine", async () => {
    stream.interruptContext = {
      xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
      schema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
      values: { stepNumber: 1, recipients: [] },
      reviewTaskId: "lg-run-3221",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ railExtras: [resolvedGate()] })} />);
    await waitFor(() => expect(items().length).toBe(3));

    const active = activeItems();
    expect(active.length).toBe(1);
    expect(active[0]!.querySelector('[data-rail-step-number="1"]')).not.toBeNull();
  });
});

describe("steps already passed sit above the elected entry, steps still to come below (item 3)", () => {
  it("reads every entry above as passed and every entry below as still to come", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({ railExtras: [resolvedGate(), pendingGate(), skippedDecision(5)] })}
      />,
    );
    await waitFor(() => expect(items().length).toBe(5));

    const states = items().map((item) => item.getAttribute("data-state"));
    expect(states).toEqual(["completed", "completed", "completed", "active", "inactive"]);
    // The spine rows say so in the rail's own vocabulary too.
    const spineStatus = Array.from(
      document.querySelectorAll<HTMLElement>('[data-rail-kind="step"]'),
    ).map((row) => row.getAttribute("data-rail-status"));
    expect(spineStatus).toEqual(["completed", "completed"]);
  });
});

describe("a fully resolved rail elects no entry (item 4)", () => {
  it("carries zero active entries when no gate is open and nothing is pending", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          initialStatus: "completed",
          // The skipped decision stands FIRST among the trailing rows: a
          // past-the-spine election that stopped one row short would light it.
          railExtras: [skippedDecision(3), resolvedGate()],
        })}
      />,
    );
    await waitFor(() => expect(items().length).toBe(4));
    expect(activeItems().length).toBe(0);
  });
});
