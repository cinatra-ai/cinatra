// @vitest-environment jsdom
/**
 * THE FIRED READING'S OWN LINE, ON THE ROAD THE CARD REALLY ARRIVES BY
 * (cinatra#3174 fix leg 7, criterion 4).
 *
 * Section VI gives a schedule that has fired its own words above the rows, and
 * gives the two fired readings DIFFERENT words:
 *
 *   fired recurring — "It is still recurring, so the rows below still take a
 *                      change — it applies to the runs still to come."
 *   spent one-off   — "It ran at the time you set. A one-time schedule is spent
 *                      once it fires, so the rows below are the record of it and
 *                      cannot be changed."
 *
 * WHY THIS FILE EXISTS AND THE LEAF-LEVEL ONES DID NOT CATCH IT. The earlier
 * work minted both sentences and a correction that rewrites the PLATFORM's own
 * start sentence — "Dispatched `pkg` (runId: `…`, status: `…`)." — into them.
 * That correction is exercised directly by its own unit file and is green. But
 * the road a schedule card really arrives by in a conversation is the schedule
 * proposal primitive's own tool result, not a run dispatch: that turn carries no
 * platform sentence at all, only the model's own lead-in, so there was nothing
 * for the correction to match and the fired turn drew EXACTLY the words the
 * never-fired turn drew. A graded round measured both readings reading the same
 * line. So this file drives the REAL composer — the whole conversation column,
 * the real card, resolved through the real refetch seam — and measures the words
 * a reader actually sees.
 *
 * WHAT IT DOES NOT MEASURE. The model's own lead-in is left exactly as it was
 * written: this turn draws the reading's line, it does not rewrite prose it did
 * not author.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-standing-line-real-road-3193-fix7.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

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
import {
  RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE,
  RUN_START_SCHEDULE_FIRED_SENTENCE,
} from "@cinatra-ai/agents/run-status";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { mountSurface } from "./conversation-column-harness";

const RUN_ID = "1d3a7c60-8b21-4f0e-9a55-6c2b4d0f7a13";
const CARD_REF = "schedule-ref-3193-fix7";

/** THE PRIMITIVE THE MODEL REALLY CALLS to put this card in a conversation. It
 *  is not a run-start tool name, which is the whole point: this turn has no
 *  dispatch part, no run panel and no platform sentence. */
const SCHEDULE_PROPOSAL_TOOL = "schedule_proposal_render";

/** The model's own lead-in, exactly as a graded round recorded it on both the
 *  fired and the never-fired turn. */
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

let restoreFetch: typeof globalThis.fetch;

/** Stand a server up that answers the card's resolve with ONE reading. */
function serveReading(body: Record<string, unknown>, firedOnce: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
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
        body,
        // The fired signal rides the answer BESIDE the body (cinatra#3193).
        firedOnce,
      });
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

/** The turn the schedule proposal primitive really produces: the model's own
 *  lead-in, and the card the tool result minted at that same step. */
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

/** The text a reader can actually see, with every hidden subtree left out. */
function visibleText(root: Element): string {
  let out = "";
  for (const child of Array.from(root.children)) {
    if (child.hasAttribute("hidden") || child.getAttribute("aria-hidden") === "true") continue;
    out += visibleText(child);
  }
  return out + (root.children.length === 0 ? (root.textContent ?? "") : "");
}

describe("criterion 4 — a fired recurring schedule's turn says so, on the real road", () => {
  it("draws the drawing's fired-recurring sentence in the turn", async () => {
    serveReading(RECURRING_BODY, true);
    const { container } = await mountProposalTurn("fired-recurring");
    await waitFor(() => {
      expect(visibleText(container)).toContain(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
    });
  });

  it("draws that line in the turn, never inside the card", async () => {
    serveReading(RECURRING_BODY, true);
    const { container } = await mountProposalTurn("fired-recurring");
    const line = await waitFor(() => {
      const el = container.querySelector("[data-schedule-standing-line]");
      if (el === null) throw new Error("the reading's own line never drew");
      return el;
    });
    expect(line.getAttribute("data-schedule-standing-line")).toBe("fired-recurring");
    expect(line.textContent).toBe(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
    const card = container.querySelector('[data-conformance-id="schedule-proposal-card"]');
    expect(card).not.toBeNull();
    // Section VI puts the line ABOVE the rows and rules a summary node out of
    // the card itself: the card draws the card, the turn draws the line.
    expect(card!.contains(line)).toBe(false);
    expect(line.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves the model's own lead-in exactly as it was written", async () => {
    serveReading(RECURRING_BODY, true);
    const { container } = await mountProposalTurn("fired-recurring");
    await waitFor(() => {
      expect(visibleText(container)).toContain(MODEL_LEAD_IN);
    });
  });
});

describe("criterion 4 — the never-fired turn is not the fired turn", () => {
  it("draws no standing line over a recurring schedule that has never fired", async () => {
    serveReading(RECURRING_BODY, false);
    const { container } = await mountProposalTurn("configured");
    expect(container.querySelector("[data-schedule-standing-line]")).toBeNull();
    expect(visibleText(container)).not.toContain(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
    // And the graded round's own measurement, as an assertion: the two turns
    // may not read the same.
    expect(visibleText(container)).toContain(MODEL_LEAD_IN);
  });
});

describe("criterion 4 — the spent one-off keeps its OWN words", () => {
  it("draws the spent one-off's sentence, not the recurring one", async () => {
    serveReading(ONE_OFF_BODY, true);
    const { container } = await mountProposalTurn("fired-one-off");
    const line = await waitFor(() => {
      const el = container.querySelector("[data-schedule-standing-line]");
      if (el === null) throw new Error("the reading's own line never drew");
      return el;
    });
    expect(line.getAttribute("data-schedule-standing-line")).toBe("spent-one-off");
    expect(line.textContent).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE);
    expect(visibleText(container)).not.toContain(RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE);
  });
});
