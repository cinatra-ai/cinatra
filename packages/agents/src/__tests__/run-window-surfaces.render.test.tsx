// @vitest-environment jsdom
/**
 * THE FIVE WINDOWS, PROVEN BY RENDER (cinatra#2933, lifecycle-b W5b).
 *
 * The sibling suite `run-window-surfaces.test.ts` reads SOURCE. That is the
 * right instrument for the claims it still makes — one controller, one
 * placeholder, one replay predicate — and the wrong one for "the window is
 * there", which is what AC1 and AC3 are about. It reported green on a run page
 * that drew no window at all, because every string it looked for was present in
 * `agentic-run-panel.tsx`; what was missing was a prop at the mount.
 *
 * So each surface here is MOUNTED and the assertion is made against the DOM:
 *
 *   AC1  the window is drawn, and it offers the ratified placeholder;
 *   AC3  a person the run would refuse is shown no box.
 *
 * The fifth surface, the review page, lives under the host app and is rendered
 * by the root suite's
 * `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/review-prompt-window.render.test.tsx`
 * (one file per vitest project; the review window imports the host's own
 * artifact types). The run page's PRODUCTION mount — through
 * `SetupCompletionWatcher`, the way `instance-screens.tsx` mounts it — is
 * rendered by `run-page-window-render.test.tsx` in this directory.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-window-surfaces.render.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

/**
 * The window's own words, from the ratified drawing (design `fe2182547d4a`,
 * `app-artifact-review.html` §IX). Asserting the COPY rather than a test id:
 * a box drawn with different words is a different box.
 */
const RUN_WINDOW_PLACEHOLDER = /Ask Cinatra to suggest edits to the fields above/i;

// ---------------------------------------------------------------------------
// Mocks — everything the four surfaces reach that jsdom cannot resolve. NONE
// of them is part of the window: the shared panel, its visibility gates and
// the one controller all run for real.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls browser-only deps jsdom cannot load. The stub
  // surfaces the placeholder as text and exposes the send, so a test can put a
  // question into a window the way a reader does. A <div>, not a raw <input>:
  // the design-system lint gate forbids the bare element.
  PromptField: ({
    placeholder,
    onSubmit,
  }: {
    placeholder?: string;
    onSubmit?: (v: string) => unknown;
  }) => (
    <div data-testid="run-window-prompt">
      {placeholder}
      <button type="button" onClick={() => onSubmit?.("reschedule to 9 on weekdays")}>
        send-run-window-turn
      </button>
    </div>
  ),
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
  mount: (canRespond: boolean | undefined) => Promise<React.ReactElement>;
};

const SURFACES: Surface[] = [
  {
    name: "the run page",
    surface: "run-page",
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
 * The armed schedule's window has a SECOND reason to be absent that belongs to
 * the schedule rather than to the reader: once the schedule is over there are no
 * fields to ask about, so the composer is withdrawn (cinatra#3004). The two
 * reasons are independent and both still hold, which is what this asserts —
 * carrying that behaviour through the change that made this window the run's
 * conversation.
 */
describe("a form fill that fails is still said out loud", () => {
  // The armed schedule's window does TWO jobs with one typed sentence: it puts
  // the turn into the run's conversation, and it asks the assist route to fill
  // this form's fields. When the second fails the fields are not filled, and a
  // reader told nothing would read the run's own answer as if they had been.
  //
  // The line is the PLATFORM's, not the conversation's: nothing is written on
  // the success path, the stored exchange stays the only record of what was
  // asked and answered, and this is shown after it.
  it("shows the platform's line when the assist call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const { SchedulePromptWindow } = await import("../schedule-prompt-window");
    render(
      <SchedulePromptWindow
        templateId="tmpl-2933"
        runId="run-2933"
        canRespondInWindow={true}
        readOnly={false}
      />,
    );
    await settle();
    fireEvent.click(screen.getByText("send-run-window-turn"));
    const notice = await screen.findByText(/Could not fetch suggestions/i);
    expect(notice).not.toBeNull();
  });

  it("writes no platform line when the assist call succeeds", async () => {
    // The success path must add nothing: the stored exchange already carries
    // the answer, and a second copy beside it is the parallel transcript this
    // slice removed from every window.
    const { SchedulePromptWindow } = await import("../schedule-prompt-window");
    render(
      <SchedulePromptWindow
        templateId="tmpl-2933"
        runId="run-2933"
        canRespondInWindow={true}
        readOnly={false}
      />,
    );
    await settle();
    fireEvent.click(screen.getByText("send-run-window-turn"));
    await settle();
    expect(screen.queryByText(/Could not fetch suggestions/i)).toBeNull();
    expect(screen.queryByText(/^Done\.$/)).toBeNull();
  });
});

describe("the armed schedule's window is withdrawn once the schedule is over", () => {
  it("draws no box for a reader WITH access when the schedule can no longer change", async () => {
    const { SchedulePromptWindow } = await import("../schedule-prompt-window");
    render(
      <SchedulePromptWindow
        templateId="tmpl-2933"
        runId="run-2933"
        canRespondInWindow={true}
        readOnly={true}
      />,
    );
    await settle();
    expect(screen.queryByText(RUN_WINDOW_PLACEHOLDER)).toBeNull();
  });
});

describe("AC1 — each window outside the chat is DRAWN, with the ratified placeholder", () => {
  for (const s of SURFACES) {
    it(`${s.name} ("${s.surface}") draws the window`, async () => {
      render(await s.mount(true));
      await settle();
      expect(screen.queryByText(RUN_WINDOW_PLACEHOLDER)).not.toBeNull();
    });
  }
});

describe("AC3 — a person the run would refuse is shown no box", () => {
  for (const s of SURFACES) {
    it(`${s.name} ("${s.surface}") draws NO window without respond access`, async () => {
      render(await s.mount(false));
      await settle();
      expect(screen.queryByText(RUN_WINDOW_PLACEHOLDER)).toBeNull();
    });
  }
});

describe("the refusal is the run's answer, not an accident of the mount", () => {
  // A surface that dropped the prop would show no box for BOTH readings and
  // AC3 would pass for the wrong reason — the run page's defect exactly. Each
  // surface is therefore asserted from both sides, on one render pass each,
  // and the two outcomes must DIFFER.
  for (const s of SURFACES) {
    it(`${s.name} answers differently with and without access`, async () => {
      const withAccess = render(await s.mount(true));
      await settle();
      const drawn = screen.queryByText(RUN_WINDOW_PLACEHOLDER) !== null;
      withAccess.unmount();
      cleanup();
      document.body.innerHTML = "";
      document.body.appendChild(document.createElement("main"));

      render(await s.mount(false));
      await settle();
      const refused = screen.queryByText(RUN_WINDOW_PLACEHOLDER) !== null;

      expect(drawn).toBe(true);
      expect(refused).toBe(false);
    });
  }
});
