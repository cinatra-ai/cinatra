// @vitest-environment jsdom
/**
 * THE REVIEW CARD IN A CHAT THREAD NAMES THE CHAT AS ITS HOST (cinatra#3484).
 *
 * THE DRAWING'S OWN SENTENCE, read at `specs/app-lifecycle-cards.html` §IX:
 * "Four hosts, one card set. The chat thread drawn throughout this page, the
 * embedded site widget, the run card, and the page gate region. Every card
 * appears on every host, and it is the same card wherever it appears … Only the
 * frame changes — the thread, the widget's panel, the run card's detail column,
 * the gate region of the review page."
 *
 * THE DEFECT cinatra#3484 names: the review card drawn inside the assistant
 * conversation declared `data-lifecycle-card-host="run_card"` — the only host
 * declaration on the conversation page — because this panel's review slot
 * mounted the card under an UNCONDITIONAL literal `run_card` declaration, and
 * the inline run panel is drawn INSIDE the thread's transcript. A reader meets
 * that card between the turn's prose and the thread's composer, so the frame it
 * is in is the thread; the declaration said otherwise, and the repository's own
 * capture recorder (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`) refuses
 * a chat_thread cell whose card root does not carry
 * `data-lifecycle-card-host="chat_thread"`.
 *
 * THE TWO ARMS, and the second is as load-bearing as the first:
 *
 *   1. UNDER A CONVERSATION DECLARATION the card root publishes `chat_thread`,
 *      with its own `data-lifecycle-card-state` on that SAME element — one
 *      element carries both, which is what the recorder reads.
 *      The count is read here rather than in the chat package because the
 *      chat tier cannot load this panel's graph: its vitest config aliases only
 *      the bare `@cinatra-ai/agents` specifier, so the deep subpath imports the
 *      panel's server graph makes resolve to `…/src/index.ts/<sub>` and fail.
 *      Every chat suite that touches the inline run card mocks it for that
 *      reason, and a stand-in proves nothing about this declaration.
 *   2. WITH NO CONVERSATION DECLARATION IN SCOPE — the run page — the slot still
 *      publishes `run_card`. This arm is green before and after: it pins what
 *      this change must not move.
 *
 * The site widget is NOT widened here and is not touched: `run_card` is a
 * cookie-session host and a `site_widget` declaration minted without an `auth`
 * prop is refused by the runtime's fail-closed credential rule, which would draw
 * no card DOM at all. The widget's marked-gate mount keeps what it has.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/chat-hosted-review-card-names-the-chat-host-3484.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

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
    runId: "run-3484",
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

// The gate's stored exchange is a server action; the run_card mount's window
// reads it as soon as that card draws.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
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

// No live stream: what is read here is what the run's own STATE makes the panel
// draw, and a stream would supply a status of its own.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3484";
const REVIEW_REF = "lcr-opaque-3484";
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

/** The answer the core's own suites use for an OPEN gate the reader may decide. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The run the panel reads: FINISHED, with its output's review still owed. */
function seedBody() {
  return {
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: REVIEW_REF, awaiting: false },
  };
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(seedBody()), {
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

function panelProps() {
  return {
    runId: RUN_ID,
    initialStatus: "completed",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    templateId: "tmpl-3484",
    surface: "chat" as "agent-detail" | "chat",
    initialReviewGate: { ref: REVIEW_REF, awaiting: false },
  };
}

/** The card root — the ONE element the recorder reads host and state off. */
async function cardRoot(): Promise<Element> {
  return waitFor(
    () => {
      const el = document.querySelector(REVIEW_CARD);
      if (!el) throw new Error("the review screen did not arrive");
      return el;
    },
    { timeout: 10_000 },
  );
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
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
  vi.useRealTimers();
});

describe("cinatra#3484 — the card in the thread names its own host", () => {
  it("under a conversation declaration the card root publishes chat_thread, with its state on the same element", async () => {
    stubFetch();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel {...panelProps()} />
      </LifecycleCardSurfaceProvider>,
    );

    const card = await cardRoot();

    // C7 — read off the card's OWN root, never off an ancestor.
    expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    // C8 — the state is on that same element, so the recorder reads both from
    // one node rather than from a pair it has to correlate. It is pinned to the
    // reading the seeded gate RESOLVES to, never merely to "non-empty": a
    // loading or error reading is also non-empty, and would let this arm pass
    // for a card that never reached its decidable state.
    await waitFor(() =>
      expect(card.getAttribute("data-lifecycle-card-state")).toBe(
        RESOLVE_PENDING.state.state,
      ),
    );

    // ONE review card in the container, so "the card" above is the only card
    // there is and the ancestor reading below cannot be satisfied by a second
    // one drawn elsewhere in the panel.
    expect(container.querySelectorAll(REVIEW_CARD)).toHaveLength(1);

    // THE DRAWN CONSEQUENCE OF THE INHERITED HOST, recorded here because the
    // picture round will meet it: `HOST_FRAME` in `review-gate-card.tsx` gives
    // the thread's frame its own vertical margin (`my-3`) where the run card's
    // frame has none. The host declaration is not only an attribute a recorder
    // reads — it also picks the frame the reader sees.
    expect(card.classList.contains("my-3")).toBe(true);

    // …and exactly ONE host declaration governs that card — the conversation's,
    // and it IS the card's own root. This is the recorder's predicate for a
    // chat_thread cell: no nested declaration stands between the thread and the
    // card a reader meets between the turn's prose and the composer.
    const governing = [...container.querySelectorAll("[data-lifecycle-card-host]")].filter(
      (el) => el === card || el.contains(card),
    );
    expect(governing).toHaveLength(1);
    expect(governing[0]).toBe(card);
    expect(card.closest('[data-lifecycle-card-host="run_card"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-lifecycle-card-host="run_card"]'),
    ).toHaveLength(0);
  }, 15_000);

  it("with NO conversation declaration in scope the run page keeps run_card", async () => {
    // C9 — the run page has no ambient host at all, and its review slot must go
    // on declaring the run card. Green before this change and green after.
    stubFetch();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel {...panelProps()} surface="agent-detail" />);

    const card = await cardRoot();

    expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    await waitFor(() =>
      expect(card.getAttribute("data-lifecycle-card-state")).toBe(
        RESOLVE_PENDING.state.state,
      ),
    );
    expect(document.querySelectorAll(REVIEW_CARD)).toHaveLength(1);
    // The run card's frame carries no margin of its own — the other half of
    // the frame reading above, pinned so neither host inherits the other's.
    expect(card.classList.contains("my-3")).toBe(false);
  }, 15_000);
});
