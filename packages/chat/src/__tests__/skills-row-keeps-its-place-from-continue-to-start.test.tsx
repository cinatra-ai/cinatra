// @vitest-environment jsdom
/**
 * THE SKILLS ROW KEEPS ITS PLACE, AND ITS QUESTION, FROM CONTINUE TO THE START
 * (cinatra#3062).
 *
 * The ratified drawing, section V:
 *
 *   "A row the reader did see keeps its place in the turn and states, box by
 *    box, that no recommended skill was applied"
 *   "For as long as the run has not started, a reader who comes back to the
 *    Skills step is shown the same pills with the boxes still able to take a
 *    change and Continue still beneath them"
 *   "Once the run is running, the selection is fixed and the row is read-only:
 *    each pill states in its own box whether that skill was applied to the run"
 *
 * WHAT WAS MEASURED. A picture round pressed the one Continue on the all-clear
 * row in a conversation and read the card every three seconds for ninety
 * seconds, with the run row beside it. The run did not start inside the watch
 * (`pending_input`, then `pending_approval`, no start stamp), and yet three
 * readings in a row drew the settled row read-only with NO Continue — the
 * once-started reading on a run that had not started. That is what a turn the
 * transcript RE-CREATES draws: the fresh card replays the reading it last drew
 * and, until its own resolve lands, withholds the one fact that separates the
 * two settled readings — has the run started — because a remembered reading
 * cannot say. The run's own row can, and the turn already reads it.
 *
 * WHAT IS DRIVEN HERE. The REAL conversation column — the real transcript
 * renderer, the real run-row watch and the real card — under the runner's fake
 * timers, with the card's authority and the run's seed route answered at their
 * transport, in the tape's order and timing: the held row; the one Continue on
 * its all-clear selection; the decision on the wire about five seconds; the
 * authority's next answer slow to come home (the round measured about twelve
 * seconds after the press and about nine after a re-created turn); the turn
 * RE-CREATED by the thread poll with fresh message objects and ids; the run
 * row `pending_input` then `pending_approval`, no stamp; then `running`,
 * stamped.
 *
 * Every commit from the press to the end is read: exactly one card in the
 * turn at each of them; the question open — editable, one Continue — at each
 * one before the stamp, the replayed commit included; and read-only with no
 * Continue from the first refresh of the run row after the stamp.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/skills-row-keeps-its-place-from-continue-to-start.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import type { UiMessage } from "../types";

// The composer reads `window.localStorage` on mount; installed ONLY when it is
// missing, exactly as the column's other suites install it.
if (
  typeof globalThis.window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
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

const RUN_ID = "3062c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const SKILL_ID = "@cinatra-ai/blog-writing-skill:blog-writing";

/** The run ROW and the authority, as the tape drove them. */
const tape = vi.hoisted(() => ({
  status: "pending_input" as string,
  startedAt: null as string | null,
  /** The park: `held` until the release, then the decided answer. */
  released: false,
  /** How long the authority's NEXT answer takes to come home, then 0 again. */
  nextResolveDelayMs: 0,
  decision: null as null | { promise: Promise<unknown>; land: (r: unknown) => void },
  decisions: 0,
}));

function heldState() {
  return {
    state: "held",
    runId: RUN_ID,
    agentPackageName: PACKAGE,
    promptText: "{}",
    holdRef: "hold-ref-3062-tape",
    canDecide: true,
    recommendations: [
      {
        skillId: SKILL_ID,
        skillRevisionId: "blog-writing@0.2.0",
        name: "Blog writing",
        vendorName: "Cinatra",
        score: 0.2,
        rank: 1,
        recommended: false,
        scoredFeatures: [],
      },
    ],
  };
}

/** The settled all-clear step: `runStarted` is the run ROW's own stamp. */
function decidedState() {
  return {
    state: "skipped",
    runId: RUN_ID,
    holdRef: "hold-ref-3062-tape",
    canDecide: true,
    runStarted: tape.startedAt !== null,
    decided: [{ skillId: SKILL_ID, name: "Blog writing", mark: "skipped" }],
    candidates: [
      {
        skillId: SKILL_ID,
        skillRevisionId: "blog-writing@0.2.0",
        name: "Blog writing",
        vendorName: "Cinatra",
        recommended: false,
      },
    ],
  };
}

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    const delay = tape.nextResolveDelayMs;
    tape.nextResolveDelayMs = 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return tape.released ? decidedState() : heldState();
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
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
// The run panel's chrome belongs to the agents package's own suites.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-testid="inline-run-panel" data-run-id={runId} />
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

import { resetDrawnRecommendationReadings } from "../../../agents/src/run-recommendation-reading-register";
import { installWidgetServiceStub, surfaceElement } from "./conversation-column-harness";

/** The turn as the conversation holds it. `generation` > 0 is the SAME turn as
 *  the thread poll re-creates it: fresh message objects, and a fresh id where
 *  the stored copy carried none (`chat-page.tsx`'s backfill). */
function dispatchTurn(generation = 0): UiMessage[] {
  const suffix = generation === 0 ? "" : `-recreated-${generation}`;
  return [
    { id: `u1${suffix}`, role: "user", content: "Run the blog draft writer agent for me." },
    {
      id: `a1${suffix}`,
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
    } as unknown as UiMessage,
  ];
}

const CARD = '[data-lifecycle-card="recommendation_hold"]';
const RUN_SEED = "/api/agents/runs/";

const cardsIn = (c: HTMLElement) => c.querySelectorAll<HTMLElement>(CARD).length;
const cardOf = (c: HTMLElement) => c.querySelector<HTMLElement>(CARD);
const continuesOf = (c: HTMLElement) =>
  Array.from(cardOf(c)?.querySelectorAll<HTMLButtonElement>("[data-skills-step-continue]") ?? []);
const editableOf = (c: HTMLElement) => cardOf(c)?.getAttribute("data-skills-step-editable") ?? null;
const stateOf = (c: HTMLElement) => cardOf(c)?.getAttribute("data-lifecycle-card-state") ?? null;

let stub: ReturnType<typeof installWidgetServiceStub> | null = null;
const seedReads = () => stub!.calls.filter((call) => call.url.startsWith(RUN_SEED)).length;

/** Advance the fake clock in small steps, letting every answer land. */
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

beforeAll(async () => {
  await import("../chat-messages-view");
});

beforeEach(() => {
  tape.status = "pending_input";
  tape.startedAt = null;
  tape.released = false;
  tape.nextResolveDelayMs = 0;
  tape.decisions = 0;
  let land!: (r: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    land = r;
  });
  tape.decision = { promise, land };
  resetDrawnRecommendationReadings();
  stub = installWidgetServiceStub({
    lifecycle: () => null,
    recommendationHold: () => (tape.released ? decidedState() : heldState()),
    runSeed: () => ({ status: tape.status, startedAt: tape.startedAt }),
  });
});
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
  resetDrawnRecommendationReadings();
  vi.useRealTimers();
});
afterAll(() => {
  vi.doUnmock("../../../agents/src/run-recommendation-actions");
  vi.doUnmock("../../../agents/src/agent-hitl-screen-actions");
  vi.doUnmock("../../../agents/src/hitl-actions");
  vi.doUnmock("../../../agents/src/server-actions");
  vi.doUnmock("../inline-agent-run-card");
  vi.doUnmock("next/navigation");
  vi.doUnmock("../pending-call-actions");
  vi.doUnmock("../undo-actions");
  vi.doUnmock("@/components/data-safety/undo-toast");
  vi.resetModules();
});

describe("the skills row in the chat, from the one Continue to the run's start", () => {
  it("keeps exactly one row in the turn, open until the stamp and read-only from the first refresh after it", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(surfaceElement("chat", { messages: dispatchTurn() }));

    // THE HELD ROW, before the press: one pill, its box clear, one Continue.
    await advanceUntil(() => continuesOf(container).length === 1, 20_000);
    expect(stateOf(container)).toBe("held");
    expect(editableOf(container)).toBe("true");

    // EVERY COMMIT from the press to the end, as the DOM actually was. The
    // phase says which assertion a commit owes: before the stamp the question
    // is open; after it, the first refresh of the run row closes it.
    let phase: "before-stamp" | "stamped" = "before-stamp";
    const frames: Array<{ phase: string; cards: number; editable: string | null; continues: number; enabled: boolean; state: string | null }> = [];
    const record = () =>
      frames.push({
        phase,
        cards: cardsIn(container),
        editable: editableOf(container),
        continues: continuesOf(container).length,
        enabled: continuesOf(container).length === 1 && !continuesOf(container)[0]!.disabled,
        state: stateOf(container),
      });
    const observer = new MutationObserver(record);
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    // THE ONE CONTINUE on the all-clear selection.
    fireEvent.click(continuesOf(container)[0]!);
    await advance(200);
    expect(tape.decisions).toBe(1);

    // THE DECISION ON THE WIRE for about five seconds.
    await advance(5_000);

    // HOME: the park is released, the run went on to its next gate without
    // starting — and the authority's next answer is slow to come home.
    tape.released = true;
    tape.nextResolveDelayMs = 12_000;
    await act(async () => {
      tape.decision!.land({ ok: true, dispatched: true });
      await Promise.resolve();
    });
    await advance(13_000);
    // The decided row, before the start: open.
    expect(stateOf(container)).toBe("decided");
    expect(editableOf(container)).toBe("true");

    // THE TURN RE-CREATED by the thread poll, and the fresh card's own resolve
    // slow to come home too.
    tape.nextResolveDelayMs = 9_000;
    rerender(surfaceElement("chat", { messages: dispatchTurn(1) }));
    await advance(12_000);

    // THE RUN MOVES TO ITS NEXT GATE, still unstarted: `pending_approval`, no
    // stamp — read by the turn's own run-row watch.
    tape.status = "pending_approval";
    await advance(30_000, 500);

    // THE RUN STARTS: running, stamped.
    const readsBefore = seedReads();
    tape.status = "running";
    tape.startedAt = "2026-09-28T00:11:39.000000Z";
    phase = "stamped";
    await advanceUntil(() => seedReads() > readsBefore, 15_000);
    await advance(500);
    observer.disconnect();

    // The walk is not vacuous.
    expect(frames.length).toBeGreaterThan(0);

    // "A row the reader did see keeps its place in the turn" — exactly one row
    // at every commit from the press to the end.
    expect(frames.filter((f) => f.cards !== 1)).toEqual([]);

    // "For as long as the run has not started … the boxes still able to take a
    // change and Continue still beneath them" — at every commit before the
    // stamp, the replayed one included.
    expect(
      frames.filter(
        (f) =>
          f.phase === "before-stamp" && !(f.editable === "true" && f.continues === 1 && f.enabled),
      ),
    ).toEqual([]);

    // "Once the run is running, the selection is fixed and the row is
    // read-only" — from the first refresh of the run row after the stamp.
    expect(stateOf(container)).toBe("decided");
    expect(editableOf(container)).toBe("false");
    expect(continuesOf(container)).toHaveLength(0);
    expect(cardsIn(container)).toBe(1);
    // One press, one decision.
    expect(tape.decisions).toBe(1);
  }, 120_000);

  it("a turn re-created after the run started replays the row read-only from its first commit", async () => {
    // THE SAFETY HALF. "Once the run is running, the selection is fixed and the
    // row is read-only: each pill states in its own box whether that skill was
    // applied to the run" — a replay may never re-open the boxes on a run that
    // is under way, not even for the one commit before its own resolve lands.
    vi.useFakeTimers();
    const { container, rerender } = render(surfaceElement("chat", { messages: dispatchTurn() }));
    await advanceUntil(() => continuesOf(container).length === 1, 20_000);

    fireEvent.click(continuesOf(container)[0]!);
    await advance(200);
    tape.released = true;
    await act(async () => {
      tape.decision!.land({ ok: true, dispatched: true });
      await Promise.resolve();
    });
    await advanceUntil(() => stateOf(container) === "decided", 10_000);
    expect(editableOf(container)).toBe("true");

    // THE RUN STARTS, and the turn's own watch reads the stamp.
    tape.status = "running";
    tape.startedAt = "2026-09-28T00:11:39.000000Z";
    await advanceUntil(() => continuesOf(container).length === 0, 15_000);
    expect(editableOf(container)).toBe("false");

    // THE TURN RE-CREATED, its fresh resolve slow to come home.
    const frames: Array<{ cards: number; editable: string | null; continues: number }> = [];
    const observer = new MutationObserver(() =>
      frames.push({
        cards: cardsIn(container),
        editable: editableOf(container),
        continues: continuesOf(container).length,
      }),
    );
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    tape.nextResolveDelayMs = 9_000;
    rerender(surfaceElement("chat", { messages: dispatchTurn(1) }));
    await advance(12_000);
    observer.disconnect();

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((f) => !(f.cards === 1 && f.editable === "false" && f.continues === 0))).toEqual([]);
    expect(editableOf(container)).toBe("false");
    expect(continuesOf(container)).toHaveLength(0);
  }, 120_000);
});
