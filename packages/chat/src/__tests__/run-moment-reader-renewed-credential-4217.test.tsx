// @vitest-environment jsdom
/**
 * THE RUN'S MOMENT READER ASKS WITH THE CREDENTIAL THE FRAME HOLDS NOW
 * (cinatra#4217).
 *
 * The conversation's run container reads the run's own row to learn which
 * lifecycle moment it stands at, and it keeps looking while the conversation
 * stays open. The embed frame renews its sign-in while it stays open too: the
 * declaration stays the same and the tokens behind its header callback change.
 * So every look must build its headers again. A look that sent the headers the
 * reader was built with would present a spent user token after the first
 * renewal, and the moment would stop reaching the open page.
 *
 * RED BEFORE THE CURE: the reader built its request once, when the slot
 * mounted, and every later look sent those headers.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/run-moment-reader-renewed-credential-4217.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer reads `window.localStorage` on mount; jsdom under Node 25 can
// expose the property without its methods. Installed only when it is missing.
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

const RUN_ID = "4217a5e1-0c3b-4d2e-9f6a-7b8c9d0e1f2a";
const RUN_URL = `/api/agents/runs/${RUN_ID}`;

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
// The run panel reads the same route on its own; it is stubbed so every call to
// the run's URL below is the moment reader's.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => <div data-inline-run-card={runId} />,
}));

import {
  installWidgetServiceStub,
  mountSurface,
  WIDGET_LIFECYCLE_SURFACE,
} from "./conversation-column-harness";

/** The run, still working: no moment, so the watch keeps looking. */
const RUN_WORKING = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

function runTurn(): UiMessage[] {
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
        },
      ],
    } as unknown as UiMessage,
  ];
}

/** The run, parked at the schedule moment with its own card reference. */
const CARD_REF = "sched-run-ref-4217";
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

/** The resolver's pending answer for the schedule card (§VI). */
function scheduleEnvelope() {
  return {
    kind: "trigger_schedule_proposal",
    state: { state: "pending", canDecide: true, canComment: true },
    body: {
      phase: "proposal",
      version: 1,
      agentName: "Blog Draft Writer",
      schedule: { kind: "immediate" },
      durationCopy: null,
      canConfirm: true,
      restrictedReason: null,
      runPending: true,
    },
  };
}

/** The resolver's answer once the one-off has fired: settled, nothing to press. */
function firedEnvelope() {
  return {
    kind: "trigger_schedule_proposal",
    state: { state: "settled" },
    body: {
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
    },
  };
}

/** The same turn, as a reloaded conversation carries it: with the moment part. */
function runTurnCarryingPart(): UiMessage[] {
  const [user, assistant] = runTurn() as unknown as [
    UiMessage,
    { parts: Array<Record<string, unknown>> } & UiMessage,
  ];
  assistant.parts[0] = {
    ...assistant.parts[0],
    views: [{ viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: CARD_REF }],
  };
  return [user, assistant as unknown as UiMessage];
}

const CARD = '[data-lifecycle-card="trigger_schedule_proposal"]';
const RUN_PROGRESS = "[data-inline-run-card]";

function userTokenOf(init: RequestInit): string | undefined {
  const raw = (init.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) {
    if (k.toLowerCase() === "x-cinatra-widget-user-token") return v;
  }
  return undefined;
}

let stub: { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } | null = null;

/**
 * THE SERVER'S SIDE OF A RENEWAL: a user token the frame has renewed away from
 * is SPENT, and the run route refuses it. Installed over the harness stub, so
 * every other route answers exactly as the harness does; the refused look is
 * still recorded, so a test can read which token it carried.
 */
function refuseSpentTokensOnTheRunRoute(spent: ReadonlySet<string>, status = 401) {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/agents/runs/") && spent.has(userTokenOf(init ?? {}) ?? "")) {
      stub?.calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}

/** The frame's header callback, renewing: same declaration, a token that moves. */
function renewingHeaders(token: () => string) {
  vi.spyOn(WIDGET_LIFECYCLE_SURFACE.auth, "headers").mockImplementation(() => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": token(),
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }));
}

/**
 * The frame's renewal seam on the widget's declaration: `pending` is true while
 * the test holds a renewal answer back, and `settled` waits on a gate only the
 * test opens (fold 3, pre-3 NOTE 5: the readings below wait on events, never on
 * a sleep or a moved clock).
 */
const seam = {
  pending: false,
  settledCalls: 0,
  open: (): void => undefined,
};
function renewalSeam() {
  seam.pending = false;
  seam.settledCalls = 0;
  let gate: Promise<void> | null = null;
  const settled = () => {
    seam.settledCalls += 1;
    if (!seam.pending) return Promise.resolve();
    gate ??= new Promise<void>((resolve) => {
      seam.open = () => {
        gate = null;
        resolve();
      };
    });
    return gate;
  };
  Object.assign(WIDGET_LIFECYCLE_SURFACE.auth, {
    renewal: { pending: () => seam.pending, settled },
  });
}
/** One macrotask turn: lets anything already started run to its end. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  delete (WIDGET_LIFECYCLE_SURFACE.auth as { renewal?: unknown }).renewal;
  stub?.restore();
  stub = null;
  vi.restoreAllMocks();
});

describe("the run's moment reader on the widget (cinatra#4217)", () => {
  it("a look after a renewal carries the renewed token, never the first one", async () => {
    let userToken = "cwu_first";
    // The frame's declaration stays the same object; only the tokens behind its
    // header callback change, exactly as the embed's renewal does.
    vi.spyOn(WIDGET_LIFECYCLE_SURFACE.auth, "headers").mockImplementation(() => ({
      Authorization: "Bearer cit_site",
      "X-Cinatra-Widget-User-Token": userToken,
      "X-Cinatra-Widget-Assistant": "wordpress",
      "X-Cinatra-Widget-Origin": "https://blog.example.com",
    }));
    stub = installWidgetServiceStub({ runSeed: () => RUN_WORKING });
    await mountSurface("widget", { messages: runTurn() });

    const runLooks = () => stub!.calls.filter((c) => c.url === RUN_URL);
    // The first look is immediate and carries the token the frame holds now.
    await waitFor(() => {
      if (runLooks().length === 0) throw new Error("the moment reader has not looked yet");
    });
    expect(userTokenOf(runLooks()[0]!.init)).toBe("cwu_first");

    // The frame renews.
    userToken = "cwu_renewed";
    const before = runLooks().length;
    // The person comes back to the tab: one more look, right away.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      if (runLooks().length <= before) throw new Error("no look after the renewal");
    });

    const after = runLooks().slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) {
      expect(userTokenOf(call.init)).toBe("cwu_renewed");
      expect(call.init.credentials).toBe("omit");
    }
  });

  // cinatra#4217 fold 3 (pre-3 MUST-FIX 1): the server committed the renewed
  // pair and spent the first one, but the renewal's answer is held back, so the
  // frame still sends the first pair and a look in that gap is refused. The
  // watch counts that look as neither answer nor miss and does not look again,
  // not even on a focus, until the renewal settles; however long that takes is
  // the renewal request's own bound. RED AT 749d92f2: the fold-2 watch went on
  // looking through the gap (and charged it after 180 s), it never waited for
  // the renewal, so the wait below never began.
  it("fold 3: a look refused while a renewal answer is on its way waits for the renewal; the next look carries the renewed pair and the open page draws the schedule card", async () => {
    let userToken = "cwu_first";
    const spent = new Set<string>();
    renewingHeaders(() => userToken);
    renewalSeam();
    let runReading: Record<string, unknown> = RUN_WORKING;
    stub = installWidgetServiceStub({
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => runReading,
    });
    refuseSpentTokensOnTheRunRoute(spent);
    const { container } = await mountSurface("widget", { messages: runTurn() });
    const runLooks = () => stub!.calls.filter((c) => c.url === RUN_URL);
    await waitFor(() => {
      if (runLooks().length === 0) throw new Error("no first look yet");
    });

    // The server commits the renewal and spends the first pair; its answer is
    // still on its way, so the frame holds the first pair.
    seam.pending = true;
    spent.add("cwu_first");
    const before = runLooks().length;
    window.dispatchEvent(new Event("focus"));
    // The look that meets the gap (the focus, or the cadence when the focus
    // came while the first look was still out) puts the watch on the renewal.
    await waitFor(() => {
      if (seam.settledCalls === 0) throw new Error("the watch never waited for the renewal");
    });
    const gap = runLooks().slice(before);
    expect(gap.length, "exactly one look met the gap").toBe(1);
    expect(userTokenOf(gap[0]!.init)).toBe("cwu_first");
    // While it waits nothing looks, whatever the person does.
    for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event("focus"));
    await drain();
    expect(runLooks().length, "no look while the renewal is on its way").toBe(before + 1);

    // The renewal answers: the renewed pair is installed first, then the
    // request stops counting as in flight. Then the run parks.
    userToken = "cwu_renewed";
    seam.pending = false;
    runReading = RUN_AT_SCHEDULE;
    seam.open();
    await waitFor(
      () => {
        if (!container.querySelector(CARD)) {
          throw new Error("after the renewal gap the open page never drew the schedule card");
        }
      },
      { timeout: 10_000 },
    );
    expect(container.querySelectorAll(CARD).length).toBe(1);
    for (const call of runLooks().slice(before + 1)) {
      expect(userTokenOf(call.init)).toBe("cwu_renewed");
    }
  }, 30_000);

  // cinatra#4217 (R76 MUST-FIX 1): what the renewed look CHANGES ON SCREEN. The
  // token assertion above proves the header; these two prove the drawing. The
  // server refuses the spent token, exactly as the renewal leaves it, so a
  // reader that kept its first headers learns nothing after the renewal and
  // the slot stays on its old reading.
  it("after a renewal the open page still swaps the run-progress reading for the schedule card", async () => {
    let userToken = "cwu_first";
    const spent = new Set<string>();
    renewingHeaders(() => userToken);
    let runReading: Record<string, unknown> = RUN_WORKING;
    stub = installWidgetServiceStub({
      lifecycle: () => scheduleEnvelope(),
      runSeed: () => runReading,
    });
    refuseSpentTokensOnTheRunRoute(spent);
    const { container } = await mountSurface("widget", { messages: runTurn() });

    // Before the renewal: the run works, its own reading holds the slot.
    await waitFor(() => {
      if (!container.querySelector(RUN_PROGRESS)) throw new Error("the working run drew no reading");
    });
    expect(container.querySelector(CARD)).toBeNull();
    await waitFor(() => {
      if (!stub!.calls.some((c) => c.url === RUN_URL)) throw new Error("no first look yet");
    });

    // The frame renews; the first token is spent. Then the run parks.
    userToken = "cwu_renewed";
    spent.add("cwu_first");
    runReading = RUN_AT_SCHEDULE;
    window.dispatchEvent(new Event("focus"));

    await waitFor(
      () => {
        if (!container.querySelector(CARD)) {
          throw new Error("after the renewal the open page never drew the schedule card");
        }
      },
      { timeout: 10_000 },
    );
    expect(container.querySelectorAll(CARD).length).toBe(1);
    // ONE reading in the slot: the progress card stood down for the moment.
    await waitFor(() => {
      if (container.querySelector(RUN_PROGRESS)) throw new Error("the run-progress card is still stacked");
    });
  }, 30_000);

  it("after a renewal the open page still brings the run-progress reading back when the run leaves the schedule", async () => {
    let userToken = "cwu_first";
    const spent = new Set<string>();
    renewingHeaders(() => userToken);
    let runReading: Record<string, unknown> = RUN_AT_SCHEDULE;
    let cardReading: Record<string, unknown> = scheduleEnvelope();
    stub = installWidgetServiceStub({
      lifecycle: () => cardReading,
      runSeed: () => runReading,
    });
    refuseSpentTokensOnTheRunRoute(spent);
    const { container } = await mountSurface("widget", { messages: runTurnCarryingPart() });

    // Before the renewal: the run stands at the schedule, the card is its reading.
    await waitFor(() => {
      if (!container.querySelector(CARD)) throw new Error("no schedule card drawn");
    });
    await waitFor(() => {
      if (container.querySelector(RUN_PROGRESS)) throw new Error("a run-progress card is stacked");
    });

    // The frame renews; the first token is spent. Then the run moves on.
    userToken = "cwu_renewed";
    spent.add("cwu_first");
    runReading = RUN_PAST_SCHEDULE;
    cardReading = firedEnvelope();
    window.dispatchEvent(new Event("focus"));

    await waitFor(
      () => {
        if (!container.querySelector(RUN_PROGRESS)) {
          throw new Error("after the renewal the run's own reading never came back");
        }
      },
      { timeout: 10_000 },
    );
    // The card stays, as its own settled reading.
    await waitFor(
      () => {
        const card = container.querySelector(CARD);
        if (!card) throw new Error("the card was withdrawn when the run moved on");
        if (card.getAttribute("data-lifecycle-card-phase") !== "settled") {
          throw new Error("the card did not settle into its reading");
        }
      },
      { timeout: 10_000 },
    );
    expect(container.querySelectorAll(CARD).length).toBe(1);
    expect(container.querySelectorAll(RUN_PROGRESS).length).toBe(1);
  }, 30_000);
});
