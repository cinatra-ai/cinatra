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
 * The same rule covers first-shown, configured and expired readings (#3287),
 * spent one-offs and stopped recurring schedules. The reader's
 * request and stored transcript remain unchanged. Only an authorized resolved
 * card elects a line; unresolved, absent and stale references do not.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-turn-single-standing-prose-3287.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 2_000 });

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
import { RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE } from "@cinatra-ai/agents/run-status";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "@cinatra-ai/agents/schedule-proposal-card";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { chatSurfaceElement, mountSurface } from "./conversation-column-harness";

/**
 * SECTION VI IS QUOTED HERE RATHER THAN IMPORTED, on purpose: the words are the
 * drawing's, so a constant edited in place cannot make this file pass.
 */
const PROPOSAL_SENTENCE =
  "Schedule proposal is ready. Confirm it on the card below and I will arm it; change the rows first if it is not right.";
const FIRED_RECURRING_SENTENCE =
  "It is still recurring, so the rows below still take a change — it applies to the runs still to come.";
const SPENT_ONE_OFF_SENTENCE =
  "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.";
const STOPPED_RECURRING_SENTENCE = RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE;

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

const PROPOSAL_BODY = {
  phase: "proposal", version: 1, agentName: "Q3 cohort sweep",
  schedule: RECURRING_BODY.schedule, durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true, restrictedReason: null,
};
const EXPIRED_BODY = {
  phase: "expired", version: 1, agentName: "Q3 cohort sweep",
  schedule: RECURRING_BODY.schedule, scheduleCopy: RECURRING_BODY.scheduleCopy,
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
type TurnRoad = "ordered" | "flat-views" | "ordered-unpositioned";

function proposalTurn(road: TurnRoad = "ordered", ref = CARD_REF): UiMessage[] {
  const messages: UiMessage[] = [
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
              ref,
            },
          ],
        },
      ],
    } as unknown as UiMessage,
  ];
  const assistant = messages[1]!;
  if (road !== "ordered") {
    assistant.content = MODEL_LEAD_IN;
    const tool = assistant.parts![1]!;
    if (tool.kind === "tool_call") assistant.dataParts = tool.views;
    if (road === "ordered-unpositioned") assistant.parts = [assistant.parts![0]!];
    else delete assistant.parts;
  }
  return messages;
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
async function mountProposalTurn(reading: string, road: TurnRoad = "ordered", slackMode = false) {
  const result = await mountSurface("chat", { messages: proposalTurn(road), slackMode });
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
  }, { timeout: 2_000 });
  const blocks = assistantProseBlocks(container);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.getAttribute("data-schedule-standing-line")).toBe(reading);
  expect(blocks[0]!.textContent).toBe(sentence);
  // The model's own lead-in is not drawn beside the drawn sentence.
  expect(visibleText(container)).not.toContain(MODEL_LEAD_IN);
  // And the transcript's own history is untouched.
  expect(visibleText(container)).toContain(READER_REQUEST);
}

describe.each<TurnRoad>(["ordered", "flat-views", "ordered-unpositioned"])(
  "section VI — %s schedule turn draws one prose line",
  (road) => {
    it.each([false, true])("draws only the fired-recurring sentence (slackMode=%s)", async (slackMode) => {
      serveReading(RECURRING_BODY, true);
      const { container } = await mountProposalTurn("fired-recurring", road, slackMode);
      await expectOneProseLine(container, FIRED_RECURRING_SENTENCE, "fired-recurring");
    }, 60_000);

    it.each([false, true])("draws only the spent one-off's sentence (slackMode=%s)", async (slackMode) => {
      serveReading(ONE_OFF_BODY, true);
      const { container } = await mountProposalTurn("fired-one-off", road, slackMode);
      await expectOneProseLine(container, SPENT_ONE_OFF_SENTENCE, "spent-one-off");
    }, 60_000);

    it("replaces the fired sentence when the reader stops the schedule", async () => {
      serveUntilStopped();
      const { container } = await mountProposalTurn("fired-recurring", road);
      await stopTheSchedule(container);
      await expectOneProseLine(container, STOPPED_RECURRING_SENTENCE, "stopped-recurring");
    }, 60_000);

    it("reports a stopped recurring schedule that never fired", async () => {
      serveReading(STOPPED_RECURRING_BODY, false);
      const { container } = await mountProposalTurn("configured", road);
      await expectOneProseLine(container, STOPPED_RECURRING_SENTENCE, "stopped-recurring");
    }, 60_000);

    it("does not replace prose for an absent schedule", async () => {
      globalThis.fetch = (async () => jsonResponse({
        kind: "trigger_schedule_proposal", state: { state: "absent" }, body: null,
      })) as typeof fetch;
      const { container } = await mountSurface("chat", { messages: proposalTurn(road) });
      await waitFor(() => expect(visibleText(container)).toContain(MODEL_LEAD_IN));
      expect(container.querySelector("[data-schedule-standing-line]")).toBeNull();
      expect(container.querySelector('[data-conformance-id="schedule-proposal-card"]')).toBeNull();
    });
  },
);

it("drops a model follow-up after the schedule card", async () => {
  serveReading(RECURRING_BODY, true);
  const messages = proposalTurn();
  messages[1]!.parts!.push({ kind: "text", content: "Your proposal is ready to review." });
  const { container } = await mountSurface("chat", { messages });
  await expectOneProseLine(container, FIRED_RECURRING_SENTENCE, "fired-recurring");
});

describe.each<TurnRoad>(["ordered", "flat-views", "ordered-unpositioned"])(
  "section VI — %s authorized proposal readings",
  (road) => {
    it.each([
      ["first-shown", PROPOSAL_BODY],
      ["configured", RECURRING_BODY],
      ["configured", ONE_OFF_BODY],
      ["expired", EXPIRED_BODY],
    ])("uses the drawn proposal line for %s", async (reading, body) => {
      serveReading(body, false);
      const { container } = await mountProposalTurn(reading, road);
      await expectOneProseLine(container, PROPOSAL_SENTENCE, "proposal");
    });

    it("waits for authorization and drops the previous reference's sentence", async () => {
      let answer: (response: Response) => void = () => {};
      globalThis.fetch = vi.fn(async () => new Promise<Response>((resolve) => { answer = resolve; }));
      const view = await mountSurface("chat", { messages: proposalTurn(road) });
      expect(view.container.querySelector("[data-schedule-standing-line]")).toBeNull();
      expect(visibleText(view.container)).toContain(MODEL_LEAD_IN);
      await act(async () => answer(jsonResponse({
        kind: "trigger_schedule_proposal", state: { state: "pending", canDecide: true, canComment: false }, body: PROPOSAL_BODY,
      })));
      await expectOneProseLine(view.container, PROPOSAL_SENTENCE, "proposal");
      view.rerender(chatSurfaceElement({ messages: proposalTurn(road, "new-unresolved-ref") }));
      await waitFor(() => expect(view.container.querySelector("[data-schedule-standing-line]")).toBeNull());
      expect(visibleText(view.container)).toContain(MODEL_LEAD_IN);
      await act(async () => answer(jsonResponse({
        kind: "trigger_schedule_proposal", state: { state: "absent" }, body: null,
      })));
      expect(view.container.querySelector("[data-schedule-standing-line]")).toBeNull();
      expect(view.container.querySelector('[data-conformance-id="schedule-proposal-card"]')).toBeNull();
    });

    it("ignores a stale reference's late authorized response", async () => {
      const answers = new Map<string, (response: Response) => void>();
      globalThis.fetch = vi.fn(async (_input, init) => new Promise<Response>((resolve) => {
        const { ref } = JSON.parse(String(init?.body));
        answers.set(ref, resolve);
      }));
      const view = await mountSurface("chat", { messages: proposalTurn(road) });
      await waitFor(() => expect(answers.has(CARD_REF)).toBe(true));
      view.rerender(chatSurfaceElement({ messages: proposalTurn(road, "new-unresolved-ref") }));
      await waitFor(() => expect(answers.has("new-unresolved-ref")).toBe(true));
      await act(async () => answers.get(CARD_REF)!(jsonResponse({
        kind: "trigger_schedule_proposal", state: { state: "pending", canDecide: true, canComment: false }, body: PROPOSAL_BODY,
      })));
      expect(view.container.querySelector("[data-schedule-standing-line]")).toBeNull();
      expect(view.container.querySelector('[data-conformance-id="schedule-proposal-card"]')).toBeNull();
      expect(visibleText(view.container)).toContain(MODEL_LEAD_IN);
    });
  },
);

// Actual unmerged #3304 copy dependency: keep this drawing assertion honest
// until its separate change lands; no unowned source overlay.
it("section VI preserves the shipped historical stopped wording from cinatra#3304", async () => {
  serveReading(STOPPED_RECURRING_BODY, true);
  const { container } = await mountProposalTurn("fired-recurring");
  const line = await waitFor(() => {
    const el = container.querySelector("[data-schedule-standing-line=stopped-recurring]");
    if (el === null) throw new Error("the stopped sentence never drew");
    return el;
  });
  expect(line.textContent).toBe("The recurring schedule was stopped; its rows are no longer editable.");
});

it("preserves earlier turns and the stored schedule transcript", async () => {
  serveReading(RECURRING_BODY, true);
  const messages: UiMessage[] = [
    { id: "earlier-user", role: "user", content: "Earlier user request." },
    { id: "earlier-assistant", role: "assistant", content: "Earlier assistant answer.",
      parts: [{ kind: "text", content: "Earlier assistant answer." }] },
    ...proposalTurn(),
  ];
  const stored = structuredClone(messages);
  const { container } = await mountSurface("chat", { messages });
  await waitFor(() => expect(container.querySelector("[data-schedule-standing-line=fired-recurring]")).not.toBeNull());
  expect(visibleText(container)).toContain("Earlier user request.");
  expect(visibleText(container)).toContain("Earlier assistant answer.");
  expect(visibleText(container)).toContain(READER_REQUEST);
  expect(visibleText(container)).not.toContain(MODEL_LEAD_IN);
  expect(messages).toEqual(stored);
});

it("leaves an ordinary assistant turn's prose alone", async () => {
  const messages: UiMessage[] = [{ id: "ordinary", role: "assistant", content: MODEL_LEAD_IN,
    parts: [{ kind: "text", content: MODEL_LEAD_IN }] }];
  const { container } = await mountSurface("chat", { messages });
  expect(visibleText(container)).toContain(MODEL_LEAD_IN);
  expect(container.querySelector("[data-schedule-standing-line]")).toBeNull();
});
