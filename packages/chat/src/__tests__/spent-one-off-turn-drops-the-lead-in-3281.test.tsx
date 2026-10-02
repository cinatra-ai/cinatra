// @vitest-environment jsdom
/**
 * THE SETTLED SCHEDULE TURN DRAWS ONE PROSE LINE ON THE FLAT ROAD (cinatra#3281).
 *
 * THE ROAD. A multi-participant thread projects an assistant turn as flat
 * `content` beside the turn's lifecycle SLOTS and drops the ordered `parts`
 * trace; an older turn with no trace falls through the same way. There the
 * turn's prose is a SIBLING of the slot that draws the card, so the decision
 * `OrderedPartsSection` makes inside its own list — prose standing ABOVE the
 * slot that draws §VI's sentence is not drawn — could not reach it.
 *
 * WHAT WAS MEASURED BEFORE THIS FILE EXISTED, on a settled one-off on that road:
 * one prose block, and it was the model's own lead-in; no standing line at all.
 * So the defect is two-fold — the lead-in is drawn AND the drawing's own
 * sentence is missing — and both halves are measured here.
 *
 * WHAT THIS FILE MEASURES: one schedule turn on the FLAT road, driven through
 * EVERY reading `ScheduleCardReading` can take, each through the card's own
 * resolve road rather than through a stub of it. Per reading: how many prose
 * blocks the turn draws (the two hooks a prose block can wear, counted
 * together) and which sentence each one carries.
 *
 * AND THE VOCABULARY ITSELF IS READ BACK from the declaration, so a FIFTH
 * reading added later fails this file rather than passing unnoticed with no
 * row of its own.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/spent-one-off-turn-drops-the-lead-in-3281.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
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
// The run's own panel is not this file's subject — it is mocked so the lazy
// column's imports resolve, exactly as the neighbouring suites mock it.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => <div data-inline-run-card={runId} />,
}));

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { mountSurface, surfaceElement } from "./conversation-column-harness";

/**
 * SECTION VI IS QUOTED HERE RATHER THAN IMPORTED, on purpose: the words are the
 * drawing's, so a constant edited in place cannot make this file pass.
 */
const SPENT_ONE_OFF_SENTENCE =
  "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.";
const FIRED_RECURRING_SENTENCE =
  "It is still recurring, so the rows below still take a change — it applies to the runs still to come.";
const STOPPED_RECURRING_SENTENCE =
  "Pressing it stops the recurring schedule, and the rows are not editable after that.";

const RUN_ID = "7f1c9b24-5d08-4a6e-b3f1-92c4de0a5b77";
const CARD_REF = "schedule-ref-3281";

/** The model's own lead-in, exactly as a graded round recorded it. */
const MODEL_LEAD_IN = "Here's the schedule proposal.";

/** The reader's own words, above the turn. History, and never this turn's. */
const READER_REQUEST = "Run this once tomorrow at 9 in the morning.";

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

/**
 * THE RUN'S ROW, ANSWERED AND NAMING NO MOMENT. That is the reading under which
 * the turn's own carried schedule part is the run's SETTLED reading — the road
 * a spent schedule really reaches the conversation by.
 */
const RUN_PAST_SCHEDULE = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

/**
 * THE TABLE — one row per value `ScheduleCardReading` can take, with the body
 * and the fired signal that make the CARD report it through its own election,
 * and the one prose block §VI draws over it.
 */
const READINGS: readonly {
  reading: string;
  body: Record<string, unknown>;
  firedOnce: boolean;
  /** The sentence §VI gives this reading, or `null` where it gives none. */
  sentence: string | null;
}[] = [
  { reading: "spent-one-off", body: ONE_OFF_BODY, firedOnce: true, sentence: SPENT_ONE_OFF_SENTENCE },
  {
    reading: "fired-recurring",
    body: RECURRING_BODY,
    firedOnce: true,
    sentence: FIRED_RECURRING_SENTENCE,
  },
  {
    reading: "stopped-recurring",
    body: STOPPED_RECURRING_BODY,
    firedOnce: true,
    sentence: STOPPED_RECURRING_SENTENCE,
  },
  { reading: "other", body: RECURRING_BODY, firedOnce: false, sentence: null },
];

let restoreFetch: typeof globalThis.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stand a server up that answers the run's row and the card's own resolve. */
function serveReading(body: Record<string, unknown>, firedOnce: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) return jsonResponse(RUN_PAST_SCHEDULE);
    if (url === "/api/lifecycle-views/resolve") {
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

beforeEach(() => {
  restoreFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = restoreFetch;
  vi.restoreAllMocks();
});

/**
 * THE TURN AS THE FLAT ROAD CARRIES IT: prose as flat `content`, and the ONE
 * carriage that road admits — the `agent_run` lifecycle slot, with the schedule
 * view the platform wrote into the stored turn.
 */
function flatProposalTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: READER_REQUEST },
    {
      id: "a1",
      role: "assistant",
      content: MODEL_LEAD_IN,
      lifecycleParts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "queued" }),
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
 * assistant-content block the flat prose draws (`data-embed-content`) and the
 * reading's own standing line.
 */
function assistantProseBlocks(container: HTMLElement): Element[] {
  return Array.from(
    container.querySelectorAll("[data-embed-content], [data-schedule-standing-line]"),
  );
}

/** Mount the flat turn and wait for the card to settle on the reading named. */
async function mountFlatTurn(reading: string) {
  const result = await mountSurface("chat", {
    messages: flatProposalTurn(),
    slackMode: true,
  });
  await waitFor(() => {
    const card = result.container.querySelector(
      '[data-conformance-id="schedule-proposal-card"]',
    );
    if (card === null) throw new Error("the schedule card never drew on the flat road");
    if (card.getAttribute("data-schedule-reading") !== reading) {
      throw new Error(
        `the card reads "${card.getAttribute("data-schedule-reading")}", not "${reading}"`,
      );
    }
  });
  return result;
}

/**
 * WHICH READING THE CARD'S OWN ATTRIBUTE SHOWS for each reported value. The
 * card draws its own five-name reading; the turn is told the four-name one.
 */
const CARD_ATTRIBUTE: Record<string, string> = {
  "spent-one-off": "fired-one-off",
  "fired-recurring": "fired-recurring",
  // A stopped recurring schedule is still a fired one to the card's own rows.
  "stopped-recurring": "fired-recurring",
  other: "configured",
};

describe("cinatra#3281 — the flat road draws §VI's own sentence and nothing above it", () => {
  for (const row of READINGS.filter((r) => r.sentence !== null)) {
    it(`draws only the ${row.reading} sentence, and not the lead-in`, async () => {
      serveReading(row.body, row.firedOnce);
      const { container } = await mountFlatTurn(CARD_ATTRIBUTE[row.reading]!);

      // The reading is reported after mount, so the line it draws arrives a
      // tick after the card does: wait for the SETTLED turn and measure the
      // prose blocks standing with it.
      await waitFor(() => {
        const blocks = assistantProseBlocks(container);
        const settled =
          blocks.length === 1 &&
          blocks[0]!.getAttribute("data-schedule-standing-line") === row.reading;
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
      expect(blocks[0]!.getAttribute("data-schedule-standing-line")).toBe(row.reading);
      expect(blocks[0]!.textContent).toBe(row.sentence);
      // The model's own lead-in is not drawn beside the drawn sentence.
      expect(visibleText(container)).not.toContain(MODEL_LEAD_IN);
      // And the transcript's own history is untouched.
      expect(visibleText(container)).toContain(READER_REQUEST);
    }, 60_000);
  }
});

describe("cinatra#3281 — a reading with no sentence of its own keeps the lead-in", () => {
  const row = READINGS.find((r) => r.sentence === null)!;
  it(`leaves the ${row.reading} turn drawing exactly the model's own lead-in`, async () => {
    serveReading(row.body, row.firedOnce);
    const { container } = await mountFlatTurn(CARD_ATTRIBUTE[row.reading]!);

    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hasAttribute("data-schedule-standing-line")).toBe(false);
    expect(visibleText(container)).toContain(MODEL_LEAD_IN);
    expect(visibleText(container)).toContain(READER_REQUEST);
  }, 60_000);
});

/**
 * THE TABLE ABOVE IS THE WHOLE VOCABULARY, and this is what keeps it so. The
 * declaration is read from disk through a path built from THIS file's own
 * directory: a check written against `import.meta.url` dies with "The URL must
 * be of scheme file" under this runner.
 */
describe("cinatra#3281 — every reading the code can draw has a row", () => {
  it("reads the reading vocabulary back from its own declaration", () => {
    const here = path.dirname(expect.getState().testPath ?? "");
    const declaration = path.resolve(
      here,
      "../../../agents/src/lifecycle-card-runtime.tsx",
    );
    const source = readFileSync(declaration, "utf8");
    const union = source.match(/export type ScheduleCardReading =([\s\S]*?);/);
    if (union === null) {
      throw new Error(`no ScheduleCardReading declaration in ${declaration}`);
    }
    const declared = Array.from(union[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!).sort();
    expect(declared).toEqual(READINGS.map((r) => r.reading).sort());
  });
});

/**
 * AND THE ANSWER LEAVES WITH THE CARD (cinatra#3281, convergence round).
 *
 * The prose that draws the sentence is a SIBLING of the mount that reports the
 * reading, and that mount draws nothing at all once the turn carries no
 * admitted slot. So the turn can lose its card while the prose stays on the
 * screen — and prose that went on drawing a sentence for a card that is gone,
 * while still withholding the turn's own lead-in, would be a turn saying
 * something about nothing. The answer is taken back with the mount.
 */
describe("cinatra#3281 — the sentence leaves when the card does", () => {
  it("draws the lead-in again once the turn carries no slot", async () => {
    serveReading(ONE_OFF_BODY, true);
    const result = await mountFlatTurn(CARD_ATTRIBUTE["spent-one-off"]!);
    await waitFor(() => {
      const blocks = assistantProseBlocks(result.container);
      if (blocks.length !== 1 || blocks[0]!.getAttribute("data-schedule-standing-line") === null) {
        throw new Error("the standing line never drew");
      }
    });

    // THE SAME TURN, with its slot gone: the prose is the only thing left.
    const [reader, assistant] = flatProposalTurn();
    const withoutSlot = [
      reader!,
      { ...(assistant as Record<string, unknown>), lifecycleParts: [] } as unknown as UiMessage,
    ];
    result.rerender(surfaceElement("chat", { messages: withoutSlot, slackMode: true }));

    await waitFor(() => {
      const blocks = assistantProseBlocks(result.container);
      if (blocks.length !== 1 || blocks[0]!.hasAttribute("data-schedule-standing-line")) {
        throw new Error(
          `the turn draws ${blocks.length} prose blocks: ${blocks
            .map((b) => JSON.stringify(b.textContent))
            .join(" | ")}`,
        );
      }
    });
    expect(visibleText(result.container)).toContain(MODEL_LEAD_IN);
    expect(visibleText(result.container)).not.toContain(SPENT_ONE_OFF_SENTENCE);
  }, 60_000);
});
