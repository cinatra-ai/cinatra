// @vitest-environment jsdom
/**
 * THE PROMPT WINDOW SITS UNDER THE STEP'S OWN WORK (cinatra#3188 item 3).
 *
 * The run-surface drawing puts the window inside the run detail, under the work
 * it belongs to, in its own words:
 *
 *   "Beneath the form the run's prompt window (§IX) sits where it always sits —
 *    below the scheduler, in the same column."
 *
 *   "the gate itself — header, the one review target, decision bar and the run's
 *    prompt window — fills the run detail on the right."
 *
 * The shared panel took its mount from the caller, and three of its four
 * callers handed it the page's own frame element: the window left the step it
 * belongs to and docked across the foot of the whole frame instead. The fourth
 * caller had already fixed this for the schedule reading by rendering its own
 * mount, and this suite holds the other three to the same reading.
 *
 * WHAT IS PINNED. Where the window LANDS — inside the column the step's work is
 * drawn in, and not in the frame element outside it — and that it is not docked
 * to the foot of the frame. jsdom lays nothing out, so the containment the
 * drawing asks for is read off the tree rather than off a rectangle: the window
 * is a descendant of the detail column, which is what "in the same column"
 * means for a picture too.
 *
 * The harness below is the one `run-window-surfaces.render.test.tsx` uses, so
 * the surfaces mounted here are the real components with the props their real
 * hosts pass.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-window-in-detail-column.render.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

/**
 * IS A BOX DRAWN AT ALL. Every reading of the window opens its sentence the
 * same way (§X: "These are five readings of one window, never five windows"),
 * so this matches the window WHICHEVER reading it is — the right instrument for
 * "drawn / not drawn", and the wrong one for "which sentence", which the §X
 * block below asserts against each surface's own words.
 */
const ANY_WINDOW_SENTENCE = /^Ask Cinatra /;

// ---------------------------------------------------------------------------
// Mocks — everything the four surfaces reach that jsdom cannot resolve. NONE
// of them is part of the window: the shared panel, its visibility gates and
// the one controller all run for real.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The window's own send, captured from the field the shared panel renders.
 *
 * A test drives the REAL submit path through it rather than through a control
 * of its own: the stub adds no element to click, so nothing here can pass a
 * design-system rule's judgement on markup this suite invented.
 */
const promptField = vi.hoisted(() => ({
  submit: null as null | ((value: string) => unknown),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls browser-only deps jsdom cannot load. The stub
  // surfaces the placeholder as text and hands its send to the holder above. A
  // <div>, not a raw <input>: the design-system lint gate forbids the bare
  // element in favour of the shadcn <Input>.
  PromptField: ({
    placeholder,
    onSubmit,
  }: {
    placeholder?: string;
    onSubmit?: (value: string) => unknown;
  }) => {
    promptField.submit = onSubmit ?? null;
    return <div data-testid="run-window-prompt">{placeholder}</div>;
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

// The window's server bridge. Its behaviour is proven by the store's own unit
// and real-database tiers; here it only has to answer so the controller settles.
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
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2933",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../trigger-actions", () => ({
  setRunTrigger: vi.fn(async () => ({ ok: true })),
  cancelRunTrigger: vi.fn(async () => ({ ok: true })),
}));

// A run parked on a gate with a form — the state every window exists for.
const OPEN_GATE = {
  schema: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
  // Deliberately NOT the schema-field fallback: that combination is the
  // stepper's "generic object" reading, which carries no window by design.
  xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
  values: { campaignId: "c1", recipients: [] },
  reviewTaskId: "lg-run-2933",
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts?: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    messages: [],
    dataPartFrames: [],
    lifecycleInterrupt: null,
    interruptContext: OPEN_GATE,
    streamedText: "",
  }),
}));

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
  // The shared panel portals into <main>.
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "pending_approval", inputParams: {} }),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  promptField.submit = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Give the portal effect and the controller's mount read a turn to settle. */
async function settle() {
  await new Promise((r) => setTimeout(r, 60));
}

// ---------------------------------------------------------------------------
// The surfaces. Each entry mounts its REAL component with the props its real
// host passes, and takes the run's access answer as an argument.
// ---------------------------------------------------------------------------

type Surface = {
  name: string;
  surface: string;
  /**
   * §X's sentence for THIS reading, character for character from the ratified
   * drawing (design `458fb7ffce6c`, `app-artifact-review.html` §X, "One window,
   * five readings"), ellipsis included. It is written out here rather than
   * imported from the panel so the test states the drawing rather than
   * restating the product.
   */
  sentence: string;
  mount: (canRespond: boolean | undefined) => Promise<React.ReactElement>;
};

const SURFACES: Surface[] = [
  {
    name: "the run page",
    surface: "run-page",
    sentence: "Ask Cinatra to fill the fields above, or ask about this step…",
    mount: async (canRespond) => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      return (
        <AgenticRunPanel
          runId="run-2933"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled={true}
          templateId="tmpl-2933"
          canRespondInWindow={canRespond}
        />
      );
    },
  },
  {
    name: "the step-by-step screen",
    surface: "step-by-step",
    sentence: "Ask Cinatra to fill this step's fields, or ask about the run…",
    mount: async (canRespond) => {
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      return (
        <OrchestratorStepperPanel
          runId="run-2933"
          initialStatus="pending_approval"
          initialError={null}
          agUiEnabled={true}
          agentPackageName="cinatra-ai/email-recipient-selection-agent"
          inputParams={{}}
          stepperSteps={[
            {
              index: 1,
              stepNumber: 0,
              label: "Setup",
              xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
            },
          ]}
          agentId="cinatra-ai/email-recipient-selection-agent"
          lgThreadId={null}
          templateId="tmpl-2933"
          templateName="Recipient selection"
          canRespondInWindow={canRespond}
        />
      );
    },
  },
  {
    name: "the schedule screen",
    surface: "schedule",
    sentence: "Ask Cinatra to set the schedule above, or ask about it…",
    mount: async (canRespond) => {
      const { TriggerScreenClient } = await import("../trigger-screen-client");
      return (
        <TriggerScreenClient
          agentId="cinatra-ai/email-recipient-selection-agent"
          instanceId="run-2933"
          templateId="tmpl-2933"
          runId="run-2933"
          canRespondInWindow={canRespond}
          setupComplete={true}
        />
      );
    },
  },
  {
    // The Trigger tab that used to draw this window is retired (cinatra#3004);
    // `SchedulePromptWindow` is the one component both of the armed schedule's
    // hosts now mount, so this render is the window both of them draw.
    name: "the armed schedule's window",
    surface: "armed-trigger",
    sentence: "Ask Cinatra to change this schedule, or ask about it…",
    mount: async (canRespond) => {
      const { SchedulePromptWindow } = await import("../schedule-prompt-window");
      return (
        <SchedulePromptWindow
          templateId="tmpl-2933"
          runId="run-2933"
          canRespondInWindow={canRespond}
          readOnly={false}
        />
      );
    },
  },
];

/**
 * The three readings this issue is about. The armed schedule's window already
 * renders its own mount (`schedule-prompt-window.tsx`) and is the pattern the
 * other three follow, so it is not re-proved here.
 */
const COLUMN_SURFACES = SURFACES.filter((s) => s.surface !== "armed-trigger");

/** The run detail column, as the run surface's own frame draws it. */
function renderInDetailColumn(node: React.ReactElement) {
  return render(<div data-run-detail-column="">{node}</div>);
}

describe("the window is drawn inside the detail column, under the step's work", () => {
  for (const s of COLUMN_SURFACES) {
    it(`${s.name} lands its window in the column, not in the frame outside it`, async () => {
      const { container } = renderInDetailColumn(await s.mount(true));
      await settle();

      const win = screen.getByTestId("run-window-prompt");
      const column = container.querySelector<HTMLElement>("[data-run-detail-column]")!;
      expect(column).not.toBeNull();
      // "in the same column" — the window belongs to the step's own column.
      expect(column.contains(win)).toBe(true);
      // ...and not to the frame element that used to host it, which is the
      // full-frame dock the drawing does not give.
      const frame = document.querySelector<HTMLElement>("main")!;
      expect(frame).not.toBeNull();
      expect(frame.contains(win)).toBe(false);
    });

    it(`${s.name} does not dock its window to the foot of the frame`, async () => {
      renderInDetailColumn(await s.mount(true));
      await settle();

      const win = screen.getByTestId("run-window-prompt");
      // The panel's own outer element, found from the field rather than by a
      // class this suite would otherwise be restating.
      const panel = win.closest<HTMLElement>("[data-conv-open]")!;
      expect(panel).not.toBeNull();
      expect(panel.className).not.toContain("sticky");
      expect(panel.className).not.toContain("bottom-0");
    });
  }
});
