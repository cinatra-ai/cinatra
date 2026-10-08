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
        await waitFor(() => expect(container.querySelector('[data-conformance-id="schedule-proposal-card"]')?.getAttribute("data-schedule-reading")).toBe(CARD_ATTRIBUTE[row.reading]));
        await act(async () => {});
        const prose = assistantProseBlocks(container).map(block => block.textContent);
        expect(prose).toEqual(["Earlier reply stays unchanged.", row.sentence ?? MODEL_LEAD_IN]);
        expect(container.querySelectorAll('[data-conformance-id="schedule-proposal-card"]')).toHaveLength(1);
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
  expect(assistantProseBlocks(view.container).at(-1)?.textContent).toBe(MODEL_LEAD_IN);
});
