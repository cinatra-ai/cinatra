// @vitest-environment jsdom
/**
 * THE RUN DETAIL ENDS IN THE PROMPT WINDOW — THE CARD'S FRAME ENDS AT THE
 * DECISION BAR (cinatra#3149, fix leg 4, finding 1).
 *
 * A proof round of this branch was refused on its own pictures: the visible
 * rounded panel the run page draws around the review closed UNDER the
 * conversational prompt window, so the window read as a part of the card.
 *
 * The ratified drawing, `specs/app-artifact-review.html` at design main
 * 033a697c, section I.3:
 *
 *   "The run page hosts the same card the conversation hosts ... Only the frame
 *    around it changes: a thread ends in its composer, and the run detail ends
 *    in the prompt window (Section VI)."
 *
 * and its own reading of that detail draws the card's parts each in their own
 * bordered box — the target, then the note over the decision bar — and the
 * prompt window BENEATH them, on the detail's own ground, in no box at all.
 *
 * WHAT IS PINNED, AND WHAT IS NOT. Not that the window stops belonging to the
 * gate: it is still the gate's own window, still exactly one per gate, still
 * drawn by the card that owns the decision (cinatra#3141 item 1, whose suite
 * stands unchanged beside this one). What is pinned is the BOX it lands in on
 * the run detail — outside the panel that holds the card's body, and last in
 * the detail column, which is what "the run detail ends in the prompt window"
 * says about a picture.
 *
 * jsdom lays nothing out, so both readings are taken off the tree rather than
 * off a rectangle: containment for "not inside the frame", and document order
 * for "ends in".
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-detail-ends-in-the-prompt-window.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The real PromptField pulls browser-only deps jsdom cannot load. The stub is
// the one the sibling window suites use: a plain element carrying the
// placeholder as text, and no control this suite invented.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
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

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
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
  resetAgentRun: vi.fn(async () => ({ ok: true })),
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
    runId: "run-3149",
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

/** The run is PARKED on a review gate, and carries the gate's own minted ref —
 *  the marked-review-gate reading the run detail draws in place. */
const PARKED_ON_A_REVIEW = {
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  schema: null,
  values: { lifecycleCardRef: "ref-3149" },
  reviewTaskId: "lg-3149",
};

/** The run's own reading of itself. The pending gate is the default; the
 *  decided-gate suite below swaps in the finished run that carries a settled
 *  review (cinatra#3149, fix leg 6, defect C). */
const PARKED_STREAM = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  messages: [] as unknown[],
  dataPartFrames: [] as unknown[],
  lifecycleInterrupt: null,
  interruptContext: PARKED_ON_A_REVIEW as unknown,
  streamedText: "",
};
const DECIDED_STREAM = {
  ...PARKED_STREAM,
  status: "completed",
  isLive: false,
  interruptContext: null as unknown,
};
let mockRunStream: typeof PARKED_STREAM = PARKED_STREAM;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => mockRunStream,
}));

const CARD = '[data-conformance-id="review-gate-card"]';
const WINDOW = '[data-conformance-id="review-prompt-window"]';
const BAR = '[data-conformance-id="review-decision-bar"]';
/** The run page's own visible panel around the review reading. */
const FRAME = '[data-run-review-slot="review"]';

beforeEach(() => {
  cleanup();
  mockRunStream = PARKED_STREAM;
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      // The gate the card resolves for itself: pending, decidable, and open to
      // a comment — which is the state that draws the window at all.
      if (url.includes("/api/lifecycle-views/resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "artifact_review_gate",
            state: { state: "pending", canDecide: true, canComment: true },
            body: null,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "pending_approval", inputParams: {} }),
      };
    }),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** The run detail column, as the run surface's own frame draws it. */
async function renderRunDetail() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const result = render(
    <div data-run-detail-column="">
      <AgenticRunPanel
        runId="run-3149"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
        templateId="tmpl-3149"
        canRespondInWindow={true}
      />
    </div>,
  );
  await waitFor(() => expect(result.container.querySelector(WINDOW)).not.toBeNull());
  return result;
}

describe("the run detail's review reading ends in the prompt window", () => {
  it("draws the window OUTSIDE the panel that frames the card's body", async () => {
    const { container } = await renderRunDetail();

    const frame = container.querySelector<HTMLElement>(FRAME);
    const win = container.querySelector<HTMLElement>(WINDOW);
    expect(frame, "the run detail draws its review panel").not.toBeNull();
    expect(win, "the gate draws its one window").not.toBeNull();

    // The reviewer's finding, in one assertion: the rounded panel does not
    // enclose the window.
    expect(frame!.contains(win!)).toBe(false);
    // Nor does the card's own frame element, which is the box that panel wraps.
    const card = container.querySelector<HTMLElement>(CARD);
    expect(card).not.toBeNull();
    expect(card!.contains(win!)).toBe(false);
  });

  it("keeps the window BENEATH the decision bar the frame ends at", async () => {
    const { container } = await renderRunDetail();

    const bar = container.querySelector<HTMLElement>(BAR)!;
    const win = container.querySelector<HTMLElement>(WINDOW)!;
    expect(bar).not.toBeNull();
    // "the run detail ends in the prompt window" — after the floor, never above
    // it. The frame ends at the bar; the window follows it on the detail's own
    // ground.
    expect(bar.compareDocumentPosition(win) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ENDS the run detail column in it — nothing is drawn after the window", async () => {
    const { container } = await renderRunDetail();

    const column = container.querySelector<HTMLElement>("[data-run-detail-column]")!;
    const win = container.querySelector<HTMLElement>(WINDOW)!;
    expect(column.contains(win)).toBe(true);

    // The LAST element in the column, in document order, is the window or a
    // part of it — which is what "ends in the prompt window" means for a tree.
    const all = column.querySelectorAll("*");
    const last = all[all.length - 1];
    expect(win.contains(last) || win === last).toBe(true);
  });

  it("still draws exactly ONE window for the one gate", async () => {
    const { container } = await renderRunDetail();
    expect(container.querySelectorAll(WINDOW)).toHaveLength(1);
    expect(document.querySelectorAll(WINDOW)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AND A DECIDED GATE READS THE SAME WAY (cinatra#3149, fix leg 6, defect C)
// ---------------------------------------------------------------------------
//
// The fifth proof round measured the decided gate's reading on this detail and
// found the window's mount there at zero height: the card drew the read-only
// decision and stopped, so the detail ended in the card instead of in the
// window. The drawing withdraws it nowhere — section VI puts it beneath the
// decision bar, section X draws it under the decision bar on the run detail,
// and section IX keeps the exchange with the RUN, which outlives the gate's
// decision.

/** The card's own settled reading — the decision line, where the floor was. */
const SETTLED = '[data-conformance-id="review-gate-settled"]';
/** The run detail's own mount for the window. */
const MOUNT = "[data-run-prompt-window-mount]";
const SETTLED_REF = "ref-3149-settled";

/** The run detail of a FINISHED run whose own review gate is already decided —
 *  the `reviewSlot.ref` path, which is how a completed run reaches its review
 *  screen in place. */
async function renderDecidedRunDetail() {
  mockRunStream = DECIDED_STREAM;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/lifecycle-views/resolve")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            kind: "artifact_review_gate",
            state: {
              state: "settled",
              outcome: "approved",
              decidedByName: "Dana Okonkwo",
            },
            body: null,
          }),
        };
      }
      if (url.includes("/api/agents/runs/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            reviewGate: { ref: SETTLED_REF, awaiting: false },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", inputParams: {} }),
      };
    }),
  );
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const result = render(
    <div data-run-detail-column="">
      <AgenticRunPanel
        runId="run-3149"
        initialStatus="completed"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
        templateId="tmpl-3149"
        canRespondInWindow={true}
        initialReviewGate={{ ref: SETTLED_REF, awaiting: false }}
      />
    </div>,
  );
  await waitFor(() => expect(result.container.querySelector(SETTLED)).not.toBeNull());
  return result;
}

describe("the run detail's DECIDED review reading ends in the prompt window too", () => {
  it("draws the window at all — the mount is not left empty on a decided gate", async () => {
    const { container } = await renderDecidedRunDetail();

    const mount = container.querySelector<HTMLElement>(MOUNT);
    expect(mount, "the run detail declares the window's mount").not.toBeNull();
    // THE DEFECT, IN ONE ASSERTION: the mount stood there with nothing in it.
    expect(mount!.children.length).toBeGreaterThan(0);
    await waitFor(() => expect(container.querySelectorAll(WINDOW)).toHaveLength(1));
  });

  it("keeps it OUTSIDE the panel that frames the decided card, exactly as on the pending gate", async () => {
    const { container } = await renderDecidedRunDetail();
    await waitFor(() => expect(container.querySelector(WINDOW)).not.toBeNull());

    const frame = container.querySelector<HTMLElement>(FRAME);
    const win = container.querySelector<HTMLElement>(WINDOW)!;
    expect(frame).not.toBeNull();
    expect(frame!.contains(win)).toBe(false);
    const card = container.querySelector<HTMLElement>(CARD);
    expect(card).not.toBeNull();
    expect(card!.contains(win)).toBe(false);
  });

  it("ENDS the run detail column in it, and draws exactly one", async () => {
    const { container } = await renderDecidedRunDetail();
    await waitFor(() => expect(container.querySelector(WINDOW)).not.toBeNull());

    const column = container.querySelector<HTMLElement>("[data-run-detail-column]")!;
    const win = container.querySelector<HTMLElement>(WINDOW)!;
    expect(column.contains(win)).toBe(true);
    const all = column.querySelectorAll("*");
    const last = all[all.length - 1];
    expect(win.contains(last) || win === last).toBe(true);
    expect(document.querySelectorAll(WINDOW)).toHaveLength(1);
  });
});
