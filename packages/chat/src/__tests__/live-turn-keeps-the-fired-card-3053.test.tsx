// @vitest-environment jsdom
/**
 * THE LIVE CONVERSATION KEEPS THE FIRED ONE-OFF'S READING (cinatra#3044).
 *
 * The previous leg closed the RELOADED road: a turn whose stored content
 * carries the platform-injected schedule part draws the settled reading beside
 * the run's next screen. A graded set then measured the OTHER road and found it
 * still open — after the one-off fires, the LIVE conversation holds ZERO
 * schedule cards while the durable turn rows carry the part in the same
 * instant, and the run's own screens take the card's place.
 *
 * WHAT MAKES A TURN "LIVE" HERE, AND WHY IT IS NOT A SUBSTITUTE SEAM. The tab
 * that STREAMED the turn built it by folding the real AG-UI wire through the
 * shipped reducer and projecting the result onto the message the transcript
 * draws. Nothing in this file hand-writes a part: the turn under test is
 * `projectConversationMessage(reduceAgUiEvents(events))` over the event
 * sequence a chat dispatch really emits, mounted in the real conversation
 * column on both hosts. The difference that matters falls out of that fold on
 * its own — the platform writes the schedule part into the STORED turn after
 * the stream has ended, so the streamed turn carries no such part and never
 * will. A test that handed the column a part it could not have had would be
 * measuring the reloaded road a second time.
 *
 * THE DRAWING. Section VI, fifth reading:
 *
 *   "Once it has fired, the card is a reading. A one-off that has fired cannot
 *    be changed, so the rows go read-only -- the values still legible, the
 *    pickers gone -- and the card carries no floor at all: no hairline, no
 *    button, nothing to press. A spent schedule is still worth reading, so
 *    nothing is hidden; it simply asks nothing."
 *
 * and the line the drawing's own example puts over that reading:
 *
 *   "It ran at the time you set. A one-time schedule is spent once it fires, so
 *    the rows below are the record of it and cannot be changed."
 *
 * BOTH ARMS OF THE ONE COLUMN. `/chat` and the third-party application share
 * this container, so every property is measured on both hosts.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/live-turn-keeps-the-fired-card-3053.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer this column mounts reads `window.localStorage` on mount. jsdom
// under Node 25 exposes the property without its methods, which throws before
// any assertion here runs. Installed ONLY when the environment is missing it.
if (typeof globalThis.window !== "undefined" &&
    typeof window.localStorage?.getItem !== "function") {
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

const RUN_ID = "b6c2b0f4-52a3-4d7e-9c31-7a2b1f0e5d84";
const SECOND_RUN_ID = "0f4c9a71-3e58-46b2-8d0a-91c7b2e46f3d";
const CARD_REF = "sched-live-ref-3053";
const SECOND_CARD_REF = "sched-live-ref-3053-second";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

// The transcript's §V card answers "nothing to draw", so this file measures the
// schedule moment and the run's own next screen alone.
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
// THE RUN'S OWN NEXT SCREEN, made drivable. The graded set measured
// `agent_hitl_screen` roots standing where the schedule card should have been,
// so the screen is not stubbed away here — it is moved, exactly as the run
// moves it, and the card has to keep its own place beside it.
const hitlReading = { current: { state: "none" } as Record<string, unknown> };
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => hitlReading.current,
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
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-inline-run-card={runId}>
      <h2>Agentic Run Progress</h2>
    </div>
  ),
}));

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import { reduceAgUiEvents } from "../renderer/ag-ui-reducer";
import { projectConversationMessage } from "../ag-ui-chat-client";
import { describeStartedRun } from "@cinatra-ai/agents/run-status";
import {
  installWidgetServiceStub,
  mountSurface,
} from "./conversation-column-harness";

// ---------------------------------------------------------------------------
// THE TURN, BUILT THE WAY THE STREAM BUILDS IT
// ---------------------------------------------------------------------------

/**
 * The AG-UI events a chat dispatch really emits, in order: the tool call that
 * started the agent, its end, the `agent_run` DATA_PART that pins the runId
 * (the reducer contract forbids taking it off TOOL_CALL_END), and the
 * platform's own sentence as streamed text.
 *
 * NO SCHEDULE PART IS EMITTED, and that is not an omission — it is the road.
 * The schedule moment opens in the executor after the stream has closed, and
 * the part the platform writes then lands in the STORED turn, which this tab's
 * copy is not.
 */
function dispatchEvents(runId: string, toolCallId: string, messageId: string): AgUiEvent[] {
  const sentence = describeStartedRun({
    packageName: PACKAGE,
    runId,
    status: "queued",
  });
  return [
    { type: "RUN_STARTED", threadId: "thread-live-3053", runId: `agui-${runId}` },
    { type: "TOOL_CALL_START", toolCallId, toolCallName: "agent_run" },
    { type: "TOOL_CALL_END", toolCallId },
    { type: "DATA_PART", data: { kind: "agent_run", toolCallId, runId } },
    { type: "TEXT_MESSAGE_START", messageId },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: sentence },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId: "thread-live-3053", runId: `agui-${runId}` },
  ] as AgUiEvent[];
}

/** One streamed assistant turn, folded and projected by the shipped seam. */
function streamedTurn(runId: string, id: string): UiMessage {
  return projectConversationMessage(
    reduceAgUiEvents(dispatchEvents(runId, `call-${id}`, `msg-${id}`)),
    { assistantId: id },
  );
}

function liveThread(runIds: readonly string[]): UiMessage[] {
  const turns: UiMessage[] = [
    { id: "u1", role: "user", content: "run the blog draft writer for me once, tonight at nine" },
  ];
  runIds.forEach((runId, i) => {
    turns.push(streamedTurn(runId, `a${i + 1}`));
  });
  return turns;
}

// ---------------------------------------------------------------------------
// The run's own reading, as the run route answers it
// ---------------------------------------------------------------------------

const RUN_WORKING = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

function runAtSchedule(ref: string) {
  return {
    status: "pending_trigger",
    error: null,
    messages: [],
    lifecycleMoment: "schedule",
    lifecycleCard: { kind: "trigger_schedule_proposal", ref },
  };
}

/**
 * THE RUN WITH THE ANSWER ALREADY GIVEN, WAITING FOR THE INSTANT (cinatra#3044).
 *
 * "Schedule for later" does not go from the card straight to the work: the
 * confirm arms the run, and it stands at `armed` — still stating the schedule
 * moment, still naming the card — until the release job fires it. That is the
 * road the drawing's own fired example is drawn on ("Run this once on 14 July
 * at 9 in the morning"), and the surface has to keep watching across it or it
 * can never learn the schedule was spent.
 */
function runArmedAtSchedule(ref: string) {
  return {
    status: "armed",
    error: null,
    messages: [],
    lifecycleMoment: "schedule",
    lifecycleCard: { kind: "trigger_schedule_proposal", ref },
  };
}

/** The run AFTER the one-off fired: it moved on, and its row names no schedule. */
const RUN_PAST_SCHEDULE = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

const PENDING_BODY = {
  phase: "proposal",
  version: 1,
  agentName: "Blog Draft Writer",
  schedule: { kind: "immediate" },
  durationCopy: null,
  canConfirm: true,
  restrictedReason: null,
  runPending: true,
};

function scheduleEnvelope() {
  return {
    kind: "trigger_schedule_proposal",
    state: { state: "pending", canDecide: true, canComment: true },
    body: PENDING_BODY,
  };
}

/** Section VI's fifth reading, as the resolver answers it once the one-off has
 *  fired: released and spent, with nothing left to press. */
function firedBody(runId: string) {
  return {
    phase: "settled",
    version: 1,
    agentName: "Blog Draft Writer",
    runId,
    triggerType: "immediate",
    schedule: { kind: "immediate" },
    scheduleCopy: "Runs right after setup",
    timezone: "UTC",
    gatedSteps: [],
    released: true,
    arming: false,
    canSave: false,
    canCancel: false,
  };
}

function firedEnvelope(runId: string = RUN_ID) {
  return {
    kind: "trigger_schedule_proposal",
    state: { state: "settled" },
    body: firedBody(runId),
    // THE FIRED READING RIDES THE ANSWER (cinatra#3174 fix leg 1). A one-off's
    // gate stamp is no longer read as its firing on its own — the run it gated
    // has to have actually run — so the resolver states the reading beside the
    // body, and this fixture is a schedule that HAS fired.
    firedOnce: true,
  };
}

/** The screen the run opens after its schedule fired — the very thing the
 *  graded set measured standing in the card's place. */
/**
 * THE SHIPPED WIRE SHAPE, not a shape of this file's own (convergence finding).
 * `AgentHitlScreenState` has exactly two states — `asking` and `none` — and the
 * card draws NO DOM AT ALL for anything it does not recognise. A fixture that
 * said `state: "open"` collapsed to `none`, so the screen never arrived and
 * "neither displaces the other" was measured on a frame with nothing to
 * displace anything.
 */
const HITL_SCREEN = {
  state: "asking",
  runId: RUN_ID,
  screenRef: "hitl-live-3053",
  gate: {
    reviewTaskId: "review-live-3053",
    xRenderer: "@cinatra-ai/blog-draft-writer-agent:idea-context",
    inputSchema: {
      type: "object",
      properties: { idea: { type: "string", title: "Idea" } },
      required: ["idea"],
    },
    currentValues: {},
    fieldName: "idea",
  },
};

const runReading = { current: RUN_WORKING as Record<string, unknown> };
/** HOW MANY TIMES THE SURFACE HAS READ THE RUN'S OWN ROW. A walk that changes
 *  the row and asserts straight away is asserting on the frame BEFORE the read,
 *  which is how a test passes for the wrong reason; counting the reads is what
 *  lets a walk say "the surface has actually seen this answer". */
const runReads = { current: 0 };
const cardReading = { current: scheduleEnvelope() as Record<string, unknown> };
let stub: { restore: () => void } | null = null;

function installChatFetchStub() {
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) {
      runReads.current += 1;
      return json(runReading.current);
    }
    if (url === "/api/lifecycle-views/resolve") return json(cardReading.current);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

beforeEach(() => {
  runReading.current = RUN_WORKING;
  runReads.current = 0;
  cardReading.current = scheduleEnvelope();
  hitlReading.current = { state: "none" };
  stub = null;
});
afterEach(() => {
  cleanup();
  stub?.restore();
  vi.restoreAllMocks();
});

async function mountOn(surface: "chat" | "widget", runIds: readonly string[] = [RUN_ID]) {
  if (surface === "widget") {
    stub = installWidgetServiceStub({
      lifecycle: () => cardReading.current,
      runSeed: () => {
        runReads.current += 1;
        return runReading.current;
      },
      hitlScreen: async () => hitlReading.current,
    });
  } else {
    stub = installChatFetchStub();
  }
  return mountSurface(surface, { messages: liveThread(runIds) });
}

const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';
const RUN_PROGRESS = "[data-inline-run-card]";
/** The run's OWN next screen — the root the graded set measured standing where
 *  the schedule card should have been. */
const HITL_SCREEN_CARD = '[data-lifecycle-card="agent_hitl_screen"]';
const FALLBACK = '[data-view-type="__fallback__"]';

// ---------------------------------------------------------------------------
// The road this file is on, asserted rather than assumed
// ---------------------------------------------------------------------------

describe("the streamed turn under test really is the live road", () => {
  it("carries the dispatch trace and NO schedule part", () => {
    const turn = streamedTurn(RUN_ID, "a1") as unknown as {
      parts: Array<{ kind: string; name?: string; runId?: string; views?: unknown[] }>;
    };
    const call = turn.parts.find((p) => p.kind === "tool_call");
    expect(call?.name).toBe("agent_run");
    // The fold pinned the run off the DATA_PART, which is what makes this a run
    // slot in the transcript at all.
    expect(call?.runId).toBe(RUN_ID);
    // And it carries no produced views: the platform's schedule part is written
    // into the STORED turn after this stream closed and can never be here.
    expect(call?.views ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE MEASURED DEFECT
// ---------------------------------------------------------------------------

describe.each(["chat", "widget"] as const)(
  "after the one-off fires, the LIVE conversation keeps its reading — %s",
  (surface) => {
    it(
      "the settled card STAYS when the run moves on, with no reload",
      async () => {
        // The page that sent the turn. The run works, then parks at its
        // schedule, and the card reaches this open page off the run's own row.
        const { container } = await mountOn(surface);
        runReading.current = runAtSchedule(CARD_REF);

        await waitFor(
          () => {
            if (!container.querySelector(CARD)) {
              throw new Error("the open page never drew the schedule card");
            }
          },
          { timeout: 20_000 },
        );
        expect(container.querySelectorAll(CARD).length).toBe(1);

        // The reader confirms on the card's own default row; the one-off fires
        // and the run moves on to its next screen. NOTHING is remounted and
        // nothing is reloaded — the only things that change are the two answers
        // the surface reads.
        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();

        await waitFor(
          () => {
            if (!container.querySelector(RUN_PROGRESS)) {
              throw new Error("the run's own reading never came back");
            }
          },
          { timeout: 20_000 },
        );
        // "A spent schedule is still worth reading, so nothing is hidden."
        await waitFor(
          () => {
            const card = container.querySelector(CARD);
            if (!card) {
              throw new Error(
                "the live conversation withdrew the fired one-off's card",
              );
            }
            if (card.getAttribute("data-lifecycle-card-phase") !== "settled") {
              throw new Error("the card did not settle into its reading");
            }
          },
          { timeout: 20_000 },
        );
        // ONE reading, never two.
        expect(container.querySelectorAll(CARD).length).toBe(1);
        // "the rows go read-only -- the values still legible, the pickers gone
        //  -- and the card carries no floor at all"
        const card = container.querySelector(CARD) as HTMLElement;
        expect(card.querySelectorAll("select").length).toBe(0);
        expect(
          card.querySelectorAll('[data-action="confirm-schedule-proposal"]').length,
        ).toBe(0);
        expect(card.textContent).toContain("Run right after setup");
        expect(container.querySelector(FALLBACK)).toBeNull();
      },
      45_000,
    );

    it(
      "keeps it while the run's OWN next screen arrives in the same slot",
      async () => {
        const { container } = await mountOn(surface);
        runReading.current = runAtSchedule(CARD_REF);
        await waitFor(
          () => {
            if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
          },
          { timeout: 20_000 },
        );

        // The fire, and the screen the graded set photographed taking the
        // card's place.
        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();
        hitlReading.current = HITL_SCREEN;

        // THE SCREEN IS WAITED FOR FIRST, and that order is the finding
        // (convergence). Asserting the card on a frame the screen has not
        // reached yet would pass on exactly the state this test exists to
        // leave behind — the pre-screen frame, where nothing has displaced
        // anything. The screen has to be IN the document before "neither
        // displaces the other" means anything at all.
        await waitFor(
          () => {
            // THE SHIPPED RE-READ SIGNAL, DRIVEN RATHER THAN INVENTED. The run's
            // own screen re-reads on two production signals: the run panel
            // reporting a gate change, and the person coming back to the tab
            // (`useAgentHitlScreenState`). The panel is stubbed in this file so
            // the transcript can be measured without it, which leaves the second
            // signal — so this file sends that one. It is the same event a real
            // reader sends by clicking back into the tab.
            window.dispatchEvent(new Event("focus"));
            if (!container.querySelector(HITL_SCREEN_CARD)) {
              throw new Error("the run's own next screen never arrived");
            }
          },
          { timeout: 20_000 },
        );
        await waitFor(
          () => {
            const card = container.querySelector(CARD);
            if (!card) {
              throw new Error(
                "the run's next screen displaced the fired one-off's card",
              );
            }
            if (card.getAttribute("data-lifecycle-card-phase") !== "settled") {
              throw new Error("the card did not settle into its reading");
            }
          },
          { timeout: 20_000 },
        );
        expect(container.querySelectorAll(CARD).length).toBe(1);
        // And the screen is still standing beside it: neither displaced the
        // other, measured on the same frame rather than one at a time.
        expect(container.querySelectorAll(HITL_SCREEN_CARD).length).toBe(1);
      },
      45_000,
    );

    it(
      "keeps it once a SECOND run is dispatched into the same conversation",
      async () => {
        // The graded set's fourth walk: a second run exists from the trigger,
        // two of the run's screens are in the document, and the schedule card
        // was still absent. A second run's turn is a SECOND streamed message,
        // which is the shape the live road really produces.
        const { container } = await mountOn(surface, [RUN_ID, SECOND_RUN_ID]);
        runReading.current = runAtSchedule(CARD_REF);
        await waitFor(
          () => {
            if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
          },
          { timeout: 20_000 },
        );

        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();
        hitlReading.current = HITL_SCREEN;

        // THE ROW'S NEW ANSWER, WAITED FOR RATHER THAN ASSUMED. The card is
        // still in the document on the frame before the poll lands, so reading
        // it straight away would pass on the state this test exists to leave
        // behind. The run's own progress reading coming back IS the row having
        // answered "no schedule".
        await waitFor(
          () => {
            if (container.querySelectorAll(RUN_PROGRESS).length !== 2) {
              throw new Error("both runs' own readings did not come back");
            }
          },
          { timeout: 20_000 },
        );
        await waitFor(
          () => {
            if (!container.querySelector(CARD)) {
              throw new Error(
                "the fired one-off's card is absent once a second run is present",
              );
            }
          },
          { timeout: 20_000 },
        );
        // Both runs read the SAME row here, so both slots see a spent schedule:
        // what must not happen is a second reading of one schedule inside one
        // run's own container.
        const slots = container.querySelectorAll("[data-agent-run-slot]");
        expect(slots.length).toBe(2);
        for (const slot of Array.from(slots)) {
          expect(slot.querySelectorAll("[data-settled-moment-reading]").length).toBeLessThan(2);
        }
      },
      45_000,
    );
  },
);

// ---------------------------------------------------------------------------
// THE SENTENCE OVER THE FIRED READING
// ---------------------------------------------------------------------------

describe.each(["chat", "widget"] as const)(
  "the line above the fired reading follows the drawing — %s",
  (surface) => {
    it(
      'reads "It ran at the time you set. A one-time schedule is spent once it fires, ' +
        'so the rows below are the record of it and cannot be changed."',
      async () => {
        const { container } = await mountOn(surface);
        runReading.current = runAtSchedule(CARD_REF);
        await waitFor(
          () => {
            if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
          },
          { timeout: 20_000 },
        );

        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();

        await waitFor(
          () => {
            const card = container.querySelector(CARD);
            if (card?.getAttribute("data-lifecycle-card-phase") !== "settled") {
              throw new Error("the fired reading is not drawn");
            }
          },
          { timeout: 20_000 },
        );
        await waitFor(
          () => {
            const text = container.textContent ?? "";
            if (
              !text.includes(
                "It ran at the time you set. A one-time schedule is spent once it fires, " +
                  "so the rows below are the record of it and cannot be changed.",
              )
            ) {
              throw new Error("the drawing's sentence is not over the fired reading");
            }
          },
          { timeout: 20_000 },
        );
        const text = container.textContent ?? "";
        // The pre-fire sentence is gone: it claimed a queue on a run that has
        // already run, and it carried chrome the drawing does not give.
        expect(text).not.toContain("The run is queued and will start on its own.");
        expect(text).not.toContain("status:");
        expect(text).not.toContain(RUN_ID);
      },
      45_000,
    );
  },
);

// ---------------------------------------------------------------------------
// A RECURRING SCHEDULE IS NOT SPENT BY FIRING
// ---------------------------------------------------------------------------
//
// "Only a one-off -- Run right after setup or Schedule for later -- reaches
//  this reading. A recurring schedule is never spent by firing: its past runs
//  are history and its runs still to come stay changeable."
//
// So the one-off's sentence may not be said over a recurring card.

describe("a recurring schedule never gets the spent sentence", () => {
  it("keeps its own reading and the platform's own line", async () => {
    const { container } = await mountOn("chat");
    runReading.current = runAtSchedule(SECOND_CARD_REF);
    await waitFor(
      () => {
        if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
      },
      { timeout: 20_000 },
    );

    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = {
      kind: "trigger_schedule_proposal",
      state: { state: "settled" },
      firedOnce: true,
      body: {
        ...firedBody(RUN_ID),
        triggerType: "recurring",
        schedule: {
          kind: "recurring",
          selection: {
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
          },
          timezone: "UTC",
        },
        scheduleCopy: "Every weekday at 9:00 AM",
        canSave: true,
        canCancel: true,
      },
    };

    await waitFor(
      () => {
        if (!container.querySelector(RUN_PROGRESS)) {
          throw new Error("the run's own reading never came back");
        }
      },
      { timeout: 20_000 },
    );
    await waitFor(
      () => {
        if (!container.querySelector(CARD)) {
          throw new Error("the recurring reading was withdrawn");
        }
      },
      { timeout: 20_000 },
    );
    expect(container.textContent ?? "").not.toContain(
      "A one-time schedule is spent once it fires",
    );
  }, 45_000);
});

// ---------------------------------------------------------------------------
// THE DELAYED ONE-OFF — "Schedule for later" (convergence finding)
// ---------------------------------------------------------------------------
//
// The walk above fires out of `pending_trigger`. The road the drawing's fired
// example is actually drawn on passes through `armed` first: the reader
// confirms, the run is armed, and it waits there — for minutes, or until July
// — with its row still naming the schedule. A surface that stops watching a
// run the moment it reads `armed` never learns the schedule fired: the row goes
// on naming a card for ever, the run's own next reading never comes back, and
// the settled election is never reached. The card would stand on screen still
// asking, over a schedule that is spent.
//
// So this walk gives the surface the answer the real road gives it, in the real
// order, and holds it to the same two properties as the walk above.

describe.each(["chat", "widget"] as const)(
  "a one-off armed for LATER still reaches its spent reading — %s",
  (surface) => {
    it(
      "the card settles and the run's own reading comes back after the fire",
      async () => {
        const { container } = await mountOn(surface);
        runReading.current = runAtSchedule(CARD_REF);
        await waitFor(
          () => {
            if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
          },
          { timeout: 20_000 },
        );

        // The reader confirms "Schedule for later". The run is ARMED and waits
        // there — the card is still its reading, and it is still the only thing
        // in the slot.
        //
        // AND THE SURFACE MUST REALLY HAVE READ THAT, which is the whole point
        // of this walk: the defect is a watch that ENDS on the armed answer, so
        // a walk that fired the schedule before the answer landed would prove
        // nothing at all. TWO completed reads, because a read already in flight
        // when the row changed would carry the previous answer.
        const armedAt = runReads.current;
        runReading.current = runArmedAtSchedule(CARD_REF);
        await waitFor(
          () => {
            if (runReads.current < armedAt + 2) {
              throw new Error("the surface never read the armed run");
            }
            if (!container.querySelector(CARD)) {
              throw new Error("the armed run lost its schedule card");
            }
          },
          { timeout: 30_000 },
        );

        // THE INSTANT ARRIVES. The release job moves the run on and clears the
        // moment; nothing is reloaded and nothing is remounted.
        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();

        await waitFor(
          () => {
            if (!container.querySelector(RUN_PROGRESS)) {
              throw new Error(
                "the surface stopped watching at `armed` and never learned the one-off fired",
              );
            }
          },
          { timeout: 25_000 },
        );
        await waitFor(
          () => {
            const card = container.querySelector(CARD);
            if (!card) throw new Error("the fired one-off's card was withdrawn");
            if (card.getAttribute("data-lifecycle-card-phase") !== "settled") {
              throw new Error("the card did not settle into its reading");
            }
          },
          { timeout: 25_000 },
        );
        expect(container.querySelectorAll(CARD).length).toBe(1);
        // And the drawing's line is over it, on this road too.
        await waitFor(
          () => {
            const text = container.textContent ?? "";
            if (
              !text.includes(
                "It ran at the time you set. A one-time schedule is spent once it fires, " +
                  "so the rows below are the record of it and cannot be changed.",
              )
            ) {
              throw new Error("the drawing's sentence is not over the fired reading");
            }
          },
          { timeout: 25_000 },
        );
        expect(container.textContent ?? "").not.toContain(
          "The run is queued and will start on its own.",
        );
      },
      60_000,
    );
  },
);
