// @vitest-environment jsdom
/**
 * THE CARD STAYS, AND THE ARC STOPS WHEN THE RUN DOES (cinatra#3007, fix leg 9).
 *
 * Two of the eighth graded reading's measurements, on the surface each was taken on.
 *
 * ONE — THE ARRIVAL IS UNSTABLE. Counting one-second polls AFTER the review card
 * first landed on an untouched conversation, the card LEFT the thread and
 * returned 59 times in one palette and 49 in the other over 885 s, up to 18.3 s
 * absent at a stretch, on a page with zero navigations and nothing pressed. The
 * route that feeds the card is fail-soft by design — a slot read that throws is
 * served as "no review here" beside a row that is still parked — and the reader
 * wrote each of those over the answer it had already delivered.
 *
 * TWO — THE PLACEHOLDER'S SPINNER DOES NOT STOP AT SETTLE. On three untouched
 * surfaces at the instant the run's own row read `completed`, the placeholder
 * was still spinning with no settled reading on it. The box was held by
 * `mayStillOpen`, which is mostly a GUESS with a budget on it — "this surface
 * has not heard back yet under the current status" — and the guess outlives the
 * fact by however many looks are left in it.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.card-stays-and-settles.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3007-stays",
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

const RUN_ID = "run-3007-stays";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

function stubFetch(run: () => Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
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
  return fetchMock;
}

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
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
    surface: "chat" as "agent-detail" | "chat",
    initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    ...over,
  };
}

function mount(node: React.ReactNode) {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>,
  );
}

/** Watch the surface the way the reading watched it: once a second, counting
 *  the polls in which the card is not there. */
async function countAbsences(
  container: HTMLElement,
  selector: string,
  polls: number,
): Promise<number> {
  let absent = 0;
  for (let i = 0; i < polls; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!container.querySelector(selector)) absent += 1;
  }
  return absent;
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
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

describe("the review card the conversation was given stays there", () => {
  it("does not leave the untouched thread when the slot route fail-softs", async () => {
    const PARKED = {
      status: "pending_approval",
      hitlContext: null,
      reviewGate: {
        ref: "lcr-stays-conversation-gate",
        awaiting: false,
        producedReviewPark: true,
      },
    };
    // The fail-soft this route serves when it cannot read the slot, AS IT
    // SERVES IT (convergence): the gate facts come back empty, and the park —
    // read off the run's own row rather than off the slot read that threw —
    // comes back true beside them. Serving three empties here would have been a
    // stand-in, and it is the shape of this answer that the rule turns on.
    const FAIL_SOFT = {
      status: "pending_approval",
      hitlContext: null,
      reviewGate: { ref: null, awaiting: false, producedReviewPark: true },
    };
    let body: Record<string, unknown> = seedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = mount(<AgenticRunPanel {...panelProps()} />);

    body = seedBody(PARKED);
    await waitFor(
      () => {
        if (!container.querySelector(REVIEW_CARD)) {
          throw new Error("the review card never arrived at all");
        }
      },
      { timeout: 25_000 },
    );

    // From here the route stumbles on every other read, which is the shape the
    // reading counted: 205 of 789 polls with no card in them.
    let flip = false;
    body = seedBody(FAIL_SOFT);
    const flipper = setInterval(() => {
      flip = !flip;
      body = seedBody(flip ? FAIL_SOFT : PARKED);
    }, 1500);
    try {
      const absent = await countAbsences(container, REVIEW_CARD, 20);
      expect(
        absent,
        "the review card left the untouched thread while the row still said parked",
      ).toBe(0);
    } finally {
      clearInterval(flipper);
    }
  }, 90_000);

  it("stops the placeholder's arc in the same reading the run's row goes terminal", async () => {
    // The run is working, so the box the review would fill is up and spinning.
    // Then the run finishes with NO review of its own — and from that instant
    // the arc is a claim about a run that has stopped.
    //
    // AND THE BOX IS STILL HELD while this is measured, which is the whole
    // point: the reading that holds it is a guess with a budget on it, and the
    // three surfaces the eighth graded reading photographed were inside exactly that
    // budget with the row already terminal. So the slot READER's look is left
    // open here — the two are told apart by the abort signal only the reader
    // sends — while the surface's own tick keeps answering.
    let body: Record<string, unknown> = seedBody();
    let holdTheSlotRead = false;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        if (holdTheSlotRead && init?.signal) {
          await new Promise<void>((resolve) => {
            init.signal!.addEventListener("abort", () => resolve());
          });
          throw new Error("aborted");
        }
        return new Response(JSON.stringify(body), {
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
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = mount(<AgenticRunPanel {...panelProps()} />);

    await waitFor(
      () => {
        if (!container.querySelector(PLACEHOLDER)) {
          throw new Error("the working run never drew its box at all");
        }
      },
      { timeout: 15_000 },
    );

    // The row goes terminal, and the slot reader's own look is left open.
    holdTheSlotRead = true;
    streamState.status = "completed";
    body = seedBody({ status: "completed" });

    // The surface has to have SEEN it before anything is asserted about it.
    await waitFor(
      () => {
        const el = container.querySelector(PLACEHOLDER);
        if (!el) throw new Error("the box was dropped instead of settling");
        if (el.getAttribute("aria-busy") === null) {
          throw new Error("the placeholder is not reporting either way yet");
        }
        if (el.getAttribute("data-review-gate-placeholder-settled") !== "true") {
          throw new Error(
            "the placeholder is held up on a finished run without saying the wait is over",
          );
        }
      },
      { timeout: 15_000 },
    );

    // AND IT STAYS SETTLED for as long as the box is held: no frame in which
    // the arc comes back on a run whose own row reads completed.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const placeholder = container.querySelector(PLACEHOLDER);
      if (!placeholder) continue;
      expect(
        placeholder.querySelectorAll("svg.animate-spin").length,
        "the placeholder is still spinning on a run whose own row reads completed",
      ).toBe(0);
      expect(placeholder.getAttribute("aria-busy")).toBe("false");
    }
  }, 90_000);
});
