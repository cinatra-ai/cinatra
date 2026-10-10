// @vitest-environment jsdom
/**
 * THE SKILLS CARD KEEPS ITS TURN THROUGH THE ALL-CLEAR ANSWER (cinatra#3062).
 *
 * §V: "A row the reader did see keeps its place in the turn and states, box by
 * box, that no recommended skill was applied", and "clearing every box and
 * pressing Continue is an ordinary answer to the same question".
 *
 * WHAT A LIVE BOOT MEASURED. One run dispatched from the chat composer, its one
 * offered skill not recommended, so its box opened clear; the one Continue with
 * every box clear; the decision answered; the card's live answer read decided
 * (skipped). 163 ms after that answer the card's node left the page — under a
 * subtree ABOVE the turn's run slot — and came back 2.5 s later, 23 ms after the
 * conversation's own thread read answered. No read of the conversation's
 * messages came between the answer and the removal; two thread reads left 2 ms
 * apart right after it and the thread poll took a new phase: the signature of
 * the conversation's OWNER mounted afresh. The application router does exactly
 * that when it applies a server action's answer rendered at the thread's own
 * path while the page was mounted at the assistant's base path (the thread URL
 * was pushed by the page itself), because the /chat route's catch-all segment
 * then carries a different value.
 *
 * So this tape mounts the OWNER — the real `ChatPage`, its empty first state,
 * its thread load and its poll — with the thread read, the card's answers, the
 * decision and the run-row reads supplied at their transports by the test, and
 * plays the router's part in the one place it acts: a fresh mount of the page
 * right after the card's answer, whose own thread read answers 2.5 s later.
 * A MutationObserver walk then asserts the card at EVERY commit.
 */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const THREAD_ID = "7a3c9e21-4b6d-4f80-9a12-3062a11c1ea5";
const RUN_ID = "3062c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6e";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const SKILL_ID = "@cinatra-ai/blog-writing-skill:blog-writing";

/** The run row, the park, the decision and the thread read, as the tape drives them. */
const tape = vi.hoisted(() => ({
  status: "pending_input" as string,
  startedAt: null as string | null,
  /** The one box: `true` opens it checked (a recommended skill). */
  keep: false,
  /** The park: `held` until the release, then the decided answer. */
  released: false,
  decision: null as null | { promise: Promise<unknown>; land: (r: unknown) => void },
  decisions: 0,
  /** The card's live answers, in their order, by state word. */
  answers: [] as string[],
  /** How long the NEXT thread read takes to come home. */
  threadDelayMs: 0,
  threadReads: 0,
  /** The thread reads counted when the card's live answer first read decided. */
  readsAtTheDecidedAnswer: null as number | null,
}));

function candidate() {
  return {
    skillId: SKILL_ID,
    skillRevisionId: "blog-writing@0.2.0",
    name: "Blog writing",
    vendorName: "Cinatra",
    recommended: tape.keep,
  };
}

function heldState() {
  return {
    state: "held",
    runId: RUN_ID,
    agentPackageName: PACKAGE,
    promptText: "{}",
    holdRef: "hold-ref-3062-all-clear",
    canDecide: true,
    recommendations: [{ ...candidate(), score: 0.2, rank: 1, scoredFeatures: [] }],
  };
}

/** The settled step: `runStarted` is the run ROW's own stamp. */
function decidedState() {
  const settled = {
    runId: RUN_ID,
    holdRef: "hold-ref-3062-all-clear",
    canDecide: true,
    runStarted: tape.startedAt !== null,
    candidates: [candidate()],
  };
  return tape.keep
    ? {
        ...settled,
        state: "confirmed",
        skillNames: ["Blog writing"],
        decided: [{ skillId: SKILL_ID, name: "Blog writing", mark: "confirmed" }],
      }
    : {
        ...settled,
        state: "skipped",
        decided: [{ skillId: SKILL_ID, name: "Blog writing", mark: "skipped" }],
      };
}

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
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    const answer = tape.released ? decidedState() : heldState();
    if (tape.released && tape.readsAtTheDecidedAnswer === null) tape.readsAtTheDecidedAnswer = tape.threadReads;
    tape.answers.push(answer.state);
    return answer;
  },
  confirmRunRecommendationAction: async () => {
    tape.decisions += 1;
    return tape.decision!.promise;
  },
  skipRunRecommendationAction: async () => {
    tape.decisions += 1;
    return tape.decision!.promise;
  },
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => ({ state: "none" }),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getSkillsForAgentAction: async () => [],
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
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-testid="inline-run-panel" data-run-id={runId} />
  ),
}));

import { resetDrawnRecommendationReadings } from "../../../agents/src/run-recommendation-reading-register";
import { useHeldChatTranscript } from "../chat-client-url";

/** The two messages every thread read carried: the prompt and the dispatch turn. */
function threadMessages() {
  return [
    { id: "u1-3062", role: "user", content: "Run the blog draft writer agent for me." },
    {
      id: "a1-3062",
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
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_input\`).`,
        },
      ],
    },
  ];
}

const SUMMARY = {
  id: THREAD_ID,
  title: "Run the blog draft writer agent for me.",
  createdAt: "2026-09-28T14:00:14.000Z",
  updatedAt: "2026-09-28T14:00:14.000Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The page's own transports: the thread list, the thread read, the saves, the run row. */
function installNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/assistants/threads") {
      return init?.method === "POST" ? json({ ok: true }) : json([SUMMARY]);
    }
    if (url.startsWith("/api/assistants/threads/")) {
      tape.threadReads += 1;
      const delay = tape.threadDelayMs;
      tape.threadDelayMs = 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return json({ ...SUMMARY, messages: threadMessages() });
    }
    if (url.startsWith("/api/agents/runs/")) {
      return json({ status: tape.status, startedAt: tape.startedAt });
    }
    if (url.startsWith("/api/assistants/list")) return json([]);
    if (url.startsWith("/api/chat/pending-tool-calls")) return json({ rows: [] });
    if (url.startsWith("/api/chat/undo-candidate")) return json({ changeSetId: null });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const CARD = '[data-lifecycle-card="recommendation_hold"]';
const cardsIn = (c: HTMLElement) => c.querySelectorAll<HTMLElement>(CARD).length;
const cardOf = (c: HTMLElement) => c.querySelector<HTMLElement>(CARD);
const continuesOf = (c: HTMLElement) =>
  Array.from(cardOf(c)?.querySelectorAll<HTMLButtonElement>("[data-skills-step-continue]") ?? []);
const boxOf = (c: HTMLElement) => cardOf(c)?.querySelector<HTMLElement>("[data-skills-step-checkbox]") ?? null;
const editableOf = (c: HTMLElement) => cardOf(c)?.getAttribute("data-skills-step-editable") ?? null;
const stateOf = (c: HTMLElement) => cardOf(c)?.getAttribute("data-lifecycle-card-state") ?? null;

async function advance(ms: number, step = 100) {
  for (let t = 0; t < ms; t += step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

async function advanceUntil(done: () => boolean, limitMs: number, step = 100): Promise<number> {
  let elapsed = 0;
  while (!done() && elapsed < limitMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    elapsed += step;
  }
  return elapsed;
}

let restoreNetwork: (() => void) | null = null;

beforeAll(async () => {
  await import("../chat-messages-view");
  await import("../chat-page");
});

beforeEach(() => {
  tape.status = "pending_input";
  tape.startedAt = null;
  tape.keep = false;
  tape.released = false;
  tape.decisions = 0;
  tape.answers = [];
  tape.threadDelayMs = 0;
  tape.threadReads = 0;
  tape.readsAtTheDecidedAnswer = null;
  let land!: (r: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    land = r;
  });
  tape.decision = { promise, land };
  resetDrawnRecommendationReadings();
  restoreNetwork = installNetwork();
});
afterEach(() => {
  cleanup();
  restoreNetwork?.();
  restoreNetwork = null;
  resetDrawnRecommendationReadings();
  vi.useRealTimers();
});
afterAll(() => {
  vi.resetModules();
});

/**
 * The measured sequence, for either box state: the held card; the one Continue;
 * the decision answering; the card's live answer decided; then — with no read of
 * the conversation's messages between — the owner mounted afresh, its own thread
 * read answering 2.5 s later; the walk runs 40 s from the press.
 */
async function runTheTape(keep: boolean) {
  tape.keep = keep;
  vi.useFakeTimers();
  const { ChatPage } = await import("../chat-page");
  const { container, rerender } = render(
    <ChatPage key="mount-before-the-answer" initialThreadId={THREAD_ID} userId="u-3062" />,
  );
  await advanceUntil(() => continuesOf(container).length === 1, 20_000);
  expect(stateOf(container)).toBe("held");
  expect(editableOf(container)).toBe("true");
  expect(boxOf(container)?.getAttribute("aria-checked")).toBe(keep ? "true" : "false");

  const frames: Array<{ at: number; cards: number; editable: string | null; continues: number; state: string | null }> = [];
  let clock = 0;
  // The runner's faked clock: each frame's time from the one Continue.
  const pressedAt = Date.now();
  const observer = new MutationObserver(() =>
    frames.push({
      at: Date.now() - pressedAt,
      cards: cardsIn(container),
      editable: editableOf(container),
      continues: continuesOf(container).length,
      state: stateOf(container),
    }),
  );
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });

  // THE ONE CONTINUE, with the box as it stands.
  fireEvent.click(continuesOf(container)[0]!);
  await advance(200);
  clock += 200;
  expect(tape.decisions).toBe(1);
  await advance(4_000);
  clock += 4_000;

  // THE DECISION ANSWERS; the card's own live answer then reads decided.
  tape.released = true;
  await act(async () => {
    tape.decision!.land({ ok: true, dispatched: true });
    await Promise.resolve();
  });
  clock += await advanceUntil(() => stateOf(container) === "decided", 15_000, 50);
  expect(stateOf(container)).toBe("decided");
  expect(tape.answers.at(-1)).toBe(keep ? "confirmed" : "skipped");
  // No read of the conversation's messages between the answer and the mount.
  expect(tape.threadReads).toBe(tape.readsAtTheDecidedAnswer);

  // THE OWNER MOUNTED AFRESH, its own thread read answering about 2.5 s later.
  const readsBefore = tape.threadReads;
  tape.threadDelayMs = 2_450;
  rerender(<ChatPage key="mount-after-the-answer" initialThreadId={THREAD_ID} userId="u-3062" />);
  const remountedAt = Date.now() - pressedAt;
  while (clock < 40_000) {
    await advance(250, 50);
    clock += 250;
  }
  observer.disconnect();

  return { container, frames, remountedAt, freshReads: tape.threadReads - readsBefore };
}

describe("the skills card in the chat keeps its turn while its answer settles", () => {
  it("every box clear: exactly one card at every commit from the one Continue to 40 s after it", async () => {
    const { container, frames, freshReads } = await runTheTape(false);
    expect(freshReads).toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(0);
    // THE NODE-PRESENT ASSERTION.
    expect(frames.filter((f) => f.cards !== 1)).toEqual([]);
    // The run row carries no start stamp: editable, with one Continue.
    expect(frames.filter((f) => !(f.editable === "true" && f.continues === 1))).toEqual([]);
    expect(cardsIn(container)).toBe(1);
    expect(tape.decisions).toBe(1);
  }, 180_000);

  // §V: "While the question is open the boxes take a change and Continue stands
  // beneath them. Continue does not close the row."
  it("the one box checked: the same, exactly as a decided row with a box checked stays", async () => {
    const { container, frames, freshReads } = await runTheTape(true);
    expect(freshReads).toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((f) => f.cards !== 1)).toEqual([]);
    expect(frames.filter((f) => !(f.editable === "true" && f.continues === 1))).toEqual([]);
    expect(cardsIn(container)).toBe(1);
    expect(tape.decisions).toBe(1);
  }, 180_000);
});

// The hold's fences, read on the hook the page calls: the slot is published only
// for the thread the page has loaded, a fresh mount's hold serves only the
// viewer and thread it was read for, and it ends when the page's own first
// read settles. No fence may put one viewer's or one thread's transcript
// under another.
describe("the held transcript stays with its own viewer and thread", () => {
  const HELD = [{ id: "h1-3062" }, { id: "h2-3062" }];
  const OTHER = [{ id: "o1-3062" }];
  const NONE: { id: string }[] = [];

  it("a list carried over from the thread being left is not held under the thread being opened", () => {
    const loaded = { current: "thread-a" as string | null };
    const page = renderHook(
      ({ active, list }: { active: string; list: { id: string }[] }) =>
        useHeldChatTranscript("u-3062", active, "thread-a", list, loaded),
      { initialProps: { active: "thread-a", list: HELD } },
    );
    const freshA = renderHook(() => useHeldChatTranscript("u-3062", "thread-a", "thread-a", NONE, { current: "thread-a" }));
    expect(freshA.result.current.shownMessages).toBe(HELD);
    freshA.unmount();
    page.rerender({ active: "thread-b", list: HELD });
    const freshB = renderHook(() => useHeldChatTranscript("u-3062", "thread-b", "thread-b", NONE, { current: "thread-b" }));
    expect(freshB.result.current.shownMessages).toEqual([]);
    freshB.unmount();
    loaded.current = "thread-b";
    page.rerender({ active: "thread-b", list: OTHER });
    const freshB2 = renderHook(() => useHeldChatTranscript("u-3062", "thread-b", "thread-b", NONE, { current: "thread-b" }));
    expect(freshB2.result.current.shownMessages).toBe(OTHER);
  });

  it("a hold serves only its own viewer, ends at the page's own first read and is gone after the page unmounts", () => {
    const page = renderHook(() => useHeldChatTranscript("u-3062", "thread-a", "thread-a", HELD, { current: "thread-a" }));
    const other = renderHook(() => useHeldChatTranscript("u-other", "thread-a", "thread-a", NONE, { current: "thread-a" }));
    expect(other.result.current.shownMessages).toEqual([]);
    const fresh = renderHook(
      ({ viewer }: { viewer: string }) => useHeldChatTranscript(viewer, "thread-a", "thread-a", NONE, { current: "thread-a" }),
      { initialProps: { viewer: "u-3062" } },
    );
    expect(fresh.result.current.shownMessages).toBe(HELD);
    fresh.rerender({ viewer: "u-other" });
    expect(fresh.result.current.shownMessages).toEqual([]);
    fresh.rerender({ viewer: "u-3062" });
    expect(fresh.result.current.shownMessages).toBe(HELD);
    act(() => fresh.result.current.releaseHeldTranscript());
    expect(fresh.result.current.shownMessages).toEqual([]);
    page.unmount();
    const later = renderHook(() => useHeldChatTranscript("u-3062", "thread-a", "thread-a", NONE, { current: "thread-a" }));
    expect(later.result.current.shownMessages).toEqual([]);
  });
});
