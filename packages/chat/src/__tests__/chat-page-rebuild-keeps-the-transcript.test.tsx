// @vitest-environment jsdom
/**
 * A REBUILT CHAT PAGE STILL SHOWS THE CONVERSATION (cinatra#3007, fix leg 10).
 *
 * THE FAILURE THIS PINS, READ OFF THE GATE'S OWN ARTIFACTS. The held-turn gate
 * files a photograph and then asks the DOM, without waiting, whether the picture
 * it filed contains what the record claims. It refused one: the conversation list
 * was attached with NOTHING painted inside it, and the settled recommendation row
 * — asserted on its own root a fraction of a second earlier, by two independent
 * readers — was not in the document at all. The photograph agrees: an empty chat,
 * no turns, the breadcrumb back to its bare form.
 *
 * WHAT HAPPENED BETWEEN THE TWO INSTANTS. The page's whole subtree was TORN DOWN
 * AND REBUILT: the trace shows its in-flight reads aborted and a fresh mount
 * re-issuing them, and the freshly mounted inline run panel back on its
 * first-paint placeholder. A rebuilt `ChatPage` starts with an EMPTY message
 * list and fills it from the thread read; a rebuilt recommendation card starts
 * with no answer and fills it from the hold read. Under the load this gate runs
 * at, those reads are not fast — the failing run measured one of them at twelve
 * seconds. For that whole gap the conversation is simply not on screen.
 *
 * Nothing failed and nothing was denied. The transcript was absent, and a record
 * of an absent transcript is exactly what a photograph must refuse.
 *
 * So this file drives the rebuild deliberately, with BOTH reads parked, and
 * requires the page to redraw what it already had — the turns, and the settled
 * card at the turn's own slot — before either read lands. The reads still land
 * and still win; what is measured is the gap.
 *
 * Run:
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/chat-page-rebuild-keeps-the-transcript.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

// --- the modules a mounted page reaches that belong to the SERVER ------------
// Replaced exactly as the sibling mounted-page suites in this directory replace
// them, and for the same reason: their graphs reach the server runtime, so
// without these the lazy list chunk never evaluates and nothing mounts at all.

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../actions", () => ({
  resolveMessageRouting: vi.fn(async () => ({ shouldCallLlm: true })),
  setAssistantPauseState: vi.fn(async () => undefined),
  extractHitlGateValuesAction: vi.fn(async () => ({})),
}));

type HoldState = Record<string, unknown>;

/**
 * The card's own authority. `parked` is the twelve-second read with the clock
 * removed: the promise is simply never settled while an arm measures the gap.
 */
const hold = vi.hoisted(() => ({
  answer: { state: "none" } as HoldState,
  parked: false,
  calls: 0,
}));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (_input: unknown) => {
    hold.calls += 1;
    if (hold.parked) return new Promise<HoldState>(() => {});
    return Promise.resolve(hold.answer);
  },
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The inline run panel is the OTHER host and draws its own copy of this card.
// Silenced so every count below is the TRANSCRIPT's card and nothing else.
vi.mock("../inline-agent-run-card", () => ({ InlineAgentRunCard: () => null }));

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repair it
// only when it is actually broken.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const THREAD_ID = "thr-3007-rebuild";
const RUN_ID = "0f0f4a25-6a0d-4c60-9d3a-2f1a1b1c9d20";
const PACKAGE = "@cinatra-ai/lint-policy-agent";
const TURN_TEXT = "run cinatra_lint-policy-agent for me";

const SUMMARY = {
  id: THREAD_ID,
  title: "Held turn",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/** The turn a parked chat dispatch really produces: one `agent_run` call with the
 *  server-pinned run id, and the dispatch line beside it. */
const BODY = {
  ...SUMMARY,
  messages: [
    { id: "u1", role: "user", content: TURN_TEXT },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "pending_input" }),
        },
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_input\`). The run paused for a decision on the recommended skills.`,
        },
      ],
    },
  ],
};

const SKIPPED: HoldState = {
  state: "skipped",
  decided: [{ skillId: "@cinatra-ai/chat:blog-content", name: "Blog Content Skill", mark: "skipped" }],
};

const CONVERSATION_LIST = "[data-conversation-list]";
const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const CARD_HOST_CHAT = '[data-lifecycle-card-host="chat_thread"]';
const CARD_DECIDED = '[data-lifecycle-card-state="decided"]';

/** The `/chat` network. `parked` holds the thread read open, exactly as a
 *  contended runtime holds it open, so an arm can measure the gap it opens. */
const net = { threadReadParked: false, threadReads: 0 };

function installNetwork() {
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/assistants/threads" && init?.method === "POST") return new Response("{}");
    if (u === "/api/assistants/threads") return new Response(JSON.stringify([SUMMARY]));
    if (u === `/api/assistants/threads/${THREAD_ID}`) {
      net.threadReads += 1;
      if (net.threadReadParked) return new Promise<Response>(() => {});
      return new Response(JSON.stringify(BODY));
    }
    // Any OTHER thread id is a thread this page has never had: the route answers
    // `null`, which is what the negative control below opens on.
    if (u.startsWith("/api/assistants/threads/")) {
      if (net.threadReadParked) return new Promise<Response>(() => {});
      return new Response(JSON.stringify(null));
    }
    if (u === "/api/assistants/list") return new Response(JSON.stringify([]));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchStub);
}

async function mountPage() {
  const { ChatPage } = await import("../chat-page");
  return render(<ChatPage initialThreadId={THREAD_ID} userId="u-1" />);
}

/** Let every already-resolved microtask land, without advancing any clock. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

beforeEach(async () => {
  const { forgetRememberedTranscripts } = await import("../thread-activity");
  const { forgetAuthorizedRecommendationAnswers } = await import(
    "@cinatra-ai/agents/run-recommendation-card"
  );
  forgetRememberedTranscripts();
  forgetAuthorizedRecommendationAnswers();
  hold.answer = SKIPPED;
  hold.parked = false;
  hold.calls = 0;
  net.threadReadParked = false;
  net.threadReads = 0;
  installNetwork();
});

afterEach(async () => {
  cleanup();
  const { forgetRememberedTranscripts } = await import("../thread-activity");
  const { forgetAuthorizedRecommendationAnswers } = await import(
    "@cinatra-ai/agents/run-recommendation-card"
  );
  forgetRememberedTranscripts();
  forgetAuthorizedRecommendationAnswers();
  vi.unstubAllGlobals();
});

describe("a rebuilt chat page redraws the conversation (cinatra#3007, fix leg 10)", () => {
  it("keeps the turns AND the settled card on screen while both reads are still open", async () => {
    const first = await mountPage();
    await waitFor(
      () => expect(first.container.querySelector(CONVERSATION_LIST)).not.toBeNull(),
      { timeout: 15_000 },
    );
    await waitFor(() => expect(first.getByText(TURN_TEXT)).toBeTruthy(), { timeout: 15_000 });
    await waitFor(
      () =>
        expect(
          first.container.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
        ).toHaveLength(1),
      { timeout: 15_000 },
    );

    // THE REBUILD, with both reads held open. This is the instant the gate's
    // recorder photographed: the subtree is gone, a new one is built, and
    // neither the thread nor the hold answer is back yet.
    first.unmount();
    net.threadReadParked = true;
    hold.parked = true;
    const readsBefore = net.threadReads;

    const rebuilt = await mountPage();
    await flush();

    expect(
      rebuilt.container.querySelector(CONVERSATION_LIST),
      "the rebuilt page draws a conversation list",
    ).not.toBeNull();
    expect(
      rebuilt.container.textContent,
      "the turns the page already had are still on screen",
    ).toContain(TURN_TEXT);
    expect(
      rebuilt.container.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "and the settled row is still at its own slot in the transcript",
    ).toHaveLength(1);
    // Both reads really are still open — otherwise this arm would be measuring a
    // fast runtime rather than the gap the gate photographed.
    expect(net.threadReads, "the rebuilt page did ask for the thread again").toBeGreaterThan(
      readsBefore,
    );
    expect(hold.calls, "and the rebuilt card did ask the authority again").toBeGreaterThan(0);
  });

  it("still draws an empty conversation for a thread this page has never had", async () => {
    // The negative control: nothing is invented. A page opened cold on a thread
    // whose read has not landed shows no turns, exactly as it always has.
    net.threadReadParked = true;
    hold.parked = true;
    const { ChatPage } = await import("../chat-page");
    const view = render(<ChatPage initialThreadId="thr-3007-never-seen" userId="u-1" />);
    await flush();
    expect(view.container.textContent).not.toContain(TURN_TEXT);
    expect(view.container.querySelectorAll(CARD_ROOT)).toHaveLength(0);
  });
});
