// @vitest-environment jsdom
/**
 * THE RUN DETAIL TAKES THE SECOND GATE OF ONE PAUSE (cinatra#3035, CELL2).
 *
 * One pause raises two review gates, the post's and then the featured image's.
 * The person approves the post; the run stays `pending_approval`, the server's
 * rail advances, and the server render that follows hands the panel the image
 * gate as its `initialReviewGate`.
 *
 * The run detail kept the post's gate instead. Its settled card drew no
 * decision bar and no prompt window, so the person had nothing to press on a
 * gate that was waiting for them, until a look of the slot reader (two to ten
 * seconds on) found it. This case holds the reader silent, which is what
 * isolates the road under test: the panel must take the server's answer when
 * its gate changes.
 *
 * The decision bar is read by its anchor and by its terminal affirmative
 * control, which is named Approve on the floor today and Continue in the
 * ratified drawing, so the case does not move with that rename.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel-second-gate-of-one-pause-3035.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "Loader2Icon" || prop === "Loader2") return actual.Loader2Icon;
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
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
    ok: true as const,
    outputs: [] as { id: string; type: string; title: string }[],
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

// The gate's prompt window keeps its exchange with the run; nothing was said.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string,
  interruptContext: null as Record<string, unknown> | null,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: streamState.status,
    interruptContext: streamState.interruptContext,
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

// THE PAGE OWNS THE WINDOW (cinatra#3487): the panel registers the gate's
// prompt window with the run page's chrome, which draws it. The panel is
// mounted under the chrome, as the run page mounts it.
import { RunPageChrome } from "../run-page-chrome";

const POST_REF = "lcr-3035-post-gate";
const IMAGE_REF = "lcr-3035-image-gate";
const POST_GATE = {
  ref: POST_REF,
  awaiting: false,
  producedReviewPark: true,
  reviewTaskId: "task-3035-post",
};
const IMAGE_GATE = {
  ref: IMAGE_REF,
  awaiting: false,
  producedReviewPark: true,
  reviewTaskId: "task-3035-image",
};

/** The gate the person already decided, and the gate that waits for them. */
const RESOLVE_SETTLED = {
  kind: "artifact_review_gate",
  state: { state: "settled", outcome: "approved" },
  body: null,
};
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The refs the card asked the resolve route about, in order. */
const resolvedRefs: string[] = [];

beforeEach(() => {
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
  resolvedRefs.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      // THE SLOT READER'S LOOK NEVER ANSWERS. The case is about the server's
      // answer reaching the panel as its `initialReviewGate`; a reader that
      // answered would find the image gate by itself a few seconds on and hide
      // exactly the defect.
      if (url.includes("/api/agents/runs/")) return new Promise<Response>(() => {});
      const ref = (JSON.parse(String(init?.body ?? "{}")) as { ref?: string }).ref ?? "";
      resolvedRefs.push(ref);
      return new Response(JSON.stringify(ref === IMAGE_REF ? RESOLVE_PENDING : RESOLVE_SETTLED), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

/** The setup question the person answered long ago, still on the row. */
const SPENT_SETUP_INTERRUPT = {
  xRenderer: "grouped-setup-form",
  reviewTaskId: "setup-run-3035",
  inputSchema: { type: "object", properties: {}, required: [] },
  currentValues: { stepNumber: 0 },
};

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3035-two-gates",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-3035",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

const SETTLED = '[data-conformance-id="review-gate-settled"]';
const DECISION_BAR = '[data-conformance-id="review-decision-bar"]';
const PROMPT_WINDOW = '[data-conformance-id="review-prompt-window"]';
const CHROME_PROMPT_WINDOW = `[data-run-window-host="page-chrome"] ${PROMPT_WINDOW}`;

/** The bar's terminal affirmative control, however the floor names it. */
function terminalControl(root: ParentNode): HTMLButtonElement | null {
  const bar = root.querySelector(DECISION_BAR);
  if (!bar) return null;
  const buttons = Array.from(bar.querySelectorAll("button"));
  return (
    buttons.find((button) => /^(approve|continue)$/i.test((button.textContent ?? "").trim())) ??
    null
  );
}

describe("OrchestratorStepperPanel: the second gate of one pause", () => {
  it("draws the image gate's decision bar and prompt window when the server hands it over", async () => {
    streamState.interruptContext = SPENT_SETUP_INTERRUPT;
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container, rerender } = render(
      <RunPageChrome>
        <OrchestratorStepperPanel {...baseProps({ initialReviewGate: POST_GATE })} />
      </RunPageChrome>,
    );

    // The post's gate, decided: a settled card, and nothing to press.
    await waitFor(
      () => {
        if (!container.querySelector(SETTLED)) throw new Error("the settled card never drew");
      },
      { timeout: 20_000 },
    );
    expect(container.querySelector(DECISION_BAR)).toBeNull();
    expect(container.querySelector(PROMPT_WINDOW)).toBeNull();

    // THE POST IS APPROVED. The run stays `pending_approval` and the server
    // render that follows names the image gate; the status, the run and the
    // credential do not move.
    rerender(
      <RunPageChrome>
        <OrchestratorStepperPanel {...baseProps({ initialReviewGate: IMAGE_GATE })} />
      </RunPageChrome>,
    );

    await waitFor(
      () => {
        if (!terminalControl(container)) {
          throw new Error("the image gate drew no decision bar with its terminal control");
        }
      },
      { timeout: 10_000 },
    );
    expect(terminalControl(container)!.disabled).toBe(false);
    // The chrome draws the window only after the gate's screen registers in an
    // effect and the chrome's mount node is set, a render or two after the bar:
    // wait for it under the same limit, never read it in the bar's render.
    await waitFor(
      () => {
        const control = terminalControl(container);
        if (!control || control.disabled) {
          throw new Error("the decision bar lost its enabled terminal control while the window mounted");
        }
        if (!container.querySelector(CHROME_PROMPT_WINDOW)) {
          throw new Error("the image gate drew no prompt window");
        }
      },
      { timeout: 10_000 },
    );
    expect(container.querySelector(SETTLED), "the decided post gate is still drawn").toBeNull();
    expect(resolvedRefs).toContain(IMAGE_REF);
  }, 60_000);
});
