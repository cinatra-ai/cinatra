// @vitest-environment jsdom
/**
 * THE TURN THAT INTRODUCES THE CARD MAY NOT CONTRADICT IT (cinatra#3044).
 *
 * The graded capture of criterion 6 read, in 01, 02 and 03, light and dark:
 * the assistant's sentence said "Dispatched `…` (runId: `…`, status: `queued`).
 * The run started." while the card directly beneath it was still asking "When
 * should this run?" and offering Confirm, and the run's row read
 * `pending_trigger`. The card is the visible truth — "where the sentence and
 * the card could disagree, the card is right" — so the sentence is the reading
 * that has to move.
 *
 * WHAT IS MEASURED HERE is the rendered turn, on both arms of the one column:
 *
 *   1. ABOVE A SCHEDULE CARD, the turn carries the WAITING wording, and neither
 *      "The run started." nor the `queued` status token survives anywhere in it.
 *   2. THE CORRECTION FOLLOWS THE RUN, not the turn's stored content: the page
 *      that STREAMED the turn carries no injected part and still corrects, and
 *      a run that has moved past its schedule keeps the sentence it was given.
 *   3. NOTHING ELSE IN THE TURN MOVES — the model's own prose is not rewritten.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-wait-sentence-3044.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";
import {
  RUN_START_SCHEDULE_WAIT_CLAUSE,
  RUN_START_QUEUED_CLAUSE,
  RUN_START_STARTED_CLAUSE,
  describeStartedRun,
} from "@cinatra-ai/agents/run-status";

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

const RUN_ID = "2315b02a-cda3-488c-ad1f-a634dce702b6";
const CARD_REF = "sched-run-ref-3044";
const PACKAGE = "@cinatra-ai/blog-idea-generator-agent";
const PROSE = "Starting the blog idea generator for you now.";

/** The exact sentence the pictures caught above the pending card. */
const FROZEN_SENTENCE = describeStartedRun({
  packageName: PACKAGE,
  runId: RUN_ID,
  status: "queued",
});

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
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-inline-run-card={runId}>
      <h2>Agentic Run Progress</h2>
    </div>
  ),
}));

import {
  installWidgetServiceStub,
  mountSurface,
} from "./conversation-column-harness";

/** The run, parked at its schedule moment with the card's own reference. */
const RUN_AT_SCHEDULE = {
  status: "pending_trigger",
  error: null,
  messages: [],
  lifecycleMoment: "schedule",
  lifecycleCard: { kind: "trigger_schedule_proposal", ref: CARD_REF },
};
/** The same run after ONE Confirm: armed, and still not started. */
const RUN_ARMED = {
  status: "armed",
  error: null,
  messages: [],
  lifecycleMoment: "schedule",
  lifecycleCard: { kind: "trigger_schedule_proposal", ref: CARD_REF },
};
/** The "Run right after setup" road: the run really is running. */
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
  agentName: "Blog Idea Generator",
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

/** The assistant turn a chat dispatch really produces: the model's own prose,
 *  then the platform's sentence relayed verbatim, beside the dispatch part. */
function dispatchTurn(carriesPart: boolean): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "run the blog idea generator every weekday at 9" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        { kind: "text", content: PROSE },
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "queued" }),
          ...(carriesPart
            ? {
                views: [
                  { viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: CARD_REF },
                ],
              }
            : {}),
        },
        { kind: "text", content: FROZEN_SENTENCE },
      ],
    } as unknown as UiMessage,
  ];
}

const runReading = { current: RUN_AT_SCHEDULE as Record<string, unknown> };
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
    if (url === "/api/lifecycle-views/resolve") return json(scheduleEnvelope());
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; } };
}

beforeEach(() => {
  runReading.current = RUN_AT_SCHEDULE;
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
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => runReading.current,
    });
  } else {
    widgetStub = installChatFetchStub();
  }
  return mountSurface(surface, { messages: dispatchTurn(carriesPart) });
}

const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';

describe.each(["chat", "widget"] as const)(
  "the turn above a pending schedule card — %s",
  (surface) => {
    it("says the run WAITS, and never `started` or `queued`", async () => {
      runReading.current = RUN_AT_SCHEDULE;
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
      });
      await waitFor(() => {
        if (!container.textContent?.includes(RUN_START_SCHEDULE_WAIT_CLAUSE)) {
          throw new Error("the turn does not say the run is waiting for its schedule");
        }
      });
      // The contradiction the pictures recorded, named so it cannot come back.
      expect(container.textContent).not.toContain(RUN_START_STARTED_CLAUSE);
      expect(container.textContent).not.toContain("status: `queued`");
      expect(container.textContent).not.toContain("queued");
      // AND IT NAMES NOTHING ELSE (cinatra#3174 fix leg 1). This pin used to
      // require the run id in the drawn line. The ratified drawing's section VI
      // speaks over this card in plain prose in every one of its five pictures
      // — no package chip, no run token — and the first graded proof round
      // photographed the two code chips this leg removes.
      expect(container.textContent).not.toContain(RUN_ID);
      expect(container.textContent).not.toContain("Dispatched");
      // And the model's own prose is untouched.
      expect(container.textContent).toContain(PROSE);
    }, 30_000);

    it("keeps saying it after ONE Confirm — an armed schedule has not started", async () => {
      runReading.current = RUN_ARMED;
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.textContent?.includes(RUN_START_SCHEDULE_WAIT_CLAUSE)) {
          throw new Error("the settled card's turn fell back to the started sentence");
        }
      });
      expect(container.textContent).not.toContain(RUN_START_STARTED_CLAUSE);
    }, 30_000);

    it("corrects the turn on the page that STREAMED it, which carries no part", async () => {
      // That page's copy of the turn will never carry the injected part, so the
      // correction cannot be a property of the stored content — it follows the
      // run's own reading, exactly as the card does.
      runReading.current = RUN_AT_SCHEDULE;
      const { container } = await mountOn(surface, { carriesPart: false });

      await waitFor(() => {
        if (!container.textContent?.includes(RUN_START_SCHEDULE_WAIT_CLAUSE)) {
          throw new Error("the streamed turn was not corrected");
        }
      });
      expect(container.textContent).not.toContain(RUN_START_STARTED_CLAUSE);
    }, 30_000);

    it("leaves the sentence ALONE for a run that truly started", async () => {
      // The "Run right after setup" road. The turn still carries the injected
      // part — it is durable — but the run is running, and "The run started."
      // is the true reading of it.
      runReading.current = RUN_PAST_SCHEDULE;
      const { container } = await mountOn(surface, { carriesPart: true });

      await waitFor(() => {
        if (!container.querySelector("[data-inline-run-card]")) {
          throw new Error("the run's own reading did not come back");
        }
      });
      // LEFT ALONE means the sentence still carries the clause it was minted
      // with -- the status table's own answer for `queued` -- and not the
      // schedule wait's. The correction reaches only a run standing at its
      // schedule moment.
      expect(container.textContent).toContain(RUN_START_QUEUED_CLAUSE);
      expect(container.textContent).not.toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    }, 30_000);
  },
);

/**
 * THE LAYOUT THAT CARRIES NO ORDERED TRACE (convergence finding on this branch).
 *
 * The pinned Slack projection drops `parts` and keeps the turn's prose as flat
 * `content` beside the lifecycle SLOTS alone (`ag-ui-chat-client.ts`, the
 * `slackMode` branch), and an older turn with no trace renders the same way. In
 * that layout the sentence and the card are SIBLINGS in the message body, so a
 * correction that lived only inside the ordered list left the contradiction
 * standing. Measured here on the real render, not on the projection.
 */
function flatDispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "run the blog idea generator every weekday at 9" },
    {
      id: "a1",
      role: "assistant",
      content: `${PROSE}\n\n${FROZEN_SENTENCE}`,
      lifecycleParts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "queued" }),
          views: [{ viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: CARD_REF }],
        },
      ],
    } as unknown as UiMessage,
  ];
}

describe("the turn whose prose is flat content beside the card — the Slack layout", () => {
  it("says the run WAITS, and never `started` or `queued`", async () => {
    runReading.current = RUN_AT_SCHEDULE;
    widgetStub = installChatFetchStub();
    const { container } = await mountSurface("chat", {
      messages: flatDispatchTurn(),
      slackMode: true,
    });

    await waitFor(() => {
      if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
    });
    await waitFor(() => {
      if (!container.textContent?.includes(RUN_START_SCHEDULE_WAIT_CLAUSE)) {
        throw new Error("the flat-content turn kept the frozen sentence above its card");
      }
    });
    expect(container.textContent).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(container.textContent).not.toContain("queued");
    expect(container.textContent).toContain(PROSE);
  }, 30_000);

  it("leaves the sentence ALONE for a run that truly started", async () => {
    runReading.current = RUN_PAST_SCHEDULE;
    widgetStub = installChatFetchStub();
    const { container } = await mountSurface("chat", {
      messages: flatDispatchTurn(),
      slackMode: true,
    });

    await waitFor(() => {
      if (!container.querySelector("[data-inline-run-card]")) {
        throw new Error("the run's own reading did not come back");
      }
    });
    // As above: the frozen sentence is untouched, clause and all.
    expect(container.textContent).toContain(RUN_START_QUEUED_CLAUSE);
    expect(container.textContent).not.toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
  }, 30_000);
});
