// @vitest-environment jsdom
/**
 * A PAUSE WITH NOTHING TO DRAW IS NOT A QUESTION (cinatra#3007, fix leg 6).
 *
 * The sibling suite `agentic-run-panel.park-without-status-edge.test.tsx` pins
 * the window once the reader has HEARD the park: the slot says
 * `producedReviewPark`, the panel holds the quiet placeholder, and the review
 * card swaps into the same box when the gate row arrives.
 *
 * The fifth capture photographed the window BEFORE that. The person has answered
 * the setup question, so the interrupt is gone from the row and the panel has no
 * approval step to draw; the run is still `pending_approval`, because that is
 * where a run parked on its produced output's review waits; and the slot reader
 * has not yet come back with the park. In that window the panel fell through to
 * the branch at the foot of the file and drew, in the conversation:
 *
 *   "Agentic Run Progress" with a "pending approval" status badge, "Run paused —
 *   awaiting human approval before continuing." beside a "Review approval"
 *   control, "Loading the approval step for this run…" beside a "Re-check"
 *   control, and "No messages yet." — with a spinner element count of 0.
 *
 * Against a drawing whose whole specification of this box is "the card frame,
 * and a spinning icon … It names no status, reports no result and draws nothing
 * to press."
 *
 * EVERY CONTROL IN THAT BRANCH ACTS ON AN APPROVAL STEP, and this arm is reached
 * only when there is no approval step at all. So inside a conversation the box
 * is the placeholder, held while the slot's reader is still looking. The RUN
 * PAGE keeps its recovery affordance — the Re-check that re-runs the hydration,
 * and the named reason once the derivation has really failed — which is a
 * shipped reading of the operator's own surface with its own pins, and the
 * second case here is the control that proves this leg did not take it away.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.pause-with-nothing-to-draw.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

/** The A2A task snapshot — the branch a conversation-dispatched run really takes,
 *  and the one that carries NO gate reading, so the row's park can reach the
 *  surface through the shared slot reader and through nothing else. */
const a2aSnapshot = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => a2aSnapshot.value),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3007",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

/** The stream, mute at `running` — a parked run announces nothing on the wire. */
const streamState = vi.hoisted(() => ({ status: "running" as string | null }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3007";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The setup question the run really asks before it does any work. */
const SETUP_ASK = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `setup-${RUN_ID}`,
  inputSchema: {
    type: "object",
    title: "idea",
    properties: { title: { type: "string" } },
    required: ["title"],
    "x-object-text-property": "title",
  },
  currentValues: {},
  fieldName: "idea",
};

const NOT_PARKED = { ref: null, awaiting: false, producedReviewPark: false };
const PARK_WITHOUT_GATE = { ref: null, awaiting: true, producedReviewPark: true };
const PARK_WITH_GATE = {
  ref: "lcr-no-edge-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/**
 * The run's seed route. Its `/api/agents/runs/` answers are the SLOT READER'S
 * looks and nothing else on these cases: the tick is task-backed, so it reads
 * the A2A snapshot instead of this route.
 */
function stubFetch(run: () => Record<string, unknown>) {
  const slotLooks: number[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      slotLooks.push(1);
      return new Response(JSON.stringify(run()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESOLVE_PENDING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, slotLooks };
}

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "pending_approval",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: SETUP_ASK,
    reviewGate: NOT_PARKED,
    ...over,
  };
}

function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: true as boolean | null,
    templateId: "tmpl-3007",
    // EVERY real run of this shape has one: the chat card seeds it off the row
    // and the run page reads it from the same row. It selects the task-snapshot
    // branch of the tick — the branch that carries no gate reading.
    taskId: "task-3007",
    surface: "chat" as "agent-detail" | "chat",
    initialReviewGate: NOT_PARKED,
    ...over,
  };
}

const SURFACES = [
  [
    "conversation",
    "chat" as const,
    (node: React.ReactNode) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>
    ),
    "chat_thread",
  ],
  ["run page", "agent-detail" as const, (node: React.ReactNode) => node, "run_card"],
] as const;

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
  a2aSnapshot.value = {
    taskId: "task-3007",
    state: "input-required",
    cinatraStatus: "pending_approval",
    runId: RUN_ID,
    messages: [],
    hitlContext: SETUP_ASK,
    error: null,
  };
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const ANSWERED_AND_CLEARED = null;

/** The row as it reads in the measured window: parked, no interrupt on file,
 *  and the slot not yet saying anything about a park. */
function pausedBody(over: Record<string, unknown> = {}) {
  return seedBody({ hitlContext: ANSWERED_AND_CLEARED, reviewGate: NOT_PARKED, ...over });
}

describe("the window between the answered question and the park's first look", () => {
  beforeEach(() => {
    // The stream reports the parked status directly — this window is not about
    // how the status arrives, it is about what is drawn once it has.
    streamState.status = "pending_approval";
    a2aSnapshot.value = {
      taskId: "task-3007",
      state: "input-required",
      cinatraStatus: "pending_approval",
      runId: RUN_ID,
      messages: [],
      hitlContext: ANSWERED_AND_CLEARED,
      error: null,
    };
  });

  it("conversation — the box is the quiet placeholder, not a progress card with two dead controls", async () => {
    const body = pausedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel {...panelProps({ surface: "chat", initialStatus: "pending_approval" })} />
      </LifecycleCardSurfaceProvider>,
    );

    const placeholder = await waitFor(
      () => {
        const slot = document.querySelector(SLOT);
        if (slot?.getAttribute("data-run-review-slot") !== "working") {
          throw new Error("the slot is not holding the placeholder");
        }
        const el = document.querySelector(PLACEHOLDER);
        if (!el) throw new Error("no placeholder");
        return el as HTMLElement;
      },
      { timeout: 20_000 },
    );

    // THE FRAME AND THE SPINNING ICON, and the four readings the capture
    // counted in this box, each required to be absent.
    expect(placeholder.querySelectorAll("svg.animate-spin").length).toBe(1);
    expect(screen.queryByRole("heading", { name: /Agentic Run Progress/i })).toBeNull();
    expect(screen.queryByText(/pending approval/i)).toBeNull();
    expect(screen.queryByText(/Run paused/i)).toBeNull();
    expect(screen.queryByText(/Loading the approval step/i)).toBeNull();
    expect(screen.queryByText(/No messages yet/i)).toBeNull();
    // NOTHING TO PRESS, counted rather than named one control at a time.
    expect(document.querySelector(SLOT)!.querySelectorAll("button").length).toBe(0);
    expect(document.querySelector(SLOT)!.querySelectorAll("a[href]").length).toBe(0);
  }, 40_000);

  it("conversation — a question ON FILE is never the quiet placeholder", async () => {
    // THE GUARD ON "NOTHING TO DRAW". The placeholder answers a pause where the
    // run recorded no question at all. It must not answer a pause where a
    // question IS on the row and this render simply is not drawing it, because
    // that is a live thing a person has to answer and the quiet box has nothing
    // to press and nothing to say. `effectiveHitlContext` alone cannot tell the
    // two apart: `applyJustSubmittedSuppression` nulls a NON-null interrupt for
    // as long as the just-submitted renderer matches, and it matches on the
    // renderer alone while a run's sequential setup fields deliberately reuse
    // one renderer — so the step AFTER a submitted one can be live, unanswered
    // and wearing a null context. The condition therefore consults the RAW
    // reading too: no interrupt on file, not merely none being drawn.
    //
    // STATED PLAINLY: this case pins the property (a question on file is never
    // the quiet box); it does not reach the SUPPRESSED shape, because arming
    // the suppression needs a real submit through the gate form and the gate
    // form does not render under this suite's mocks — the panel here draws its
    // progress card for the same state. The raw-reading guard is what makes the
    // property hold on both roads to a null context rather than on one.
    const body = seedBody({ hitlContext: SETUP_ASK, reviewGate: NOT_PARKED });
    stubFetch(() => body);
    a2aSnapshot.value = {
      taskId: "task-3007",
      state: "input-required",
      cinatraStatus: "pending_approval",
      runId: RUN_ID,
      messages: [],
      hitlContext: SETUP_ASK,
      error: null,
    };
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel {...panelProps({ surface: "chat", initialStatus: "pending_approval" })} />
      </LifecycleCardSurfaceProvider>,
    );

    // The run has reported its question; the panel has read it.
    await waitFor(
      () => {
        if (
          !/Awaiting input|Continue/i.test(document.body.textContent ?? "") &&
          ![...document.querySelectorAll("h2")].some((h) => /Agentic Run Progress/i.test(h.textContent ?? ""))
        ) {
          throw new Error("the panel never read the question off the run");
        }
      },
      { timeout: 20_000 },
    );
    // And the quiet box is not what a question gets.
    expect(
      document.querySelector(PLACEHOLDER),
      "a question on file was answered with the wordless placeholder",
    ).toBeNull();
  }, 60_000);

  it("run page — the operator's recovery affordance is untouched", async () => {
    const body = pausedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({ surface: "agent-detail", initialStatus: "pending_approval" })}
      />,
    );

    await waitFor(
      () => {
        if (!screen.queryByRole("button", { name: /Re-check/i })) {
          throw new Error("the run page lost its recovery affordance");
        }
      },
      { timeout: 20_000 },
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  }, 40_000);

  it("conversation — the placeholder gives way to the run's own rendering when nobody is reading any more", async () => {
    // THE BOUND. The quiet box is held while the slot's reader is still able to
    // look; a reader that has spent its budgets is not a wait, and holding a
    // spinner in front of one would be the spinner nothing can end that every
    // other reading on this page is written to avoid.
    //
    // SO THE WHOLE TRANSPORT IS DEAD HERE, not just the slot route: the panel's
    // own tick answers nothing either, which is what leaves the reader's failure
    // belt with no evidence to re-arm on. A tick that IS answering re-arms it,
    // and that is the case the reader's own suite pins — this is its other half.
    const body = pausedBody();
    a2aSnapshot.value = null;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) throw new Error("transport down");
      return new Response(JSON.stringify(RESOLVE_PENDING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    void body;
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel {...panelProps({ surface: "chat", initialStatus: "pending_approval" })} />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(
      () => {
        if (!screen.queryByText(/Run paused/i)) {
          throw new Error("the panel is still holding a placeholder nothing is reading for");
        }
      },
      { timeout: 30_000 },
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  }, 60_000);
});
