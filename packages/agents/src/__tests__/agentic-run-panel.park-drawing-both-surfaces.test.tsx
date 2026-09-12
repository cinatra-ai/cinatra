// @vitest-environment jsdom
/**
 * WHAT THE TWO SURFACES DRAW WHILE A RUN IS PARKED (cinatra#3007, fix leg 7).
 *
 * Leg 6 gave the quiet placeholder to the CONVERSATION only, and stated the
 * reason: the run page is the operator's own surface and its Re-check is a
 * shipped recovery reading. The sixth graded reading then took the run page during a
 * park and found all seven of the elements leg 6 had itself listed as the thing
 * it was removing, still drawn 600 s after the gate row existed:
 *
 *   "Agentic Run Progress", a "pending approval" status pill, "Run paused -
 *    awaiting human approval before continuing.", a pressable "Review approval",
 *    "Loading the approval step for this run...", a pressable "Re-check", and
 *    "No messages yet."
 *
 * Every control in that arm acts on an approval step that does not exist while
 * the pause has nothing to draw, so on the run page it was not a recovery
 * affordance either — it was the same dead arm on a second surface, with a
 * status pill naming a wait that is not the one the run is in.
 *
 * The same reading took the placeholder itself and found two more things on
 * every frame of both surfaces: "a large blank inner box and no run identity
 * anywhere in the card", and — on the pair shot after the decision had committed
 * — a spinner still turning over a run that had already finished.
 *
 * These cases pin all three, on BOTH hosts, against the real shared reader.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.park-drawing-both-surfaces.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
    runId: "run-3007-leg7",
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

const RUN_ID = "run-3007-leg7";
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
  ref: "lcr-leg7-park-gate",
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

/** Wait until the reader has answered at least `n` looks — the question phase
 *  spends exactly one, and it is the one that ended the looking. */
async function afterSlotLooks(slotLooks: number[], n: number): Promise<void> {
  await waitFor(
    () => {
      if (slotLooks.length < n) throw new Error("the slot has not been looked at yet");
    },
    { timeout: 20_000 },
  );
}


/** The seven elements the sixth graded reading counted on the untouched run page. */
function theSevenNoisyElements(): Record<string, boolean> {
  const body = document.body.textContent ?? "";
  const pressable = (re: RegExp) =>
    [...document.querySelectorAll("button, a")].some((e) =>
      re.test((e.textContent ?? "").trim()),
    );
  return {
    progressHeading: [...document.querySelectorAll("h2")].some((h) => /Agentic Run Progress/i.test(h.textContent ?? "")),
    pendingApprovalPill: /pending approval/i.test(body),
    pausedBanner: /Run paused/i.test(body),
    reviewApprovalControl: pressable(/Review approval/i),
    loadingApprovalStep: /Loading the approval step/i.test(body),
    recheckControl: pressable(/Re-?check/i),
    noMessagesYet: /No messages yet/i.test(body),
  };
}

/** The pause the park's own window really is: the run reports the parked status,
 *  the row carries NO interrupt (the person answered the question and the run
 *  moved past it), and the park has not been read off the row yet. */
function pauseWithNothingToDraw(): void {
  a2aSnapshot.value = {
    taskId: "task-3007",
    state: "input-required",
    cinatraStatus: "pending_approval",
    runId: RUN_ID,
    messages: [],
    hitlContext: null,
    error: null,
  };
}

describe("a pause with nothing to draw, on both surfaces", () => {
  it.each(SURFACES)(
    "%s — draws the quiet placeholder, and none of the seven noisy elements",
    async (_name, surface, wrap) => {
      pauseWithNothingToDraw();
      // AND THE ROW REPORTS THE PARK. This is the window the sixth graded reading
      // graded on an untouched run page, where it counted all seven of the
      // noisy elements 600 s after the gate row existed — on a page whose
      // reader had gone silent and could never learn about this answer. With
      // the reader able to come back, the answer lands and the arm is gone on
      // BOTH surfaces. A regression pin rather than a red-first one: the
      // drawing was already correct for a park the panel knows about, and what
      // this leg repairs is the page's ability to know about it, pinned at the
      // reader in `run-review-slot-park-ceiling.test.tsx`.
      const body = seedBody({ hitlContext: null, reviewGate: PARK_WITHOUT_GATE });
      const { slotLooks } = stubFetch(() => body);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(wrap(<AgenticRunPanel {...panelProps({ surface })} />));

      const placeholder = await waitFor(
        () => {
          const el = document.querySelector(PLACEHOLDER);
          if (!el) throw new Error("no placeholder");
          return el as HTMLElement;
        },
        { timeout: 25_000 },
      );
      await afterSlotLooks(slotLooks, 1);

      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "working",
      );
      // Section II: "the card frame, and a spinning icon ... It names no status,
      // reports no result and draws nothing to press."
      expect(placeholder.querySelectorAll("svg.animate-spin").length).toBe(1);
      expect(theSevenNoisyElements()).toEqual({
        progressHeading: false,
        pendingApprovalPill: false,
        pausedBanner: false,
        reviewApprovalControl: false,
        loadingApprovalStep: false,
        recheckControl: false,
        noMessagesYet: false,
      });
    },
    45_000,
  );

  it.each(SURFACES)(
    "%s — the placeholder names the run it is waiting on",
    async (_name, surface, wrap) => {
      // The graded reading's reading, verbatim: "a large blank inner box and no run
      // identity anywhere in the card; page title names the agent, not the run".
      pauseWithNothingToDraw();
      const body = seedBody({ hitlContext: null, reviewGate: PARK_WITHOUT_GATE });
      stubFetch(() => body);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(wrap(<AgenticRunPanel {...panelProps({ surface })} />));

      const placeholder = await waitFor(
        () => {
          const el = document.querySelector(PLACEHOLDER);
          if (!el) throw new Error("no placeholder");
          return el as HTMLElement;
        },
        { timeout: 25_000 },
      );
      // THE BOX NAMES ITS RUN THROUGH ITS ACCESSIBLE NAME, not through drawn
      // copy: the ratified drawing's placeholder is the card's own name over a
      // centred arc and nothing else, so the run reference the earlier reading
      // drew beside the arc is carried by the region's name and its own
      // attribute instead of by a span the drawing does not put there.
      const reference =
        placeholder.getAttribute("data-review-gate-placeholder-run")?.trim() ?? "";
      expect(reference, "the placeholder names no run").not.toBe("");
      expect(reference.length).toBeGreaterThan(0);
      expect(RUN_ID.startsWith(reference)).toBe(true);
      // A reference is not a status word, a result or a control — the three
      // things the drawing says this card draws none of.
      expect(placeholder.querySelectorAll("button, a").length).toBe(0);
    },
    45_000,
  );

});

describe("the wordless box itself", () => {
  it("names its run, and stops claiming something is coming once the wait is over", async () => {
    // The sixth graded reading's own readback for the two placeholder frames: "the run
    // already completed and the gate already resolved at the shutter, and a
    // spinner is still drawn at that instant — a spinner outliving the run it
    // reports on." A spinner is a claim that something is still being waited
    // for, so once the wait is over it is not a quieter drawing, it is a false
    // one. The frame stays; the spin goes.
    const { ReviewGatePlaceholder, shortRunReference } = await import(
      "../review-gate-states"
    );

    const waiting = render(
      <ReviewGatePlaceholder runRef={shortRunReference(RUN_ID)} settled={false} />,
    );
    const spinning = waiting.container.querySelector(PLACEHOLDER) as HTMLElement;
    expect(spinning.querySelectorAll("svg.animate-spin").length).toBe(1);
    expect(spinning.getAttribute("aria-busy")).toBe("true");
    const reference = spinning
      .getAttribute("data-review-gate-placeholder-run")
      ?.trim();
    expect(reference && RUN_ID.startsWith(reference)).toBe(true);
    const spinningLabel = spinning.getAttribute("aria-label") ?? "";
    cleanup();

    const settled = render(
      <ReviewGatePlaceholder runRef={shortRunReference(RUN_ID)} settled />,
    );
    const still = settled.container.querySelector(PLACEHOLDER) as HTMLElement;
    expect(still.querySelectorAll("svg.animate-spin").length).toBe(0);
    expect(still.getAttribute("aria-busy")).toBe("false");
    // The frame is still the box the review screen fills, and the run is still
    // named: the wait ended, the slot did not move and the box did not go blank.
    // The card is still the box the review screen fills — its own name is still
    // at its head — and the run is still named, through the region's own
    // attribute rather than through copy the ratified drawing does not draw.
    expect(still.textContent).toContain("Agentic Run Progress");
    expect(still.getAttribute("data-review-gate-placeholder-run")).not.toBeNull();
    // Still nothing to press, in either reading.
    expect(still.querySelectorAll("button, a").length).toBe(0);
    // AND THE NAME IS AVAILABLE TO A READER WHO CANNOT SEE IT (convergence).
    // The region carries an explicit accessible name, and an explicit name
    // REPLACES the text inside it — so a box that draws its run beside the arc
    // and names itself only "Working" hands a screen reader the one thing the
    // sighted reader gets and the blind reader does not.
    const shortRef = shortRunReference(RUN_ID) ?? "";
    expect(spinningLabel, "the waiting box names the run to the eye only").toContain(
      shortRef,
    );
    expect(
      still.getAttribute("aria-label") ?? "",
      "the finished box names the run to the eye only",
    ).toContain(shortRef);
  });

  it("keeps spinning while the panel's own reader may still bring a card", async () => {
    // THE SETTLED READING IS ABOUT THE WAIT, NOT ABOUT THE RUN (convergence).
    // The panel draws this box on a COMPLETED run too: the run finished, the
    // gate row has not landed yet, and `reviewMayStillOpen` is the whole reason
    // the working slot is on the screen at all. Reading "settled" off the run's
    // terminal status alone therefore stopped the spin and announced the wait
    // finished at the exact moment the reader was still looking for the card —
    // the opposite error to the one the sixth graded reading found, on the same box.
    streamState.status = "completed";
    a2aSnapshot.value = {
      taskId: "task-3007",
      state: "completed",
      cinatraStatus: "completed",
      runId: RUN_ID,
      messages: [],
      hitlContext: null,
      error: null,
    };
    const body = seedBody({
      status: "completed",
      hitlContext: null,
      // The settle window: the run is done and the row says a review is awaited,
      // but no gate ref has been written yet.
      reviewGate: { ref: null, awaiting: true, producedReviewPark: false },
    });
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "completed",
          // The mount is handed the row own reading: a review is awaited and no
          // gate ref exists yet. That is what puts the working slot on the
          // screen for a finished run, and it is the reading the box is for.
          initialReviewGate: { ref: null, awaiting: true, producedReviewPark: false },
        })}
      />,
    );

    const placeholder = await waitFor(
      () => {
        const el = document.querySelector(PLACEHOLDER);
        if (!el) throw new Error("no placeholder");
        return el as HTMLElement;
      },
      { timeout: 25_000 },
    );
    expect(
      placeholder.querySelectorAll("svg.animate-spin").length,
      "the box stopped claiming a card was coming while its reader was still looking for one",
    ).toBe(1);
    expect(placeholder.getAttribute("aria-busy")).toBe("true");
    expect(placeholder.hasAttribute("data-review-gate-placeholder-settled")).toBe(false);
  }, 45_000);

  it("draws exactly what it drew before when it is given no run and no verdict", async () => {
    // The callers that have nothing to name — the instance screen's generic
    // wait — must be byte-unchanged by this leg.
    const { ReviewGatePlaceholder } = await import("../review-gate-states");
    const { container } = render(<ReviewGatePlaceholder />);
    const el = container.querySelector(PLACEHOLDER) as HTMLElement;
    expect(el.querySelectorAll("svg.animate-spin").length).toBe(1);
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(
      el.querySelector('[data-conformance-id="review-gate-placeholder-run-ref"]'),
    ).toBeNull();
    expect(el.hasAttribute("data-review-gate-placeholder-settled")).toBe(false);
  });
});
