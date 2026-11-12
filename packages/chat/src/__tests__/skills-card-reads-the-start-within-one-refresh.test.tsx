// @vitest-environment jsdom
/**
 * THE SKILLS CARD READS THE RUN'S START WITHIN ONE REFRESH (cinatra#3062).
 *
 * §V: "Once the run is running, the selection is fixed and the row is
 * read-only: each pill states in its own box whether that skill was applied to
 * the run." The issue's refinement 1: "the read-only reading exists only once
 * the run is running."
 *
 * WHAT WAS WRONG. The card learns the start from ONE signal: a change of the
 * run status the turn's own run-row watch reads (`useRunMomentCard`). That
 * watch backs off — every 2 s for its first five reads, every 5 s to the
 * fifteenth, every 10 s after — and a run held at a person's question for a
 * couple of minutes is well past the fifteenth read when it is finally
 * dispatched. So the watch read the row `queued`, the run started half a second
 * later, and the next read came ten seconds on: a measured round saw the card
 * keep its boxes and its Continue for about fifteen seconds after the start.
 *
 * WHAT IS DRIVEN HERE. The REAL conversation column on both hosts — the real
 * transcript renderer, the real run-row watch and the real card — under the
 * runner's fake timers, with the card's authority and the run's seed route
 * answered at their transport. The authority answers `runStarted` from the run
 * row's own start stamp. The run is held at its next gate for more than
 * fifteen watch reads, is then dispatched (`queued`, no stamp) and starts
 * (`running`, stamped); the card must draw the read-only reading with no
 * Continue within ONE refresh of the run row — the watch's 2 s — of the stamp.
 *
 * AND THE ROAD WITH NO LATER GATE (convergence finding). A run parked at the
 * Skills step itself (`pending_input`) whose Continue releases it straight into
 * its start can go `queued` and then `running` entirely between two looks of a
 * backed-off watch, so the watch never sees `queued` to turn brisk on. The same
 * bound holds there: the watch stays brisk while the run stands at that step.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/skills-card-reads-the-start-within-one-refresh.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

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

const RUN_ID = "3062b1c2-d3e4-4f5a-8b6c-7d8e9f0a1b2c";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

/** ONE REFRESH of the run row — the watch's brisk interval, the same 2 s the
 *  run panel polls a queued or running run at — plus the card's one resolve. */
const ONE_REFRESH_MS = 2000;
const RESOLVE_ALLOWANCE_MS = 500;

/** The run ROW, as the watch and the authority both read it. */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  startedAt: null as string | null,
  cookieReads: 0,
}));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    row.cookieReads += 1;
    return settled();
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
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

function dispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run the blog draft writer agent for me." },
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
          result: JSON.stringify({ runId: RUN_ID, status: "pending_approval" }),
        },
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_approval\`).`,
        },
      ],
    } as unknown as UiMessage,
  ];
}

const CANDIDATES = [
  {
    skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
    skillRevisionId: "blog-writing@0.4.2",
    name: "Blog writing",
    vendorName: "Cinatra",
    recommended: true,
  },
  {
    skillId: "@cinatra-ai/chat:company-research",
    skillRevisionId: "company-research@2",
    name: "Company research",
    vendorName: "Northstar",
    recommended: false,
  },
];

/** The settled step as the authority answers it: `runStarted` is the run
 *  ROW's own start stamp, read on every read. */
function settled() {
  return {
    state: "skipped",
    runId: RUN_ID,
    holdRef: "hold-ref-3062-refresh",
    canDecide: true,
    runStarted: row.startedAt !== null,
    decided: [
      { skillId: CANDIDATES[0].skillId, name: "Blog writing", mark: "skipped" },
      { skillId: CANDIDATES[1].skillId, name: "Company research", mark: "skipped" },
    ],
    candidates: CANDIDATES,
  };
}

const CARD = '[data-lifecycle-card="recommendation_hold"]';
const RUN_SEED = "/api/agents/runs/";

const cardOf = (c: HTMLElement) => c.querySelector<HTMLElement>(CARD);
const continuesOf = (c: HTMLElement) =>
  cardOf(c)?.querySelectorAll<HTMLElement>("[data-skills-step-continue]").length ?? 0;
const editableOf = (c: HTMLElement) => cardOf(c)?.getAttribute("data-skills-step-editable") ?? null;

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

/** Advance until `done` holds, returning the fake milliseconds it took. */
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

// THE COLUMN'S LAZY BOUNDARY is a module load, not a timer: it is loaded once,
// on the real clock, before any arm hands the clock to the runner.
beforeAll(async () => {
  await import("../chat-messages-view");
});

beforeEach(() => {
  row.status = "pending_approval";
  row.startedAt = null;
  row.cookieReads = 0;
  resetDrawnRecommendationReadings();
  stub = installWidgetServiceStub({
    lifecycle: () => null,
    recommendationHold: () => settled(),
    runSeed: () => ({ status: row.status, startedAt: row.startedAt }),
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

async function readOnlyWithinOneRefresh(
  surface: "chat" | "widget",
  road: "queued-read" | "between-reads" = "queued-read",
) {
  if (road === "between-reads") row.status = "pending_input";
  vi.useFakeTimers();
  const { container } = render(surfaceElement(surface, { messages: dispatchTurn() }));

  // BEFORE THE START: the settled step, editable, ONE Continue.
  await advanceUntil(() => continuesOf(container) === 1, 20_000);
  expect(editableOf(container)).toBe("true");

  // HELD AT THE NEXT GATE for more than fifteen watch reads: the watch has
  // backed off to its long interval by the time the run is dispatched.
  await advanceUntil(() => seedReads() > 16, 180_000, 500);
  expect(seedReads()).toBeGreaterThan(16);
  expect(editableOf(container)).toBe("true");
  expect(continuesOf(container)).toBe(1);

  if (road === "queued-read") {
    // DISPATCHED: the row reads `queued`, no stamp. The watch reads it on its
    // own next look; the card stays editable (the run has not started).
    row.status = "queued";
    const readsBefore = seedReads();
    await advanceUntil(() => seedReads() > readsBefore, 15_000);
    expect(seedReads()).toBe(readsBefore + 1);
    await advance(200);
    expect(editableOf(container)).toBe("true");
    expect(continuesOf(container)).toBe(1);
  } else {
    // RELEASED AND STARTED BETWEEN TWO LOOKS: the watch never reads `queued`.
    // Half a second after its last look at the Skills step, the run is running.
    const readsBefore = seedReads();
    await advanceUntil(() => seedReads() > readsBefore, 15_000);
    await advance(200);
    expect(editableOf(container)).toBe("true");
    expect(continuesOf(container)).toBe(1);
  }

  // THE RUN STARTS half a second after that look: running, stamped.
  await advance(300);
  row.status = "running";
  row.startedAt = "2026-09-27T20:02:46.553932Z";
  const elapsed = await advanceUntil(() => continuesOf(container) === 0, 15_000);

  expect(
    elapsed,
    `the read-only reading arrived ${elapsed} ms after the start stamp`,
  ).toBeLessThanOrEqual(ONE_REFRESH_MS + RESOLVE_ALLOWANCE_MS);
  expect(editableOf(container)).toBe("false");
  expect(continuesOf(container)).toBe(0);
  // The same row, still in the turn.
  expect(container.querySelectorAll(CARD)).toHaveLength(1);
}

describe("the skills card reads the run's start within one refresh of the run row", () => {
  it("in /chat: read-only with no Continue within one refresh of the start", async () => {
    await readOnlyWithinOneRefresh("chat");
    expect(row.cookieReads).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("in the widget: the same, under the widget's own credential", async () => {
    await readOnlyWithinOneRefresh("widget");
    expect(row.cookieReads).toBe(0);
    for (const call of stub!.calls) expect(call.init.credentials).toBe("omit");
  }, 60_000);

  it("in /chat: the same when the run leaves the Skills step and starts between two looks", async () => {
    await readOnlyWithinOneRefresh("chat", "between-reads");
  }, 60_000);

  it("in the widget: the same when the run leaves the Skills step and starts between two looks", async () => {
    await readOnlyWithinOneRefresh("widget", "between-reads");
    for (const call of stub!.calls) expect(call.init.credentials).toBe("omit");
  }, 60_000);
});
