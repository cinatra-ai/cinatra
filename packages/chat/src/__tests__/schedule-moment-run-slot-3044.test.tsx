// @vitest-environment jsdom
/**
 * ONE SLOT, TWO READINGS — the schedule moment takes the RUN'S OWN PLACE in the
 * conversation, and it gets there without a reload (cinatra#3044).
 *
 * Two properties are pinned here, and both are read off the run's own container
 * in the transcript — the `agent_run` part's slot, which is the one place the
 * drawing gives this run in the turn:
 *
 *   1. WHILE THE RUN STANDS AT THE SCHEDULE MOMENT, THAT SLOT DRAWS THE
 *      SCHEDULER FORM AND NOTHING ELSE. No run-progress card above it, none
 *      beside it: the moment's card IS the run's reading until the run has a
 *      different one. The slot goes back to the run's own progress reading the
 *      moment the run leaves the schedule (the "Run right after setup" road).
 *
 *   2. THE PAGE THAT SENT THE TURN DRAWS THE CARD WHEN THE RUN PARKS. The turn
 *      that started the run was streamed, so its content in this tab can never
 *      carry a part written into it afterwards. The card therefore has to reach
 *      the OPEN page through the run's own reading — the same read that turns
 *      "queued" into "Awaiting input" — and mount with no navigation and no
 *      reload. Nothing in this file remounts the surface between the run
 *      working and the run parked.
 *
 * BOTH ARMS OF THE ONE COLUMN. `/chat` and the third-party application share
 * this container, so every property is measured on both hosts.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-moment-run-slot-3044.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

// The column loads the message list behind a lazy boundary; inside the full
// package run that import competes with every other file and can exceed
// testing-library's one-second default, which would fail a mount for a reason
// that has nothing to do with what is under test.
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

const RUN_ID = "1e1c5f00-2202-42cc-987a-40f272e8a29b";
const CARD_REF = "sched-run-ref-3044";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

// The transcript's other two run-addressed cards answer "nothing to draw", so
// this file measures the schedule moment alone.
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

// THE RUN-PROGRESS READING, made countable. The real panel's own rendering is
// pinned in the agents package; what this file has to be able to count is
// whether the transcript drew a run-progress card AT ALL while the moment's
// card is on screen. The stub draws the heading the shipped panel draws, on a
// marker the shipped panel already carries.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-inline-run-card={runId}>
      <h2>Agentic Run Progress</h2>
    </div>
  ),
}));

import {
  installWidgetServiceStub,
  mountRefusedSurface,
  mountSurface,
} from "./conversation-column-harness";

// ---------------------------------------------------------------------------
// The run's own reading, as the run route answers it
// ---------------------------------------------------------------------------

/** The run, while it is still working: no moment, no card. */
const RUN_WORKING = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};
/** The run, parked at the schedule moment with its own card reference. */
const RUN_AT_SCHEDULE = {
  status: "pending_trigger",
  error: null,
  messages: [],
  lifecycleMoment: "schedule",
  lifecycleCard: { kind: "trigger_schedule_proposal", ref: CARD_REF },
};
/** The run, after "Run right after setup": the moment is closed again. */
const RUN_PAST_SCHEDULE = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

/** §VI's pending body for a run that is ALREADY WAITING. */
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

/**
 * SECTION VI'S FIFTH READING, as the resolver answers it once the one-off has
 * fired: the settled body, released and spent, with nothing left to press.
 *
 *   "Once it has fired, the card is a reading. A one-off that has fired cannot
 *    be changed, so the rows go read-only -- the values still legible, the
 *    pickers gone -- and the card carries no floor at all: no hairline, no
 *    button, nothing to press. A spent schedule is still worth reading, so
 *    nothing is hidden; it simply asks nothing."
 */
const FIRED_BODY = {
  phase: "settled",
  version: 1,
  agentName: "Blog Draft Writer",
  runId: RUN_ID,
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

function firedEnvelope() {
  return {
    kind: "trigger_schedule_proposal",
    // `.strict()` on the wire: the settled state carries NO decision flags.
    state: { state: "settled" },
    body: FIRED_BODY,
  };
}

/** WHAT THE RESOLVER ANSWERS RIGHT NOW. Mutated in place beside `runReading`,
 *  so a test can move the schedule from pending to spent without remounting
 *  anything -- the two readings travel together, exactly as they do live. */
const cardReading = { current: scheduleEnvelope() as Record<string, unknown> };

/**
 * The assistant turn a chat dispatch really produces.
 *
 * `carriesPart` is the difference between the two roads this file measures: the
 * RELOADED conversation carries the platform-injected part in the turn's stored
 * content, and the tab that STREAMED the turn never will.
 */
function dispatchTurn(carriesPart: boolean): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "run the blog draft writer for me" },
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
          result: JSON.stringify({ runId: RUN_ID, status: "pending_input" }),
          ...(carriesPart
            ? {
                views: [
                  {
                    viewType: "trigger_schedule_proposal",
                    schemaVersion: 1,
                    ref: CARD_REF,
                  },
                ],
              }
            : {}),
        },
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`).`,
        },
      ],
    } as unknown as UiMessage,
  ];
}

// ---------------------------------------------------------------------------
// The server both arms ask
// ---------------------------------------------------------------------------

/** What the run route answers RIGHT NOW. Mutated in place so a test can move
 *  the run from working to parked with no remount of anything. */
const runReading = { current: RUN_WORKING as Record<string, unknown> };
let widgetStub: { restore: () => void } | null = null;

function installChatFetchStub() {
  const original = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/")) return json(runReading.current);
    if (url === "/api/lifecycle-views/resolve") return json(cardReading.current);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

beforeEach(() => {
  runReading.current = RUN_WORKING;
  cardReading.current = scheduleEnvelope();
  widgetStub = null;
});
afterEach(() => {
  cleanup();
  widgetStub?.restore();
  vi.restoreAllMocks();
});

async function mountOn(
  surface: "chat" | "widget",
  { carriesPart }: { carriesPart: boolean },
) {
  if (surface === "widget") {
    widgetStub = installWidgetServiceStub({
      lifecycle: () => cardReading.current,
      runSeed: () => runReading.current,
    });
  } else {
    widgetStub = installChatFetchStub();
  }
  return mountSurface(surface, { messages: dispatchTurn(carriesPart) });
}

const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';
const RUN_PROGRESS = "[data-inline-run-card]";
const FALLBACK = '[data-view-type="__fallback__"]';

describe.each(["chat", "widget"] as const)(
  "the run's slot at the schedule moment — %s",
  (surface) => {
    it("draws the scheduler form and NO run-progress card", async () => {
      runReading.current = RUN_AT_SCHEDULE;
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
      });
      // ONE card, and it is the run's whole reading.
      expect(container.querySelectorAll(CARD).length).toBe(1);
      await waitFor(() => {
        if (container.querySelector(RUN_PROGRESS)) {
          throw new Error("a run-progress card is stacked with the moment's card");
        }
      });
      expect(container.textContent).not.toContain("Agentic Run Progress");
    }, 30_000);

    it(
      "Once it has fired, the card is a reading. A one-off that has fired cannot be changed, " +
        "so the rows go read-only -- the values still legible, the pickers gone -- and the card " +
        "carries no floor at all",
      async () => {
        // THE FIRED ONE-OFF, ON THE ROAD THE NINTH GRADED SET PHOTOGRAPHED. The
        // reader confirmed the card's own default row, the one-off fired, and
        // the run moved on to its next screen. The turn still carries the
        // platform-injected part -- it is durable and it will carry it for ever
        // -- and the run's row now names no moment at all.
        //
        // The drawing quoted in this name says what the conversation owes then:
        // the spent schedule KEEPS its reading. It is not the run's current
        // reading any more, so it does not take the run's place -- it stands on
        // its own, beside the reading the run has now.
        runReading.current = RUN_PAST_SCHEDULE;
        cardReading.current = firedEnvelope();
        const { container } = await mountOn(surface, { carriesPart: true });

        await waitFor(() => {
          if (!container.querySelector(RUN_PROGRESS)) {
            throw new Error("the run's own reading did not come back");
          }
        });
        await waitFor(() => {
          if (!container.querySelector(CARD)) {
            throw new Error("the fired one-off's reading is not in the conversation");
          }
        });
        // ONE reading of it, never two: the settled card is drawn once, at its
        // own place, and the run's slot did not draw a second copy.
        expect(container.querySelectorAll(CARD).length).toBe(1);
        const card = container.querySelector(CARD) as HTMLElement;
        // "the rows go read-only -- the values still legible, the pickers gone
        //  -- and the card carries no floor at all"
        expect(card.getAttribute("data-lifecycle-card-phase")).toBe("settled");
        expect(card.querySelectorAll("select").length).toBe(0);
        expect(card.querySelectorAll('[data-action="confirm-schedule-proposal"]').length).toBe(0);
        // "the values still legible" -- the option rows stay readable, and
        // the row the person chose is one of them.
        expect(card.textContent).toContain("Run right after setup");
        // The registry drew the real card, not its fallback.
        expect(container.querySelector(FALLBACK)).toBeNull();
      },
      30_000,
    );

    it("draws the run's own next reading beside it, and no SECOND moment card", async () => {
      // The other half of the rule this replaces, kept: the run's slot draws
      // exactly one moment card. A settled reading standing on its own is not a
      // licence for the slot to draw the same card again beneath the run's own
      // reading.
      runReading.current = RUN_PAST_SCHEDULE;
      cardReading.current = firedEnvelope();
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.querySelector(RUN_PROGRESS)) {
          throw new Error("the run's own reading did not come back");
        }
      });
      await waitFor(() => {
        if (!container.querySelector(CARD)) {
          throw new Error("the fired one-off's reading is not in the conversation");
        }
      });
      expect(container.querySelectorAll(CARD).length).toBe(1);
      expect(container.textContent).toContain("Agentic Run Progress");
    }, 30_000);
  },
);

describe.each(["chat", "widget"] as const)(
  "the page that sent the turn — %s",
  (surface) => {
    it("mounts the card when the run parks, with NO reload", async () => {
      // The tab that streamed this turn: its content carries no injected part
      // and never will, because the part is written into the STORED turn after
      // the stream ended.
      runReading.current = RUN_WORKING;
      const { container } = await mountOn(surface, { carriesPart: false });

      await waitFor(() => {
        if (!container.querySelector(RUN_PROGRESS)) {
          throw new Error("the working run drew no reading at all");
        }
      });
      expect(container.querySelector(CARD)).toBeNull();

      // The run parks. NOTHING is remounted, nothing is navigated, nothing is
      // re-rendered by this test: the only thing that changes is the answer the
      // run's own read gets.
      runReading.current = RUN_AT_SCHEDULE;

      await waitFor(
        () => {
          if (!container.querySelector(CARD)) {
            throw new Error("the open page never drew the schedule card");
          }
        },
        { timeout: 20_000 },
      );
      expect(container.querySelectorAll(CARD).length).toBe(1);
      expect(container.querySelector(RUN_PROGRESS)).toBeNull();
    }, 30_000);
  },
);

// ---------------------------------------------------------------------------
// THE CREDENTIAL THE NEW READ TRAVELS ON
// ---------------------------------------------------------------------------
//
// The transcript now reads the run itself. A run is somebody's work, so the
// read has to carry the surface's OWN credential — never an ambient cookie
// belonging to whoever else is signed in on the browser — and a surface that
// cannot say who is asking must issue no read at all.

describe.each(["chat", "widget"] as const)(
  "the run leaves the moment WHILE the reader is looking — %s",
  (surface) => {
    it("takes the moment's card away and brings the run's reading back, with no reload", async () => {
      // The "run right after setup" road as it really happens: the person is
      // sitting in front of the card and presses. Nothing is remounted here
      // either — the only thing that changes is the run's own answer.
      runReading.current = RUN_AT_SCHEDULE;
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
      });
      expect(container.querySelector(RUN_PROGRESS)).toBeNull();

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
      // AND THE CARD IS STILL THERE — it stops being the run's reading and
      // becomes its OWN. "A spent schedule is still worth reading, so nothing
      // is hidden; it simply asks nothing." What the press takes away is the
      // floor, never the card.
      await waitFor(
        () => {
          const card = container.querySelector(CARD);
          if (!card) throw new Error("the card was withdrawn when the run moved on");
          if (card.getAttribute("data-lifecycle-card-phase") !== "settled") {
            throw new Error("the card did not settle into its reading");
          }
        },
        { timeout: 20_000 },
      );
      expect(container.querySelectorAll(CARD).length).toBe(1);
      expect(
        container.querySelectorAll('[data-action="confirm-schedule-proposal"]').length,
      ).toBe(0);
    }, 40_000);
  },
);

describe("a moment part this bundle cannot address never empties the slot", () => {
  it("keeps the run's reading and draws the registry's own fallback", async () => {
    // A part written at a schema version this bundle does not know. It is not a
    // card this column can address, so it must not hold the run's place — and
    // it must still meet the ordinary validation every other produced view
    // meets, rather than being silently dropped.
    runReading.current = RUN_WORKING;
    widgetStub = installChatFetchStub();
    const messages = dispatchTurn(true) as unknown as Array<{
      parts: Array<{ views?: Array<Record<string, unknown>> }>;
    }>;
    const views = messages[1]!.parts[0]!.views!;
    views[0] = { ...views[0], schemaVersion: 99 };
    const { container } = await mountSurface("chat", {
      messages: messages as never,
    });

    await waitFor(() => {
      if (!container.querySelector(RUN_PROGRESS)) {
        throw new Error("the run's own reading was withheld by an unusable part");
      }
    });
    await waitFor(() => {
      if (!container.querySelector(FALLBACK)) {
        throw new Error("the unusable view drew no fallback");
      }
    });
    expect(container.querySelector(CARD)).toBeNull();
  }, 30_000);
});

describe("the run read carries the surface's own credential", () => {
  it("the third-party application's read OMITS cookies and carries the broker proof", async () => {
    runReading.current = RUN_AT_SCHEDULE;
    const stub = installWidgetServiceStub({
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => runReading.current,
    });
    widgetStub = stub;
    const { container } = await mountSurface("widget", {
      messages: dispatchTurn(false),
    });

    await waitFor(() => {
      if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
    });
    const runReads = stub.calls.filter((c) => c.url.startsWith("/api/agents/runs/"));
    expect(runReads.length).toBeGreaterThan(0);
    for (const call of runReads) {
      expect(call.init.credentials).toBe("omit");
      expect(call.init.headers).toMatchObject({
        Authorization: expect.any(String),
      });
    }
  }, 30_000);

  it("a run that cannot be read leaves ONE reading — the run's own", async () => {
    // The turn carries a perfectly addressable moment part, and the run itself
    // cannot be read. The slot must not answer that with BOTH readings: the
    // moment's card stands down with the progress card, so what is on screen is
    // one reading and it is the honest one.
    runReading.current = RUN_AT_SCHEDULE;
    const stub = installWidgetServiceStub({
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => null,
    });
    widgetStub = stub;
    const { container } = await mountRefusedSurface({ messages: dispatchTurn(true) });

    await waitFor(() => {
      if (!container.querySelector(RUN_PROGRESS)) {
        throw new Error("the run's own reading never came back");
      }
    });
    expect(container.querySelector(CARD)).toBeNull();
  }, 30_000);

  it("a host that cannot say who is asking reads NOTHING", async () => {
    runReading.current = RUN_AT_SCHEDULE;
    const stub = installWidgetServiceStub({
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => runReading.current,
    });
    widgetStub = stub;
    const { container } = await mountRefusedSurface({ messages: dispatchTurn(false) });

    // Nothing is asked, so nothing is drawn — the fail-closed default, not the
    // ambient-session fallback.
    await waitFor(() => {
      if (!container.querySelector("[data-conversation-list]")) {
        throw new Error("the refused column never mounted");
      }
    });
    expect(
      stub.calls.filter((c) => c.url.startsWith("/api/agents/runs/")).length,
    ).toBe(0);
    expect(container.querySelector(CARD)).toBeNull();
  }, 30_000);
});
