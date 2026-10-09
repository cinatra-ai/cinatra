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
 * AND THE VOCABULARY ITSELF IS READ BACK from the declaration, so a SIXTH
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
import { act, cleanup, configure, waitFor } from "@testing-library/react";

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

// The durable projection is pure. Fail loudly if a fixture reaches SQL; this
// regression reconstructs stored turn content, never boots or queries a thread.
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: () => { throw new Error("reload regression must not execute SQL"); } }));
vi.mock("@/lib/postgres-config", () => ({ getPostgresConnectionString: () => { throw new Error("reload regression must not request a database"); }, postgresSchema: "reload_native_only" }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => { throw new Error("reload regression must not provision a database"); } }));
import { projectDurableAssistantTurn } from "../../../../src/lib/assistant-thread-store";

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
  "The recurring schedule was stopped; its rows are no longer editable.";
// Section VI gives the first shown, configured and expired readings this one sentence.
const NEVER_FIRED_SENTENCE =
  "Schedule proposal is ready. Confirm it on the card below and I will arm it; change the rows first if it is not right.";

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
  body: Record<string, unknown> | null;
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
  // `never-fired` is a schedule that has not fired — the drawing's first shown,
  // configured and expired readings. `other` is a card that resolved no body —
  // the server's `absent` answer — so it draws no card and no line.
  { reading: "never-fired", body: RECURRING_BODY, firedOnce: false, sentence: NEVER_FIRED_SENTENCE },
  { reading: "other", body: null, firedOnce: false, sentence: null },
];

let restoreFetch: typeof globalThis.fetch;
let resolveAnswers = 0;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stand a server up that answers the run's row and the card's own resolve. */
function serveReading(body: Record<string, unknown> | null, firedOnce: boolean): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) return jsonResponse(RUN_PAST_SCHEDULE);
    if (url === "/api/lifecycle-views/resolve") {
      resolveAnswers += 1;
      if (body === null) {
        return jsonResponse({ kind: "trigger_schedule_proposal", state: { state: "absent" } });
      }
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
  resolveAnswers = 0;
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
async function mountFlatTurn(reading: string | null) {
  const result = await mountSurface("chat", {
    messages: flatProposalTurn(),
    slackMode: true,
  });
  if (reading === null) {
    await waitFor(() => {
      if (resolveAnswers === 0) throw new Error("the card's resolve was never answered");
    });
    await act(async () => {});
    expect(
      result.container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]'),
    ).toHaveLength(0);
    return result;
  }
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
 * card draws its own five-name reading; the turn is told its own five-name one.
 */
const CARD_ATTRIBUTE: Record<string, string | null> = {
  "spent-one-off": "fired-one-off",
  "fired-recurring": "fired-recurring",
  // A stopped recurring schedule is still a fired one to the card's own rows.
  "stopped-recurring": "fired-recurring",
  "never-fired": "configured",
  // A card that resolved no body draws nothing, so it shows no attribute.
  other: null,
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
    const { container } = await mountFlatTurn(CARD_ATTRIBUTE[row.reading] ?? null);

    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hasAttribute("data-schedule-standing-line")).toBe(false);
    expect(visibleText(container)).toContain(MODEL_LEAD_IN);
    expect(visibleText(container)).toContain(READER_REQUEST);
    // No schedule card is drawn for a card that resolved no body.
    expect(
      container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]'),
    ).toHaveLength(0);
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


it("keeps one flat proposal turn through first-shown, configured and spent readings", async () => {
  // Only the server answer changes. Focus is the shipped re-read signal;
  // neither the conversation nor its message is remounted between readings.
  // The run row names the SAME schedule while its proposal is pending and
  // armed. A running row with no moment instead elects the carried view into
  // a different, settled mount; it is not a pending-proposal fixture.
  let runReading = {
    ...RUN_PAST_SCHEDULE,
    status: "pending_trigger",
    lifecycleMoment: "schedule" as string | null,
    lifecycleCard: { kind: "trigger_schedule_proposal", ref: CARD_REF } as {
      kind: string;
      ref: string;
    } | null,
  };
  let envelope: Record<string, unknown> = {
    kind: "trigger_schedule_proposal",
    state: { state: "pending", canDecide: true, canComment: true },
    body: {
      phase: "proposal", version: 1, agentName: "Q3 cohort sweep",
      schedule: { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "Europe/Berlin" },
      durationCopy: null, canConfirm: true, restrictedReason: null, runPending: true,
    },
    firedOnce: false,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) return jsonResponse(runReading);
    if (url === "/api/lifecycle-views/resolve") return jsonResponse(envelope);
    return jsonResponse({}, 404);
  }) as typeof fetch;
  const { container } = await mountSurface("chat", { messages: flatProposalTurn(), slackMode: true });
  const cardSelector = '[data-conformance-id="schedule-proposal-card"]';
  const assertReading = async (reading: string, sentence: string) => {
    // All readings must belong to ONE mounted DOM state. Waiting for the
    // card, then the prose separately could accept two sides of a remount.
    await waitFor(() => {
      expect(container.querySelector(cardSelector)?.getAttribute("data-schedule-reading")).toBe(reading);
      const blocks = assistantProseBlocks(container);
      expect(blocks).toHaveLength(1);
      expect(visibleText(blocks[0])).toBe(sentence);
      expect(container.querySelectorAll(cardSelector)).toHaveLength(1);
      expect(container.textContent).toContain(READER_REQUEST);
    });
  };
  await assertReading("first-shown", MODEL_LEAD_IN);
  envelope = {
    kind: "trigger_schedule_proposal", state: { state: "settled" },
    body: { ...ONE_OFF_BODY, released: false }, firedOnce: false,
  };
  runReading = { ...runReading, status: "armed" };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await assertReading("configured", MODEL_LEAD_IN);
  envelope = {
    kind: "trigger_schedule_proposal", state: { state: "settled" },
    body: ONE_OFF_BODY, firedOnce: true,
  };
  runReading = { ...RUN_PAST_SCHEDULE };
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await assertReading("fired-one-off", SPENT_ONE_OFF_SENTENCE);
  expect(container.textContent).not.toContain(MODEL_LEAD_IN);
});


const SECOND_SCHEDULE_RUN = "be7c9b24-5d08-4a6e-b3f1-92c4de0a5b77";
const SECOND_SCHEDULE_REF = "schedule-ref-second-3281";

async function mountTwoFlatScheduleSlots(firstResponse: "one-off" | "recurring") {
  let releaseLater!: () => void;
  const laterResponse = new Promise<void>((resolve) => { releaseLater = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) return jsonResponse(RUN_PAST_SCHEDULE);
    if (url === "/api/lifecycle-views/resolve") {
      const request = JSON.parse(String(init?.body)) as { ref: string };
      const oneOff = request.ref === CARD_REF;
      if (!oneOff && request.ref !== SECOND_SCHEDULE_REF) return jsonResponse({}, 404);
      if (oneOff !== (firstResponse === "one-off")) await laterResponse;
      return jsonResponse({
        kind: "trigger_schedule_proposal", state: { state: "settled" },
        body: oneOff ? ONE_OFF_BODY : { ...RECURRING_BODY, runId: SECOND_SCHEDULE_RUN },
        firedOnce: true,
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  const messages = flatProposalTurn();
  const assistant = messages[1] as unknown as { lifecycleParts: Array<Record<string, unknown>> };
  assistant.lifecycleParts.push({
    kind: "tool_call", id: "second-flat-schedule", name: "agent_run", status: "completed",
    runId: SECOND_SCHEDULE_RUN,
    result: JSON.stringify({ runId: SECOND_SCHEDULE_RUN, status: "queued" }),
    views: [{ viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: SECOND_SCHEDULE_REF }],
  });
  const view = await mountSurface("chat", { messages, slackMode: true });
  await waitFor(() => {
    const blocks = assistantProseBlocks(view.container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(firstResponse === "one-off" ? SPENT_ONE_OFF_SENTENCE : FIRED_RECURRING_SENTENCE);
  });
  await act(async () => { releaseLater(); });
  await waitFor(() => {
    const cards = Array.from(view.container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]'));
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.getAttribute("data-schedule-reading"))).toEqual(["fired-one-off", "fired-recurring"]);
  });
  return { ...view, messages, assistant };
}

it.each(["one-off", "recurring"] as const)(
  "elects the first flat schedule slot when %s resolves first",
  async (firstResponse) => {
    const { container } = await mountTwoFlatScheduleSlots(firstResponse);
    await waitFor(() => {
      const blocks = assistantProseBlocks(container);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.textContent).toBe(SPENT_ONE_OFF_SENTENCE);
      expect(blocks[0]?.getAttribute("data-schedule-standing-line")).toBe("spent-one-off");
    });
    expect(container.textContent).not.toContain(MODEL_LEAD_IN);
  },
);

it("follows reordered flat schedule slots and withdraws the removed slot's reading", async () => {
  const { container, rerender, messages, assistant } = await mountTwoFlatScheduleSlots("one-off");
  assistant.lifecycleParts = [...assistant.lifecycleParts].reverse();
  rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => {
    const cards = Array.from(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]'));
    expect(cards.map((card) => card.getAttribute("data-schedule-reading"))).toEqual(["fired-recurring", "fired-one-off"]);
    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(FIRED_RECURRING_SENTENCE);
  });
  assistant.lifecycleParts = assistant.lifecycleParts.slice(1);
  rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => {
    expect(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(1);
    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(SPENT_ONE_OFF_SENTENCE);
  });
  assistant.lifecycleParts = [];
  rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => {
    expect(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(0);
    const blocks = assistantProseBlocks(container);
    expect(blocks).toHaveLength(1);
    expect(visibleText(blocks[0]!)).toBe(MODEL_LEAD_IN);
    expect(container.querySelector("[data-schedule-standing-line]")).toBeNull();
  });
});


/** Rebuild the server's legitimate turn-level fallback, not a copied renderer. */
function reloadedProposalTurn(ordered: boolean): UiMessage[] {
  const projected = projectDurableAssistantTurn("reload-a1", {
    format: "assistant-turn-v1",
    content: MODEL_LEAD_IN,
    ...(ordered ? { parts: [{ type: "text", text: MODEL_LEAD_IN }] } : {}),
    dataParts: [{ viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: CARD_REF }],
    // A missing producing call is the documented durable turn-level fallback.
    dataPartSlots: ["call-that-is-absent-from-this-saved-trace"],
  });
  expect(projected).not.toBeNull();
  expect(projected!.dataParts).toHaveLength(1);
  expect(projected!.content).toBe(MODEL_LEAD_IN);
  return [
    { id: "reload-u1", role: "user", content: READER_REQUEST },
    { id: "reload-history", role: "assistant", content: "Earlier reply stays unchanged." },
    projected as unknown as UiMessage,
  ];
}

describe("cinatra#3281 — durable reload keeps the card's standing reading", () => {
  for (const road of ["flat", "slack", "ordered"] as const) {
    for (const row of READINGS) {
      it(`${road} reload preserves the ${row.reading} reading without restoring the lead-in`, async () => {
        serveReading(row.body, row.firedOnce);
        const messages = reloadedProposalTurn(road === "ordered");
        const { container } = await mountSurface("chat", { messages, slackMode: road === "slack" });
        const attribute = CARD_ATTRIBUTE[row.reading] ?? null;
        if (attribute !== null) {
          await waitFor(() => expect(container.querySelector('[data-conformance-id="schedule-proposal-card"]')?.getAttribute("data-schedule-reading")).toBe(attribute));
        } else {
          await waitFor(() => expect(resolveAnswers).toBeGreaterThan(0));
          await act(async () => {});
        }
        await act(async () => {});
        const prose = assistantProseBlocks(container).map(block => block.textContent);
        expect(prose).toEqual(["Earlier reply stays unchanged.", row.sentence ?? MODEL_LEAD_IN]);
        expect(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(CARD_ATTRIBUTE[row.reading] === null ? 0 : 1);
        expect(visibleText(container)).toContain(READER_REQUEST);
        if (row.sentence !== null) expect(visibleText(container)).not.toContain(MODEL_LEAD_IN);
        // Rendering the current reading never rewrites what was persisted.
        expect(messages[2]!.content).toBe(MODEL_LEAD_IN);
      });
    }
  }

  it("restores the durable turn's lead-in when its turn-level card is withdrawn", async () => {
    serveReading(ONE_OFF_BODY, true);
    const messages = reloadedProposalTurn(false);
    const view = await mountSurface("chat", { messages, slackMode: true });
    await waitFor(() => expect(assistantProseBlocks(view.container).map(block => block.textContent)).toEqual(["Earlier reply stays unchanged.", SPENT_ONE_OFF_SENTENCE]));
    const withdrawn = messages.map(message => message.id === "reload-a1" ? { ...message, dataParts: [] } : message);
    view.rerender(surfaceElement("chat", { messages: withdrawn, slackMode: true }));
    await waitFor(() => expect(assistantProseBlocks(view.container).map(block => block.textContent)).toEqual(["Earlier reply stays unchanged.", MODEL_LEAD_IN]));
    expect(view.container.querySelector('[data-conformance-id="schedule-proposal-card"]')).toBeNull();
  });
});


it("preserves a durable known producing slot and its later prose", async () => {
  serveReading(ONE_OFF_BODY, true);
  const projected = projectDurableAssistantTurn("known-slot-reload", {
    format: "assistant-turn-v1", content: MODEL_LEAD_IN,
    parts: [
      { type: "text", text: MODEL_LEAD_IN },
      { type: "tool_call", id: "saved-schedule-call", name: "schedule_proposal" },
      { type: "tool_result", id: "saved-schedule-call" },
      { type: "text", text: "Later explanation is still visible." },
    ],
    dataParts: [{ viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: CARD_REF }],
    dataPartSlots: ["saved-schedule-call"],
  });
  expect(projected!.dataParts).toBeUndefined();
  const { container } = await mountSurface("chat", { messages: [projected as unknown as UiMessage] });
  await waitFor(() => expect(assistantProseBlocks(container).map(block => block.textContent?.trim())).toEqual([SPENT_ONE_OFF_SENTENCE, "Later explanation is still visible."]));
  expect(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(1);
});

it.each(["one-off", "recurring"] as const)("elects turn-level cards in displayed order when %s resolves first", async (firstResponse) => {
  let releaseLater!: () => void;
  const later = new Promise<void>(resolve => { releaseLater = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/lifecycle-views/resolve") {
      const { ref } = JSON.parse(String(init?.body)) as { ref: string };
      const oneOff = ref === CARD_REF;
      if (oneOff !== (firstResponse === "one-off")) await later;
      return jsonResponse({ kind: "trigger_schedule_proposal", state: { state: "settled" }, body: oneOff ? ONE_OFF_BODY : { ...RECURRING_BODY, runId: SECOND_SCHEDULE_RUN }, firedOnce: true });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;
  const messages = reloadedProposalTurn(false);
  const current = messages[2]!;
  current.dataParts = [...current.dataParts!, { viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: SECOND_SCHEDULE_REF }];
  const view = await mountSurface("chat", { messages, slackMode: true });
  await waitFor(() => expect(assistantProseBlocks(view.container).at(-1)?.textContent).toBe(firstResponse === "one-off" ? SPENT_ONE_OFF_SENTENCE : FIRED_RECURRING_SENTENCE));
  await act(async () => { releaseLater(); });
  await waitFor(() => expect(Array.from(view.container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).map(card => card.getAttribute("data-schedule-reading"))).toEqual(["fired-one-off", "fired-recurring"]));
  await waitFor(() => expect(assistantProseBlocks(view.container).map(block => block.textContent)).toEqual(["Earlier reply stays unchanged.", SPENT_ONE_OFF_SENTENCE]));
  current.dataParts = [...current.dataParts!].reverse();
  view.rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => expect(assistantProseBlocks(view.container).map(block => block.textContent)).toEqual(["Earlier reply stays unchanged.", FIRED_RECURRING_SENTENCE]));
  current.dataParts = current.dataParts.slice(1);
  view.rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => expect(assistantProseBlocks(view.container).map(block => block.textContent)).toEqual(["Earlier reply stays unchanged.", SPENT_ONE_OFF_SENTENCE]));
  expect(view.container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(1);
});

it("withdraws the old reading while a replacement reference resolves", async () => {
  serveReading(ONE_OFF_BODY, true);
  const messages = reloadedProposalTurn(false);
  const view = await mountSurface("chat", { messages, slackMode: true });
  await waitFor(() => expect(assistantProseBlocks(view.container).at(-1)?.textContent).toBe(SPENT_ONE_OFF_SENTENCE));
  let releaseReplacement!: () => void;
  const replacement = new Promise<void>(resolve => { releaseReplacement = resolve; });
  globalThis.fetch = (async () => {
    await replacement;
    return jsonResponse({ kind: "trigger_schedule_proposal", state: { state: "settled" }, body: RECURRING_BODY, firedOnce: false });
  }) as typeof fetch;
  messages[2]!.dataParts = [{ viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: "replacement-ref-3281" }];
  view.rerender(surfaceElement("chat", { messages, slackMode: true }));
  await waitFor(() => {
    expect(view.container.querySelector('[data-schedule-standing-line]')).toBeNull();
    expect(assistantProseBlocks(view.container).at(-1)?.textContent).toBe(MODEL_LEAD_IN);
  });
  await act(async () => { releaseReplacement(); });
  await waitFor(() => expect(view.container.querySelector('[data-conformance-id="schedule-proposal-card"]')?.getAttribute("data-schedule-reading")).toBe("configured"));
  // The replacement resolves a configured schedule that has not fired, which
  // section VI gives the proposal sentence; the lead-in stands only while
  // nothing has resolved, which the wait above still pins.
  await waitFor(() => { const last = assistantProseBlocks(view.container).at(-1); expect(last?.textContent).toBe(NEVER_FIRED_SENTENCE); expect(last?.getAttribute("data-schedule-standing-line")).toBe("never-fired"); });
});

describe("cinatra#3281 — the line stands where section VI draws it, 8 px above its card", () => {
  /**
   * THE DRAWING. Section VI's "a one-off schedule that has fired" draws the
   * turn as a flex column with a 6 px gap (`.turn { display: flex;
   * flex-direction: column; gap: 6px; }`) and the line as
   * `<div class="prose" style="margin-bottom:2px;">` directly above the card's
   * slot. A flex column's margins never collapse, so the line's foot stands
   * 6 + 2 = 8 px above the card's top border.
   *
   * THE INSTRUMENT. jsdom lays nothing out, so the distance is RESOLVED from
   * the utility tokens the rendered nodes carry, the way the run page's rail
   * rhythm suite resolves its pitch: every box on the path from the line's
   * foot to the card's top border is read for its margins, paddings, borders
   * and gaps, and the margins that adjoin are collapsed the way the stylesheet
   * would collapse them. Anything the instrument cannot read on that path
   * throws, rather than reading as a distance.
   */
  const LINE = '[data-schedule-standing-line="spent-one-off"]';
  const CARD = '[data-conformance-id="schedule-proposal-card"]';
  const MESSAGE =
    "the spent line's foot stands this far above its card; section VI draws 8 px (the turn's 6 px gap plus the line's 2 px margin)";

  /** The spacing scale, in px. */
  const SCALE: Record<string, number> = {
    "0": 0, px: 1, "0.5": 2, "1": 4, "1.5": 6, "2": 8, "2.5": 10, "3": 12, "4": 16, "5": 20, "6": 24, "8": 32,
  };
  /** The frames are 1440 px wide: these breakpoints apply, `2xl:` does not. */
  const COUNTED_VARIANTS = ["sm", "md", "lg", "xl"];
  const IGNORED_VARIANTS = ["2xl"];
  /** Every utility this instrument reads as vertical spacing. */
  const SPACING_UTILITY =
    /^(?:(?:m|mt|mb|my|p|pt|pb|py|space-y)-|gap-(?!x-)|border(?:-[tby])?(?:-(?:0|2|4|\[\d+(?:\.\d+)?px\]))?$)/;
  const DISPLAYS = new Set([
    "block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "flow-root", "contents", "hidden",
  ]);
  const DIRECTIONS = new Set(["flex-col", "flex-row", "flex-col-reverse", "flex-row-reverse"]);
  const POSITIONS = new Set(["static", "relative", "absolute", "fixed", "sticky"]);

  type Token = { utility: string; raw: string; important: boolean; negative: boolean; tier: number; index: number };
  type Step = { kind: "margin" | "separator"; px: number };

  /** Split a class token on its variant colons, never inside an arbitrary `[...]`. */
  function splitVariants(raw: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of raw) {
      if (ch === "[") depth += 1;
      if (ch === "]") depth -= 1;
      if (ch === ":" && depth === 0) {
        parts.push(current);
        current = "";
      } else current += ch;
    }
    parts.push(current);
    return parts;
  }

  /** The element's tokens that apply in a 1440 px frame, in stylesheet order. */
  function tokensOf(el: Element): Token[] {
    const out: Token[] = [];
    (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).forEach((raw, index) => {
      const parts = splitVariants(raw);
      let utility = parts.pop()!;
      let important = false;
      if (utility.startsWith("!")) {
        important = true;
        utility = utility.slice(1);
      }
      if (utility.endsWith("!")) {
        important = true;
        utility = utility.slice(0, -1);
      }
      const negative = utility.startsWith("-");
      if (negative) utility = utility.slice(1);
      if (parts.some((variant) => IGNORED_VARIANTS.includes(variant))) return;
      if (parts.some((variant) => !COUNTED_VARIANTS.includes(variant))) {
        if (SPACING_UTILITY.test(utility)) throw new Error(`an unread variant on the path: ${raw}`);
        return;
      }
      const tier = Math.max(0, ...parts.map((variant) => COUNTED_VARIANTS.indexOf(variant) + 1));
      out.push({ utility, raw, important, negative, tier, index });
    });
    return out;
  }

  /** Lexicographic rank: true when `a` outranks `b`. */
  function outranks(a: readonly number[], b: readonly number[]): boolean {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i]! !== b[i]!) return a[i]! > b[i]!;
    }
    return false;
  }

  /**
   * The token that wins among `families` (ordered from the least to the most
   * specific, as the stylesheet orders them): an `!` token outright, then a
   * later breakpoint, then the more specific family, then the later token.
   */
  function winner(el: Element, families: readonly string[], pattern: RegExp): { token: Token; value: string | undefined } | null {
    let best: { token: Token; value: string | undefined; rank: number[] } | null = null;
    for (const token of tokensOf(el)) {
      const m = token.utility.match(pattern);
      if (!m) continue;
      const family = families.indexOf(m[1]!);
      if (family < 0) continue;
      const rank = [token.important ? 1 : 0, token.tier, family, token.index];
      if (best === null || outranks(rank, best.rank)) best = { token, value: m[2], rank };
    }
    return best;
  }

  function scaled(token: Token, value: string): number {
    const arbitrary = value.match(/^\[(-?\d+(?:\.\d+)?)px\]$/);
    const px = arbitrary ? Number(arbitrary[1]) : SCALE[value];
    if (px === undefined) throw new Error(`an unread spacing value on the path: ${token.raw}`);
    return token.negative ? -px : px;
  }

  function spacing(el: Element, families: readonly string[]): number {
    // `gap-x-*` and `space-y-reverse` are not vertical lengths.
    const alternatives = [...families].sort((a, b) => b.length - a.length).join("|");
    const pattern = new RegExp(`^(${alternatives})-(?!x-|reverse$)(.+)$`);
    const won = winner(el, families, pattern);
    return won ? scaled(won.token, won.value!) : 0;
  }

  function border(el: Element, families: readonly string[]): number {
    const won = winner(el, families, /^(border|border-[tby])(?:-(0|2|4|\[\d+(?:\.\d+)?px\]))?$/);
    if (!won) return 0;
    if (won.value === undefined) return 1;
    return scaled(won.token, won.value);
  }

  /** The keyword utility of one property that wins (a display, a direction, a position). */
  function keyword(el: Element, words: ReadonlySet<string>): string | null {
    let best: { token: Token; rank: number[] } | null = null;
    for (const token of tokensOf(el)) {
      if (!words.has(token.utility)) continue;
      const rank = [token.important ? 1 : 0, token.tier, token.index];
      if (best === null || outranks(rank, best.rank)) best = { token, rank };
    }
    return best?.token.utility ?? null;
  }

  const display = (el: Element) => keyword(el, DISPLAYS);
  const isFlex = (el: Element | null) => el !== null && ["flex", "inline-flex"].includes(display(el) ?? "");
  const isGrid = (el: Element | null) => el !== null && ["grid", "inline-grid"].includes(display(el) ?? "");
  const isColumn = (el: Element) => keyword(el, DIRECTIONS) === "flex-col";

  function skipped(el: Element): boolean {
    return (
      el.hasAttribute("hidden") ||
      display(el) === "hidden" ||
      /(?:^|;)\s*display\s*:\s*none/i.test(el.getAttribute("style") ?? "")
    );
  }

  function skippedNode(node: Node): boolean {
    if (node.nodeType === 3) return (node.textContent ?? "").trim() === "";
    if (node.nodeType !== 1) return true;
    return skipped(node as Element);
  }

  /** A node's own markup, for a throw to name what it found. */
  function shown(node: Node): string {
    return (node.nodeType === 1 ? (node as Element).outerHTML : node.textContent ?? "").slice(0, 120);
  }

  /** A box that is a formatting context of its own keeps its children's margins inside it. */
  function ownContext(el: Element): boolean {
    if (display(el) === "contents") throw new Error(`an unread display on the path: ${shown(el)}`);
    if (isFlex(el) || isGrid(el) || isFlex(el.parentElement) || isGrid(el.parentElement)) return true;
    if (["flow-root", "inline-block"].includes(display(el) ?? "")) return true;
    const tokens = tokensOf(el).map((token) => token.utility);
    if (tokens.some((t) => /^overflow(?:-[xy])?-(?:hidden|auto|scroll|clip)$/.test(t))) return true;
    return ["absolute", "fixed"].includes(keyword(el, POSITIONS) ?? "");
  }

  /** It DRAWS when it holds text or a drawn control, or carries a size, a padding or a border. */
  function draws(el: Element): boolean {
    if (skipped(el)) return false;
    if (["IMG", "SVG", "INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(el.tagName.toUpperCase())) return true;
    const own = tokensOf(el).some((token) => {
      const m = token.utility.match(/^(?:h|min-h|size|p|pt|pb|py)-(.+)$/);
      if (m) return m[1] !== "0";
      const b = token.utility.match(/^border(?:-[tby])?(?:-(.+))?$/);
      return b !== null && b[1] !== "0" && (b[1] === undefined || /^(?:2|4|\[\d+(?:\.\d+)?px\])$/.test(b[1]));
    });
    if (own) return true;
    return Array.from(el.childNodes).some((node) =>
      node.nodeType === 3 ? (node.textContent ?? "").trim() !== "" : node.nodeType === 1 && draws(node as Element),
    );
  }

  function laterChild(el: Element): boolean {
    const parent = el.parentElement;
    if (parent === null) return false;
    const drawn = Array.from(parent.children).filter((child) => !skipped(child));
    return drawn.indexOf(el) > 0;
  }

  function marginTop(el: Element): number {
    const space = el.parentElement ? spacing(el.parentElement, ["space-y"]) : 0;
    if (space !== 0 && laterChild(el)) return space;
    return spacing(el, ["m", "my", "mt"]);
  }
  const marginBottom = (el: Element) => spacing(el, ["m", "my", "mb"]);
  const paddingTop = (el: Element) => spacing(el, ["p", "py", "pt"]);
  const paddingBottom = (el: Element) => spacing(el, ["p", "py", "pb"]);
  const borderTop = (el: Element) => border(el, ["border", "border-y", "border-t"]);
  const borderBottom = (el: Element) => border(el, ["border", "border-y", "border-b"]);
  const rowGap = (el: Element) => spacing(el, ["gap", "gap-y"]);

  function lineFootToCardTop(line: Element, card: Element): number {
    let common: Element | null = line.parentElement;
    while (common !== null && !common.contains(card)) common = common.parentElement;
    if (common === null || line.contains(card) || card.contains(line)) {
      throw new Error("the line and the card share no box the instrument can read");
    }
    if (!(line.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      throw new Error("the card does not stand below the line");
    }
    const up: Element[] = [];
    for (let el: Element | null = line; el !== common; el = el!.parentElement) up.push(el!);
    const down: Element[] = [];
    for (let el: Element | null = card; el !== common; el = el!.parentElement) down.unshift(el!);

    const steps: Step[] = [];
    const margin = (px: number) => steps.push({ kind: "margin", px });
    const separator = (px: number) => steps.push({ kind: "separator", px });

    // From the line up to the common box's child that holds it.
    up.forEach((el, i) => {
      if (i > 0) {
        const child = up[i - 1]!;
        const nodes = Array.from(el.childNodes);
        const below = nodes.slice(nodes.indexOf(child) + 1).find((node) => !skippedNode(node));
        if (below) throw new Error(`something stands below the line inside its own box: ${shown(below)}`);
        if (ownContext(el)) separator(0);
        if (paddingBottom(el) !== 0) separator(paddingBottom(el));
        if (borderBottom(el) !== 0) separator(borderBottom(el));
      }
      margin(marginBottom(el));
    });

    // Between the common box's two children.
    const flow = isFlex(common) || isGrid(common);
    if (isFlex(common) && !isColumn(common)) {
      throw new Error(`the line and the card stand side by side: ${shown(common)}`);
    }
    const gap = flow ? rowGap(common) : 0;
    const nodes = Array.from(common.childNodes);
    const between = nodes.slice(nodes.indexOf(up[up.length - 1]!) + 1, nodes.indexOf(down[0]!));
    for (const node of between) {
      if (skippedNode(node)) continue;
      if (node.nodeType !== 1 || draws(node as Element)) {
        throw new Error(`something draws between the line and the card: ${shown(node)}`);
      }
      const empty = node as Element;
      if (flow) separator(gap);
      margin(marginTop(empty));
      if (flow || ownContext(empty)) separator(0);
      margin(marginBottom(empty));
    }
    if (flow) separator(gap);

    // From the common box's child that holds the card down to the card.
    down.forEach((el, j) => {
      if (j > 0) {
        const parent = down[j - 1]!;
        const siblings = Array.from(parent.childNodes);
        const above = siblings.slice(0, siblings.indexOf(el)).find((node) => !skippedNode(node));
        if (above) throw new Error(`something stands above the card inside its own box: ${shown(above)}`);
        if (ownContext(parent)) separator(0);
        if (borderTop(parent) !== 0) separator(borderTop(parent));
        if (paddingTop(parent) !== 0) separator(paddingTop(parent));
      }
      margin(marginTop(el));
    });

    // Adjoining margins collapse to the largest positive plus the most negative.
    let total = 0;
    let run: number[] = [];
    const close = () => {
      total += Math.max(0, ...run) + Math.min(0, ...run);
      run = [];
    };
    for (const step of steps) {
      if (step.kind === "margin") run.push(step.px);
      else {
        close();
        total += step.px;
      }
    }
    close();
    return total;
  }

  /** A detached fixture: the line is its `p`, the card the box whose own text is `K`. */
  function fixture(html: string): { line: Element; card: Element } {
    const root = document.createElement("div");
    root.innerHTML = html;
    const line = root.querySelector("p")!;
    const card = Array.from(root.querySelectorAll("*")).find(
      (el) => el.childElementCount === 0 && el.textContent === "K",
    )!;
    return { line, card };
  }

  const read = (html: string) => {
    const { line, card } = fixture(html);
    return lineFootToCardTop(line, card);
  };

  it("the instrument reads the drawing's composition and the margin rules", () => {
    // Two block margins collapse.
    expect(read('<div><p class="mb-0.5">L</p><div class="my-3">K</div></div>')).toBe(12);
    // The drawing's own turn: a 6 px gap and the line's 2 px margin.
    expect(read('<div class="flex flex-col gap-1.5"><p class="mb-0.5">L</p><div>K</div></div>')).toBe(8);
    // The head's reloaded column: the card's margin stays inside it.
    expect(read('<div><p>L</p><div class="flex flex-col gap-2"><div class="my-3">K</div></div></div>')).toBe(12);
    expect(read('<div><p class="-mb-1">L</p><div class="flex flex-col gap-2"><div class="my-3">K</div></div></div>')).toBe(8);
    // Collapse through a plain block.
    expect(read('<div><p class="-mb-1">L</p><div><div class="my-3">K</div></div></div>')).toBe(8);
    expect(() => read('<div><p>L</p> <span>x</span><div class="my-3">K</div></div>')).toThrow(
      "something draws between the line and the card",
    );
    // The walk reads downward only: a card above the line is no reading.
    expect(() => read('<div><div class="my-3">K</div><p class="-mb-1">L</p></div>')).toThrow(
      "the card does not stand below the line",
    );
  });

  function theOne(container: HTMLElement): { line: Element; card: Element } {
    expect(container.querySelectorAll(LINE)).toHaveLength(1);
    expect(container.querySelectorAll(CARD)).toHaveLength(1);
    return { line: container.querySelector(LINE)!, card: container.querySelector(CARD)! };
  }

  it("the live flat turn (the round's live cell)", async () => {
    serveReading(ONE_OFF_BODY, true);
    const { container } = await mountFlatTurn("fired-one-off");
    await waitFor(() => expect(container.querySelector(LINE)).not.toBeNull());
    const { line, card } = theOne(container);
    expect(lineFootToCardTop(line, card), MESSAGE).toBe(8);
  });

  for (const [title, ordered, slackMode] of [
    ["after a reload, the flat road in the Slack layout (the round's reloaded cell)", false, true],
    ["after a reload, the flat road in the plain layout", false, false],
    ["after a reload, the ordered road", true, false],
  ] as const) {
    it(title, async () => {
      serveReading(ONE_OFF_BODY, true);
      const messages = reloadedProposalTurn(ordered);
      const { container } = await mountSurface("chat", { messages, slackMode });
      await waitFor(() => expect(container.querySelector(CARD)?.getAttribute("data-schedule-reading")).toBe("fired-one-off"));
      await waitFor(() => expect(container.querySelector(LINE)).not.toBeNull());
      const { line, card } = theOne(container);
      expect(lineFootToCardTop(line, card), MESSAGE).toBe(8);
    });
  }
});
