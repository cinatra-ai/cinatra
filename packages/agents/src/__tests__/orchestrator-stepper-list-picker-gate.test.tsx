// @vitest-environment jsdom
/**
 * THE GATE THAT LISTS, ON THE RUN'S OWN PANEL (cinatra#3358 — the second fix
 * leg). The step's page is pinned in `list-picker-gate-drawn.test.tsx`; the two
 * readings pinned HERE belong to the panel around it — the control floor, and
 * the rail.
 *
 * The checklist sentences these answer, verbatim:
 *
 *   "the Continue control is disabled while nothing is picked and nothing
 *    pickable ... the primary Continue right-aligned over the hairline control
 *    floor"
 *
 *   "no info icon on rail entries"
 *
 *   pnpm vitest run \
 *     packages/agents/src/__tests__/orchestrator-stepper-list-picker-gate.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Loader2", "Pause", "X", "default"],
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

let interruptContext: {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
} | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  interruptContext = null;
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

const LIST_PICKER = "@cinatra-ai/email-outreach-agent:list-picker";

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3358",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-ai/email-outreach-agent",
    inputParams: {},
    stepperSteps: [
      {
        index: 1,
        stepNumber: 0,
        label: "Account scope",
        xRenderer: LIST_PICKER,
        description: "Choose the list this run sends to",
      },
      {
        index: 2,
        stepNumber: 1,
        label: "Review drafts",
        xRenderer: "email-drafts-review",
        description: "Approve the drafts before send",
      },
    ],
    agentId: "cinatra-ai/email-outreach-agent",
    lgThreadId: null,
    templateId: "tmpl-3358",
    templateName: "Email outreach",
    ...overrides,
  };
}

function continueButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    /^continue/i.test((b.textContent ?? "").trim()),
  ) as HTMLButtonElement | undefined ?? null;
}

describe('"the Continue control is disabled while nothing is picked and nothing pickable"', () => {
  it("offers the control unavailable while the step names no list", async () => {
    // THE MEASURED DEFECT: the control was live, the press was refused, and the
    // reader learned the step could not be continued only by trying. The drawing
    // is the other way round — "the Continue stays unavailable until a row is
    // picked" — so what would be refused is simply not offered.
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      values: {},
      reviewTaskId: "task-3358",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(true);
  });

  it("makes it available the moment the step holds a list", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      values: { listId: "lst_1", listName: "Marketing directors", memberCount: 5 },
      reviewTaskId: "task-3358",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(false);
  });

  // ITEM 3 (cinatra#3562) — "Continue stays unavailable until at least one
  // entry is ticked". The control reads the SAME one predicate the press reads,
  // so a step holding an entry SET is answerable and one holding an empty set
  // is not.
  it("makes it available the moment the step holds at least one ticked entry", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      // THE ENTRY SET ALONE, with no single-identifier field beside it: this is
      // the answer a gate that takes several picks holds, and the widened
      // predicate has to read it as naming something.
      values: {
        listIds: ["lst_1", "lst_2"],
        listNames: ["Marketing directors", "Q2 targets"],
      },
      reviewTaskId: "task-3562",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(false);
  });

  it("offers the control unavailable while the ticked set is empty", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      values: { listIds: [], listNames: [] },
      reviewTaskId: "task-3562",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(true);
  });

  it("leaves every other gate family's control exactly as it was", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: "@cinatra-ai/email-outreach-agent:drafts-output",
      values: {},
      reviewTaskId: "task-other",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    expect(continueButton()!.disabled).toBe(false);
  });

  it("draws the control right-aligned over the hairline floor", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      values: {},
      reviewTaskId: "task-3358",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() => expect(continueButton()).not.toBeNull());
    const floor = continueButton()!.parentElement!;
    expect(floor.className).toContain("justify-end");
    expect(floor.className).toContain("border-t");
  });
});

describe('"no info icon on rail entries"', () => {
  it("draws no second affordance beside a rail row that carries a description", async () => {
    // The rail NAMES the run's ordered steps (Agent run & review §I). An ⓘ on
    // every described row is a control the drawing does not give it — and on the
    // account-scope step it sat beside the very row the reader must press.
    interruptContext = {
      schema: { type: "object" },
      xRenderer: LIST_PICKER,
      values: {},
      reviewTaskId: "task-3358",
    };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(container.querySelector("[data-run-step-rail]")).not.toBeNull(),
    );
    expect(container.querySelectorAll("[data-rail-step-info]").length).toBe(0);
    // The rail still names its steps — the row itself is untouched.
    expect(container.textContent).toContain("Account scope");
    expect(container.textContent).toContain("Review drafts");
  });
});
