// @vitest-environment jsdom
/**
 * THE SETTLED SCHEDULE TURN DRAWS ONE PROSE LINE (cinatra#3174 fix leg 9).
 *
 * Section VI draws each of its example turns the same way: the reader's own
 * words, then the assistant's turn — and that turn carries EXACTLY ONE prose
 * line above the card. For a recurring schedule that has fired, the section's
 * example turn reads:
 *
 *   "It is still recurring, so the rows below still take a change — it applies
 *    to the runs still to come."
 *
 * and there is nothing above it. Fix leg 7 added that line beside the model's
 * own lead-in rather than in place of it, so the shipped turn drew TWO prose
 * lines — the model's "Here's the schedule proposal." and then the drawn
 * sentence. A graded round measured that on every settled reading and it is the
 * one family that held the round under its bar.
 *
 * WHAT THIS FILE MEASURES: the number of prose blocks a settled schedule turn
 * draws, on the road the card really arrives by (the schedule proposal
 * primitive's own tool result, the real card, the real refetch seam). One block,
 * and it carries the drawn sentence.
 *
 * WHAT IT DOES NOT CHANGE: the transcript's own history. The reader's request
 * above the turn is untouched, and a reading with no sentence of its own — a
 * schedule that has never fired — keeps the model's lead-in as its one line,
 * which is what the section's first-shown and configured examples draw.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-standing-line-single-prose-3193-fix9.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

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

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
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
// This turn has no run dispatch at all — the panel is mocked only so the lazy
// column's own imports resolve in this environment.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => <div data-inline-run-card={runId} />,
}));

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "@cinatra-ai/agents/schedule-proposal-card";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { mountSurface } from "./conversation-column-harness";

/**
 * SECTION VI IS QUOTED HERE RATHER THAN IMPORTED, on purpose: the words are the
 * drawing's, so a constant edited in place cannot make this file pass.
 */
const FIRED_RECURRING_SENTENCE =
  "It is still recurring, so the rows below still take a change — it applies to the runs still to come.";
const SPENT_ONE_OFF_SENTENCE =
  "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.";
const STOPPED_RECURRING_SENTENCE =
  "Pressing it stops the recurring schedule, and the rows are not editable after that.";

const RUN_ID = "1d3a7c60-8b21-4f0e-9a55-6c2b4d0f7a13";
const CARD_REF = "schedule-ref-3193-fix9";

/** THE PRIMITIVE THE MODEL REALLY CALLS to put this card in a conversation. */
const SCHEDULE_PROPOSAL_TOOL = "schedule_proposal_render";

/** The model's own lead-in, exactly as a graded round recorded it. */
const MODEL_LEAD_IN = "Here's the schedule proposal.";

/** The reader's own words, above the turn. History, and never this turn's. */
const READER_REQUEST = "Run this every weekday at 9 in the morning.";

const WEEKDAYS_AT_NINE = {
  frequency: "weekly",
  interval: 1,
  weekdays: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 9,
  minute: 0,
};

const RECURRING_BODY = {
  phase: "settled",
  version: 1,
  agentName: "Q3 cohort sweep",
  runId: RUN_ID,
  schedule: { kind: "recurring", selection: WEEKDAYS_AT_NINE, timezone: "Europe/Berlin" },
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  canSave: true,
  canCancel: true,
  arming: false,
};

const ONE_OFF_BODY = {
  phase: "settled",
  version: 1,
  agentName: "Q3 cohort sweep",
  runId: RUN_ID,
  schedule: { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "Once, at 2026-07-14 09:00",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  canSave: false,
  canCancel: false,
  arming: false,
};

const STOPPED_RECURRING_BODY = {
  ...RECURRING_BODY,
  stopped: true,
  canSave: false,
  canCancel: false,
};

let restoreFetch: typeof globalThis.fetch;
let cancelPresses = 0;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stand a server up that answers the card's resolve with ONE reading. */
function serveReading(body: Record<string, unknown>, firedOnce: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      return jsonResponse({
        kind: "trigger_schedule_proposal",
        state: { state: "settled" },
        body,
        firedOnce,
      });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

/** Stand a server up that answers the real stop and then reads back stopped. */
function serveUntilStopped(): void {
  let stopped = false;
  cancelPresses = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      return jsonResponse({
        kind: "trigger_schedule_proposal",
        state: { state: "settled" },
        body: stopped ? STOPPED_RECURRING_BODY : RECURRING_BODY,
        firedOnce: true,
      });
    }
    if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { op?: string };
      if (sent.op === "cancel") {
        cancelPresses += 1;
        stopped = true;
        return jsonResponse({ outcome: { kind: "cancelled" } });
      }
      return jsonResponse({ outcome: { kind: "error", message: "not this op" } });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  restoreFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = restoreFetch;
});

/** The turn the schedule proposal primitive really produces. */
function proposalTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: READER_REQUEST },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        { kind: "text", content: MODEL_LEAD_IN },
        {
          kind: "tool_call",
          id: "t1",
          name: SCHEDULE_PROPOSAL_TOOL,
          status: "completed",
          views: [
            {
              viewType: "trigger_schedule_proposal",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: CARD_REF,
            },
          ],
        },
      ],
    } as unknown as UiMessage,
  ];
}

/** The text a reader can actually see, with every hidden subtree left out. */
function visibleText(root: Element): string {
  let out = "";
  for (const child of Array.from(root.children)) {
    if (child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true") continue;
    out += visibleText(child);
  }
  return out + (root.children.length === 0 ? (root.textContent ?? "") : "");
}

/**
 * EVERY PROSE BLOCK THE ASSISTANT'S TURN DRAWS, in document order. Two hooks,
 * because the turn has exactly two ways to put prose on the screen: the
 * assistant-content block a text part draws (`data-embed-content`, the same hook
 * both prose roads wear) and the reading's own standing line.
 */
function assistantProseBlocks(container: HTMLElement): Element[] {
  return Array.from(
    container.querySelectorAll("[data-embed-content], [data-schedule-standing-line]"),
  );
}

/** Mount the turn and wait for the card to settle on the reading named. */
async function mountProposalTurn(reading: string) {
  const result = await mountSurface("chat", { messages: proposalTurn() });
  await waitFor(() => {
    const card = result.container.querySelector(
      '[data-conformance-id="schedule-proposal-card"]',
    );
    if (card === null) throw new Error("the schedule card never drew");
    if (card.getAttribute("data-schedule-reading") !== reading) {
      throw new Error(
        `the card reads "${card.getAttribute("data-schedule-reading")}", not "${reading}"`,
      );
    }
  });
  return result;
}

/** Press Cancel schedule and confirm the strip — the reader's own two acts. */
async function stopTheSchedule(container: HTMLElement): Promise<void> {
  const cancel = await waitFor(() => {
    const el = container.querySelector('[data-action="cancel-trigger-schedule"]');
    if (el === null) throw new Error("Cancel schedule never drew on the floor");
    return el;
  });
  fireEvent.click(cancel);
  const confirm = await waitFor(() => {
    const strip = container.querySelector('[data-conformance-id="schedule-cancel-confirm"]');
    if (strip === null) throw new Error("the ask-first strip never drew");
    const el = strip.querySelector('[data-action="confirm-destructive"]');
    if (el === null) throw new Error("the strip drew no confirm");
    return el;
  });
  fireEvent.click(confirm);
  await waitFor(() => {
    expect(cancelPresses).toBe(1);
  });
}

/** The one measurement, made the same way for every settled reading. */
async function expectOneProseLine(
  container: HTMLElement,
  sentence: string,
  reading: string,
): Promise<void> {
  // The reading is reported after mount, so the line it draws arrives a tick
  // after the card does: wait for the SETTLED turn — the drawn sentence on
  // screen — and measure the prose blocks standing with it.
  await waitFor(() => {
    const blocks = assistantProseBlocks(container);
    const settled =
      blocks.length === 1 && blocks[0]!.getAttribute("data-schedule-standing-line") === reading;
    if (!settled) {
      throw new Error(
        `the turn draws ${blocks.length} prose blocks: ${blocks
          .map((b) => JSON.stringify(b.textContent))
          .join(" | ")}`,
      );
    }
  });
  const blocks = assistantProseBlocks(container);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.getAttribute("data-schedule-standing-line")).toBe(reading);
  expect(blocks[0]!.textContent).toBe(sentence);
  // The model's own lead-in is not drawn beside the drawn sentence.
  expect(visibleText(container)).not.toContain(MODEL_LEAD_IN);
  // And the transcript's own history is untouched.
  expect(visibleText(container)).toContain(READER_REQUEST);
}

describe("section VI — a settled schedule turn draws one prose line", () => {
  it("draws only the fired-recurring sentence over a recurring schedule that has fired", async () => {
    serveReading(RECURRING_BODY, true);
    const { container } = await mountProposalTurn("fired-recurring");
    await expectOneProseLine(container, FIRED_RECURRING_SENTENCE, "fired-recurring");
  }, 60_000);

  it("draws only the spent one-off's sentence over a one-off that has fired", async () => {
    serveReading(ONE_OFF_BODY, true);
    const { container } = await mountProposalTurn("fired-one-off");
    await expectOneProseLine(container, SPENT_ONE_OFF_SENTENCE, "spent-one-off");
  }, 60_000);

  it("draws only the stopped sentence once the reader stops the schedule", async () => {
    serveUntilStopped();
    const { container } = await mountProposalTurn("fired-recurring");
    await stopTheSchedule(container);
    await expectOneProseLine(container, STOPPED_RECURRING_SENTENCE, "stopped-recurring");
  }, 60_000);
});

describe("section VI — a reading with no sentence of its own keeps the model's line", () => {
  it("leaves the never-fired turn drawing exactly the model's own lead-in", async () => {
    serveReading(RECURRING_BODY, false);
    const { container } = await mountProposalTurn("configured");
    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hasAttribute("data-schedule-standing-line")).toBe(false);
    expect(visibleText(container)).toContain(MODEL_LEAD_IN);
  }, 60_000);
});
