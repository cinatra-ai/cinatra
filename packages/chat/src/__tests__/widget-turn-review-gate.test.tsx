// @vitest-environment jsdom
/**
 * ONE WIDGET TURN, END TO END: THE RUN AND ITS REVIEW (cinatra#3051).
 *
 * The agents package's `agentic-run-panel.widget-review-3051.test.tsx` pins the
 * panel's own mount. This one is the TURN: the persisted `agent_named_start`
 * dispatch — the widget's one narrowly scoped start door — replayed through the
 * REAL widget arm of the shared conversation column, with the REAL inline run
 * card and panel inside it, and read off the rendered transcript.
 *
 * The four moments a person passes through, in order, in ONE slot:
 *
 *   1. THE RUNNING PLACEHOLDER — the frame and the spinner, no review card.
 *   2. THE COMPLETED/AWAITING PLACEHOLDER — the run is done and its review has
 *      not opened yet. Before #3051 the widget fell through to the run's terminal
 *      reading here ("Its output could not be loaded here…").
 *   3. THE PENDING GATE — the same slot, now the review card.
 *   4. THE SETTLED GATE — the decision taken through the card's own bar.
 *
 * At every moment: EXACTLY ONE card, the transcript and its tool-call count
 * unchanged, every lifecycle request on the surface's broker headers with
 * cookies OMITTED, and no cookie-bound review or run-window action called. Then
 * the RELOAD — the same persisted turn mounted afresh — draws the card again.
 *
 * WHY THE REAL RUN CARD HERE. The other widget carriage suites stand a marker in
 * for the inline run card because they are about the column's dispatch. This one
 * is about what the run card DRAWS on this host, so a stand-in would measure the
 * fixture.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/widget-turn-review-gate.test.tsx
 */

import React from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/embed/assistant",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// --- the server-bound graphs the column and the panel reach -----------------
// Replaced as the sibling carriage suites replace them: their graphs reach the
// server runtime, so without these the column does not mount at all. What is
// MEASURED stays real — the transcript, the host declaration, the run panel, the
// review card, and every request they issue.

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: vi.fn(async () => ({ state: "none" })),
}));
// THE COOKIE-BOUND ACTIONS, kept as spies rather than removed: a widget card or
// panel that reached for one would be asking the app to answer as whoever else
// is signed in on this browser, so "never called" is an assertion below.
const approveReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
const rejectReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../agents/src/hitl-actions", () => ({ approveReviewTask, rejectReviewTask }));
const loadRunWindowConversation = vi.hoisted(() => vi.fn(async () => []));
const sendRunWindowTurn = vi.hoisted(() => vi.fn(async () => ({ ok: true, entries: [] })));
vi.mock("../../../agents/src/run-window-actions", () => ({
  loadRunWindowConversation,
  sendRunWindowTurn,
}));
vi.mock("../../../agents/src/a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
}));
vi.mock("../../../agents/src/run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));
// No live stream: what is measured is what the run's own STATE makes the card
// draw, and a stream would supply its own status.
vi.mock("../../../agents/src/use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));
vi.mock("../../../agents/src/agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));
// THE PANEL, REAL — reached by its own module rather than through the package's
// client barrel, whose graph boots the app's auth module.
vi.mock("@cinatra-ai/agents/client-entry", async () => {
  const panel = await vi.importActual<
    typeof import("../../../agents/src/agentic-run-panel")
  >("../../../agents/src/agentic-run-panel");
  return { AgenticRunPanel: panel.AgenticRunPanel };
});
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../../../agents/src/lifecycle-card-runtime";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "../../../agents/src/review-gate-card";
import { NAMED_AGENT_START_TOOL_NAME } from "../run-start-tool-names";
import type { UiMessage } from "../types";
import {
  installWidgetServiceStub,
  mountSurface,
  WIDGET_LIFECYCLE_SURFACE,
} from "./conversation-column-harness";

const RUN_ID = "run-3051-widget";
const GATE_REF = "lcr-opaque-3051";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const PROMPT_WINDOW = '[data-conformance-id="review-prompt-window"]';
const SETTLED_EXCHANGE = "[data-review-settled-exchange]";
const SLOT = "[data-run-review-slot]";
const APPROVE = '[data-action="approve-review -> resolved"]';

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

/**
 * THE PERSISTED TURN — the widget's own start door, as the server wrote it.
 * `agent_named_start` rather than `agent_run`: the widget's closed allowlist does
 * not hold `agent_run`, so this is the name a widget-started run carries.
 */
function namedStartTranscript(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Write the launch post" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "text",
          content:
            "Started `@cinatra-ai/blog-draft-writer-agent` (runId: `" + RUN_ID + "`).",
        },
        {
          kind: "tool_call",
          id: "t1",
          name: NAMED_AGENT_START_TOOL_NAME,
          runId: RUN_ID,
          status: "completed",
          resultLabel: `runId: ${RUN_ID}, status: running`,
        },
      ],
    } as UiMessage,
  ];
}

/** The tool calls the persisted turn carries — counted off the wire itself. */
function toolCallsIn(messages: UiMessage[]): number {
  return messages.reduce(
    (n, m) =>
      n +
      ((m as { parts?: Array<{ kind: string }> }).parts ?? []).filter(
        (p) => p.kind === "tool_call",
      ).length,
    0,
  );
}

type Call = { url: string; init: RequestInit };

/** The run's seed, as `/api/agents/runs/<id>` answers it. */
function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    inputParams: {},
    templateId: "tmpl-3051",
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    agUiEnabled: false,
    taskId: null,
    traceId: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false },
    ...over,
  };
}

const PENDING = { state: "pending", canDecide: true, canComment: true };
const SETTLED = { state: "settled", outcome: "approved" };

/**
 * The widget's server: the harness answers the conversation routes, the run's
 * seed and the resolve; this adds the gate's decision and records every call
 * so the credential rail can be read back.
 */
function installTurnServer(state: {
  seed: () => Record<string, unknown>;
  gate: () => Record<string, unknown>;
  messages: UiMessage[];
}) {
  const base = installWidgetServiceStub({
    threadMessages: state.messages,
    runSeed: () => state.seed(),
    lifecycle: () => ({ kind: "artifact_review_gate", state: state.gate(), body: null }),
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === LIFECYCLE_VIEW_DECIDE_PATH) {
      base.calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({ outcome: { kind: "decided", disposition: "approve", idempotent: false } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
  return { calls: base.calls as Call[], restore: base.restore };
}

/** Lower-cased header map of a recorded call. */
function headersOf(init: RequestInit): Record<string, string> {
  const raw = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function callsTo(calls: Call[], path: string): Call[] {
  return calls.filter((c) => c.url === path);
}

function seedUrl(runId: string): string {
  return `/api/agents/runs/${encodeURIComponent(runId)}`;
}

function expectBrokered(call: Call | undefined, what: string) {
  expect(call, `${what} was never issued`).toBeDefined();
  const headers = headersOf(call!.init);
  expect(headers["authorization"], what).toBe("Bearer cit_site");
  expect(headers["x-cinatra-widget-user-token"], what).toBe("cwu_user");
  expect(call!.init.credentials, what).toBe("omit");
}

/** Every lifecycle request so far went on the broker, cookies omitted. */
function expectEveryLifecycleCallBrokered(calls: Call[]) {
  for (const path of [LIFECYCLE_VIEW_RESOLVE_PATH, LIFECYCLE_VIEW_DECIDE_PATH]) {
    for (const call of callsTo(calls, path)) expectBrokered(call, path);
  }
}

/** No cookie-bound review or run-window action was ever called. */
function expectNoCookieAction() {
  expect(approveReviewTask).not.toHaveBeenCalled();
  expect(rejectReviewTask).not.toHaveBeenCalled();
  expect(loadRunWindowConversation).not.toHaveBeenCalled();
  expect(sendRunWindowTurn).not.toHaveBeenCalled();
}

/** What the transcript itself is made of, independent of the review slot. */
function transcriptShape(root: HTMLElement) {
  return {
    slots: root.querySelectorAll("[data-transcript-slot]").length,
    runStartSlots: root.querySelectorAll("[data-agent-run-slot]").length,
    toolCallViews: root.querySelectorAll("[data-tool-call]").length,
    assistantContent: root.querySelectorAll("[data-embed-content]").length,
  };
}

/** The one-card reading, at any moment. */
function cardCounts(root: HTMLElement) {
  return {
    reviewCards: root.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
    slots: root.querySelectorAll(SLOT).length,
    placeholders: root.querySelectorAll(PLACEHOLDER).length,
    promptWindows: root.querySelectorAll(PROMPT_WINDOW).length,
    settledExchanges: root.querySelectorAll(SETTLED_EXCHANGE).length,
  };
}

let server: ReturnType<typeof installTurnServer> | null = null;

beforeEach(() => {
  cleanup();
  approveReviewTask.mockClear();
  rejectReviewTask.mockClear();
  loadRunWindowConversation.mockClear();
  sendRunWindowTurn.mockClear();
});

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  vi.clearAllMocks();
});

describe("a run started from the widget's own composer (#3051)", () => {
  it("walks the four moments in one slot, decides there, and restores the card after a reload", async () => {
    const persisted = JSON.stringify(namedStartTranscript());
    let seed = seedBody();
    let gate: Record<string, unknown> = PENDING;
    server = installTurnServer({
      seed: () => seed,
      gate: () => gate,
      messages: JSON.parse(persisted),
    });

    const first = await mountSurface("widget", { messages: JSON.parse(persisted) });
    const root = first.container as HTMLElement;

    // The transcript the turn arrived as. Everything below must leave it alone.
    const shapeAtStart = transcriptShape(root);
    expect(shapeAtStart.runStartSlots).toBe(1);
    expect(toolCallsIn(JSON.parse(persisted))).toBe(1);

    // ---- MOMENT 1: the run is working -------------------------------------
    await waitFor(() => expect(root.querySelector(PLACEHOLDER)).not.toBeNull(), {
      timeout: 15_000,
    });
    expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("working");
    expect(cardCounts(root)).toEqual({
      reviewCards: 0, slots: 1, placeholders: 1, promptWindows: 0, settledExchanges: 0,
    });
    expect(transcriptShape(root)).toEqual(shapeAtStart);

    // ---- MOMENT 2: done, and the review has not opened yet ------------------
    // Waited on the surface's own reads rather than a clock: two further reads of
    // the run means the panel has seen the completed status and the still-closed
    // review, and only then is "the placeholder is still up" about the component.
    const readsBefore = callsTo(server.calls, seedUrl(RUN_ID)).length;
    seed = seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } });
    await waitFor(
      () =>
        expect(callsTo(server!.calls, seedUrl(RUN_ID)).length).toBeGreaterThan(
          readsBefore + 1,
        ),
      { timeout: 20_000 },
    );
    expect(root.querySelector(PLACEHOLDER)).not.toBeNull();
    expect(root.querySelector("[data-run-completion]")).toBeNull();
    expect(root.textContent).not.toMatch(/could not be loaded here/i);
    expect(cardCounts(root)).toEqual({
      reviewCards: 0, slots: 1, placeholders: 1, promptWindows: 0, settledExchanges: 0,
    });
    expect(transcriptShape(root)).toEqual(shapeAtStart);

    // ---- MOMENT 3: the review opens ----------------------------------------
    seed = seedBody({ status: "completed", reviewGate: { ref: GATE_REF, awaiting: false } });
    const card = await waitFor(
      () => {
        const el = root.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review card never arrived in the widget");
        return el;
      },
      { timeout: 20_000 },
    );
    await waitFor(() => expect(root.querySelector(APPROVE)).not.toBeNull());
    expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
    expect(root.querySelector(SLOT)?.contains(card)).toBe(true);
    expect(cardCounts(root)).toEqual({
      reviewCards: 1, slots: 1, placeholders: 0, promptWindows: 0, settledExchanges: 0,
    });
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expectBrokered(callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH)[0], "the resolve");
    expectEveryLifecycleCallBrokered(server.calls);
    expect(transcriptShape(root)).toEqual(shapeAtStart);

    // ---- MOMENT 4: the decision, through the card's own bar -----------------
    gate = SETTLED;
    fireEvent.click(root.querySelector<HTMLButtonElement>(APPROVE)!);
    await waitFor(() =>
      expect(callsTo(server!.calls, LIFECYCLE_VIEW_DECIDE_PATH).length).toBeGreaterThan(0),
    );
    expectBrokered(callsTo(server.calls, LIFECYCLE_VIEW_DECIDE_PATH)[0], "the decide");
    await waitFor(() =>
      expect(
        root.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-state"),
      ).toBe("settled"),
    );
    expect(cardCounts(root)).toEqual({
      reviewCards: 1, slots: 1, placeholders: 0, promptWindows: 0, settledExchanges: 0,
    });
    expect(transcriptShape(root)).toEqual(shapeAtStart);
    expectEveryLifecycleCallBrokered(server.calls);
    expectNoCookieAction();

    // ---- THE RELOAD: the same persisted turn, mounted afresh ----------------
    // Nothing about the card is client state, so it draws again from what the
    // server holds — settled now — with no second decision.
    first.unmount();
    const resolvesBeforeReload = callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH).length;
    const again = await mountSurface("widget", { messages: JSON.parse(persisted) });
    const reloaded = again.container as HTMLElement;
    await waitFor(
      () =>
        expect(
          reloaded.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-state"),
        ).toBe("settled"),
      { timeout: 20_000 },
    );
    expect(reloaded.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-host")).toBe(
      "site_widget",
    );
    expect(cardCounts(reloaded)).toEqual({
      reviewCards: 1, slots: 1, placeholders: 0, promptWindows: 0, settledExchanges: 0,
    });
    expect(transcriptShape(reloaded)).toEqual(shapeAtStart);
    expect(callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH).length).toBeGreaterThan(
      resolvesBeforeReload,
    );
    expect(callsTo(server.calls, LIFECYCLE_VIEW_DECIDE_PATH)).toHaveLength(1);
    expectEveryLifecycleCallBrokered(server.calls);
    expectNoCookieAction();
    // The persisted wire is unchanged: no new turn and no new tool call.
    expect(toolCallsIn(JSON.parse(persisted))).toBe(1);
    expect(JSON.stringify(namedStartTranscript())).toBe(persisted);
  }, 120_000);

  it("draws a still-pending review again after the third-party page is reloaded", async () => {
    server = installTurnServer({
      seed: () => seedBody({ status: "completed", reviewGate: { ref: GATE_REF, awaiting: false } }),
      gate: () => PENDING,
      messages: namedStartTranscript(),
    });
    const { container } = await mountSurface("widget", { messages: namedStartTranscript() });
    const root = container as HTMLElement;
    const card = await waitFor(
      () => {
        const el = root.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the restored turn drew no review card");
        return el;
      },
      { timeout: 20_000 },
    );
    await waitFor(() => expect(root.querySelector(APPROVE)).not.toBeNull());
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(cardCounts(root)).toEqual({
      reviewCards: 1, slots: 1, placeholders: 0, promptWindows: 0, settledExchanges: 0,
    });
    expectBrokered(callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH)[0], "the resolve");
    expectEveryLifecycleCallBrokered(server.calls);
    expectNoCookieAction();
  }, 60_000);

  // cinatra#4217 (R76 MUST-FIX 2): the frame renews its sign-in while the turn
  // stays open, and the server refuses the token it renewed away from. The
  // swap from the working placeholder to the review screen is learned through
  // the run card's slot reader, so a reader that kept its first headers would
  // keep the placeholder up for ever after a renewal. Only the run route
  // refuses the spent token here: that is the read this hunk rebuilds, and the
  // panel's own tick already builds its headers on every look.
  it("after a renewal the open turn still swaps the working placeholder for the review screen", async () => {
    let userToken = "cwu_first";
    const spent = new Set<string>();
    const headers = vi
      .spyOn(WIDGET_LIFECYCLE_SURFACE.auth, "headers")
      .mockImplementation(() => ({
        Authorization: "Bearer cit_site",
        "X-Cinatra-Widget-User-Token": userToken,
        "X-Cinatra-Widget-Assistant": "wordpress",
        "X-Cinatra-Widget-Origin": "https://blog.example.com",
      }));
    try {
      let seed = seedBody();
      server = installTurnServer({
        seed: () => seed,
        gate: () => PENDING,
        messages: namedStartTranscript(),
      });
      const served = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const token = headersOf(init ?? {})["x-cinatra-widget-user-token"];
        if (url === seedUrl(RUN_ID) && token !== undefined && spent.has(token)) {
          server!.calls.push({ url, init: init ?? {} });
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return served(input, init);
      }) as unknown as typeof fetch;

      const { container } = await mountSurface("widget", { messages: namedStartTranscript() });
      const root = container as HTMLElement;

      // Before the renewal: the run works, the slot is the placeholder.
      await waitFor(() => expect(root.querySelector(PLACEHOLDER)).not.toBeNull(), {
        timeout: 15_000,
      });
      expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("working");

      // Done, and the review has not opened yet: the placeholder stays.
      const readsBefore = callsTo(server.calls, seedUrl(RUN_ID)).length;
      seed = seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } });
      await waitFor(
        () =>
          expect(callsTo(server!.calls, seedUrl(RUN_ID)).length).toBeGreaterThan(
            readsBefore + 1,
          ),
        { timeout: 20_000 },
      );
      expect(root.querySelector(PLACEHOLDER)).not.toBeNull();
      expect(root.querySelector(REVIEW_CARD)).toBeNull();

      // The frame renews; the first token is spent. Then the review opens.
      userToken = "cwu_renewed";
      spent.add("cwu_first");
      seed = seedBody({ status: "completed", reviewGate: { ref: GATE_REF, awaiting: false } });

      const card = await waitFor(
        () => {
          const el = root.querySelector(REVIEW_CARD);
          if (!el) throw new Error("after the renewal the review screen never replaced the placeholder");
          return el;
        },
        { timeout: 20_000 },
      );
      await waitFor(() => expect(root.querySelector(APPROVE)).not.toBeNull());
      expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
      expect(root.querySelector(SLOT)?.contains(card)).toBe(true);
      expect(cardCounts(root)).toEqual({
        reviewCards: 1, slots: 1, placeholders: 0, promptWindows: 0, settledExchanges: 0,
      });
      expectNoCookieAction();
    } finally {
      headers.mockRestore();
    }
  }, 90_000);
});
