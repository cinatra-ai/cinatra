// @vitest-environment jsdom
/**
 * THE STOPPED READING GETS ITS OWN LINE IN THE TURN (cinatra#3174 fix leg 8,
 * criterion 4).
 *
 * WHAT THE FOURTH GRADED ROUND MEASURED. Cancel schedule was pressed and
 * confirmed, the CARD went read-only and floorless exactly as section VI draws
 * it — and the sentence above it still read "It is still recurring, so the rows
 * below still take a change — it applies to the runs still to come." The turn
 * kept claiming the schedule was live over a schedule that had just been
 * stopped, which is the same untruth the two fired sentences exist to answer.
 *
 * THE SECTION SPELLS THE STOPPED READING OUT. Cancel schedule "appears only
 * where the schedule is recurring, and it stops the recurring schedule and then
 * leaves the rows no longer editable", and the reading it leaves behind is
 * written as:
 *
 *   "Pressing it stops the recurring schedule, and the rows are not editable
 *    after that."
 *
 * THE REAL ROAD, AND A REAL PRESS. Like its fix-leg-7 sibling this file drives
 * the WHOLE conversation column — the real composer, the real card, resolved
 * through the real refetch seam — and it does not hand the card a stopped body
 * to begin with: it presses Cancel schedule, confirms the strip, answers the
 * real decision endpoint, and lets the card re-resolve the way a landed
 * decision really makes it. What a reader sees after the press is what is
 * measured.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-standing-line-stopped-3193-fix8.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 8_000 });

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
import { RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE } from "@cinatra-ai/agents/run-status";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "@cinatra-ai/agents/schedule-proposal-card";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { mountSurface } from "./conversation-column-harness";

/**
 * SECTION VI IS QUOTED HERE RATHER THAN IMPORTED, on purpose. The words are the
 * drawing's, so this file measures the drawing rather than measuring whatever
 * constant the source happens to hold: a constant edited in place would still
 * pass a test that imported it.
 */
const STOPPED_RECURRING_SENTENCE =
  "Pressing it stops the recurring schedule, and the rows are not editable after that.";

const RUN_ID = "1d3a7c60-8b21-4f0e-9a55-6c2b4d0f7a13";
const CARD_REF = "schedule-ref-3193-fix8";

/** THE PRIMITIVE THE MODEL REALLY CALLS to put this card in a conversation. */
const SCHEDULE_PROPOSAL_TOOL = "schedule_proposal_render";

/** The model's own lead-in, exactly as a graded round recorded it. */
const MODEL_LEAD_IN = "Here's the schedule proposal.";

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

/** The reading the press starts from: recurring, fired once, still stoppable. */
const FIRED_RECURRING_BODY = {
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

/**
 * THE READING THE SERVER ANSWERS WITH ONCE THE STOP LANDS. `stopped` is the
 * durable signal — `canCancel` goes false the moment the schedule is stopped and
 * so cannot tell a stopped card from a one-off — and the FIRING stays true,
 * which is exactly why the turn could not tell the two readings apart.
 */
const STOPPED_RECURRING_BODY = {
  ...FIRED_RECURRING_BODY,
  stopped: true,
  canSave: false,
  canCancel: false,
};

let restoreFetch: typeof globalThis.fetch;
let cancelPresses = 0;

/** Stand a server up that answers the real decision and then reads back stopped. */
function serveUntilStopped(): void {
  let stopped = false;
  cancelPresses = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      return json({
        kind: "trigger_schedule_proposal",
        state: { state: "settled" },
        body: stopped ? STOPPED_RECURRING_BODY : FIRED_RECURRING_BODY,
        // The firing does not go away because the schedule was stopped.
        firedOnce: true,
      });
    }
    if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { op?: string };
      if (sent.op === "cancel") {
        cancelPresses += 1;
        stopped = true;
        return json({ outcome: { kind: "cancelled" } });
      }
      return json({ outcome: { kind: "error", message: "not this op" } });
    }
    return json({}, 404);
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
    { id: "u1", role: "user", content: "Run this every weekday at 9 in the morning." },
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

/** Mount the real turn and wait for the card to settle on the fired reading. */
async function mountFiredRecurringTurn() {
  const result = await mountSurface("chat", { messages: proposalTurn() });
  await waitFor(() => {
    const card = result.container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    if (card === null) throw new Error("the schedule card never drew");
    if (card.getAttribute("data-schedule-reading") !== "fired-recurring") {
      throw new Error(
        `the card reads "${card.getAttribute("data-schedule-reading")}", not "fired-recurring"`,
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

describe("criterion 4 — the stopped reading's own sentence, after a real press", () => {
  it("replaces the fired-recurring line with the stopped line once the stop lands", async () => {
    serveUntilStopped();
    const { container } = await mountFiredRecurringTurn();

    // The turn starts on the fired-recurring reading, as the fourth round saw.
    const before = await waitFor(() => {
      const el = container.querySelector("[data-schedule-standing-line]");
      if (el === null) throw new Error("the fired-recurring line never drew");
      return el;
    });
    expect(before.textContent).toBe(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);

    await stopTheSchedule(container);

    const line = await waitFor(() => {
      const el = container.querySelector("[data-schedule-standing-line]");
      if (el === null) throw new Error("the stopped reading drew no line at all");
      if (el.getAttribute("data-schedule-standing-line") !== "stopped-recurring") {
        throw new Error(`the turn still reads "${el.getAttribute("data-schedule-standing-line")}"`);
      }
      return el;
    });
    expect(line.textContent).toBe(STOPPED_RECURRING_SENTENCE);
  }, 60_000);

  it("never leaves the still-recurring claim standing over a stopped schedule", async () => {
    serveUntilStopped();
    const { container } = await mountFiredRecurringTurn();
    await stopTheSchedule(container);
    await waitFor(() => {
      expect(visibleText(container)).toContain(STOPPED_RECURRING_SENTENCE);
    });
    expect(visibleText(container)).not.toContain(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
    // The model's own lead-in is not rewritten by any of this.
    expect(visibleText(container)).toContain(MODEL_LEAD_IN);
  }, 60_000);

  it("draws the line in the turn, above the card, never inside it", async () => {
    serveUntilStopped();
    const { container } = await mountFiredRecurringTurn();
    await stopTheSchedule(container);
    const line = await waitFor(() => {
      const el = container.querySelector('[data-schedule-standing-line="stopped-recurring"]');
      if (el === null) throw new Error("the stopped reading's own line never drew");
      return el;
    });
    const card = container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    expect(card).not.toBeNull();
    // Section VI puts the line ABOVE the rows and rules a summary node out of
    // the card itself: the card draws the card, the turn draws the line.
    expect(card!.contains(line)).toBe(false);
    expect(line.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And the card is the read-only, floorless one the section draws after the
    // stop: there is nothing left on it to press.
    expect(card!.querySelector('[data-action="cancel-trigger-schedule"]')).toBeNull();
    expect(card!.querySelector('[data-action="save-schedule-changes"]')).toBeNull();
  }, 60_000);
});
