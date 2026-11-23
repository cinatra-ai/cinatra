// @vitest-environment jsdom
// THE PUBLISH CARD'S CONVERSATION MOUNT (cinatra#4150), through the REAL shared column on both of its arms.
//
// The column mounts the card at the `agent_run` dispatch part's own slot, beside the hitl screen and outside the
// inline run card's subtree, keyed by the run alone. These arms prove the mount draws exactly one card when the run
// has an open publish decision, reads through the transport its host declares (the session action on /chat, the
// broker GET on the widget), and draws NOTHING when there is no open decision.

import React from "react";
import { act, cleanup } from "@testing-library/react";
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
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const holdStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
// The HITL screen card's own server-only entry, stubbed for the same reason
// (cinatra#2930, lifecycle-b W3): the column mounts that card beside the §V one
// now, and an unstubbed `"use server"` module fails the whole lazy chat chunk.
// The default answer is "no screen", so a suite that is not about this kind sees
// exactly what it saw before the card existed.
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
// The publish card's own session entry (cinatra#4150); "none" unless its own arm runs.
const publishStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: () => publishStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

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
// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. The stand-in declares the SAME host the shipped panel declares, so a
// card found inside it is still recognisable as a run-card mount rather than a
// conversation one. It keeps the change-signal report the column hands the shipped panel, so a suite can move the run
// exactly as the panel reports it (the panel's own suite pins how the panel computes that signal).
const statusReporters = vi.hoisted(() => new Map<string, (runId: string, signal: string, status?: string) => void>());
const panelReads = vi.hoisted(() => new Map<string, { state: { state: string } | null } | undefined>());
// The review reading the stand-in reports, as the shipped panel reports its own (`onReviewReadingChange`): a case can
// have the panel still report a review it retains while the run has moved on to its publish gate.
const panelReview = vi.hoisted(() => ({ draws: false }));
vi.mock("../inline-agent-run-card", async () => {
  const { useEffect } = await import("react");
  return {
    InlineAgentRunCard: ({
      runId,
      onRunChangeSignal,
      onReviewReadingChange,
      publishRead,
    }: {
      runId: string;
      onRunChangeSignal?: (runId: string, signal: string, status?: string) => void;
      onReviewReadingChange?: (runId: string, drawsReview: boolean) => void;
      publishRead?: { state: { state: string } | null };
    }) => {
      if (onRunChangeSignal) statusReporters.set(runId, onRunChangeSignal);
      panelReads.set(runId, publishRead);
      const draws = panelReview.draws;
      useEffect(() => {
        onReviewReadingChange?.(runId, draws);
      }, [onReviewReadingChange, runId, draws]);
      return <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />;
    },
  };
});

import {
  HELD_RUN_ID,
  installWidgetServiceStub,
  lifecycleHeldTranscript,
  mountSurface,
  type SurfaceName,
} from "./conversation-column-harness";

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

const CARD = '[data-lifecycle-card="publish_decision"]';
const BROKER = "/api/lifecycle-views/publish-decision";
const PENDING = {
  state: "pending",
  runId: HELD_RUN_ID,
  agentName: "Proof agent",
  rows: [{ label: "Title", value: "Spring launch" }],
  mayDecide: true,
} as Record<string, unknown>;

let stub: ReturnType<typeof installWidgetServiceStub> | null = null;

// The widget reads the run's skills hold through its broker; `none` lets the column mount the run panel there too.
const NO_HOLD = { recommendationHold: () => ({ state: "none" }) };

async function mountArm(surface: SurfaceName, open: boolean, withPanel = false) {
  const answer = open ? PENDING : { state: "none" };
  publishStateMock.mockImplementation(async () => answer);
  stub = installWidgetServiceStub({ publishDecision: () => answer, ...(withPanel ? NO_HOLD : {}) });
  const mounted = await mountSurface(surface, { messages: lifecycleHeldTranscript() });
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  const root = mounted.container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`);
  if (!root) throw new Error(`the ${surface} surface did not mount`);
  return root;
}

beforeEach(() => {
  publishStateMock.mockImplementation(async () => ({ state: "none" }));
  hitlScreenStateMock.mockImplementation(async () => ({ state: "none" }));
});

afterEach(() => {
  panelReview.draws = false;
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
  statusReporters.clear();
  panelReads.clear();
  cleanup();
  stub?.restore();
  stub = null;
  vi.clearAllMocks();
});

describe("the publish card on the conversation hosts (cinatra#4150)", () => {
  it.each([
    ["chat", "chat_thread"],
    ["widget", "site_widget"],
  ] as const)("%s: an open decision draws EXACTLY ONE card at the run's own slot, under %s", async (surface, host) => {
    const root = await mountArm(surface, true);
    const cards = root.querySelectorAll<HTMLElement>(CARD);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.getAttribute("data-lifecycle-card-host")).toBe(host);
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(card.getAttribute("data-conformance-id")).toBe("publish-card");
    // The run's own slot, and never inside the inline run card's subtree.
    expect(card.closest(`[data-agent-run-slot="${HELD_RUN_ID}"]`)).not.toBeNull();
    expect(card.closest('[data-lifecycle-card-host="run_card"]')).toBeNull();
    // Both controls are drawn; no host passes a decide door yet, so neither can send.
    for (const action of ["decline-publish -> declined", "approve-publish -> released"]) {
      const control = card.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      expect(control, action).not.toBeNull();
      expect(control!.disabled, action).toBe(true);
    }
  });

  it.each(["chat", "widget"] as const)("%s: with NO open decision the mount draws nothing", async (surface) => {
    const root = await mountArm(surface, false);
    expect(root.querySelector(CARD)).toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-card"]')).toBeNull();
    // The turn itself still stands: the mount withholds only its own card.
    expect(root.querySelector(`[data-agent-run-slot="${HELD_RUN_ID}"]`)).not.toBeNull();
  });

  it.each(["chat", "widget"] as const)(
    "%s: a decision the run opens AFTER the first read answered none draws the card, with no reload and no focus",
    async (surface) => {
      const root = await mountArm(surface, false, true);
      expect(root.querySelector(CARD)).toBeNull();
      // The run, still working at the first read, now parks at its publish gate; the tab keeps its focus.
      publishStateMock.mockImplementation(async () => PENDING);
      stub?.restore();
      stub = installWidgetServiceStub({ publishDecision: () => PENDING, ...NO_HOLD });
      const report = statusReporters.get(HELD_RUN_ID);
      expect(report, "the column hands the run panel its change-signal report").toBeTypeOf("function");
      await act(async () => {
        report!(HELD_RUN_ID, "running");
        report!(HELD_RUN_ID, "pending_approval");
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });
      const cards = root.querySelectorAll<HTMLElement>(CARD);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.getAttribute("data-lifecycle-card-state")).toBe("pending");
      // The panel decides its approval banner from the SAME read the card drew, so the two cannot disagree.
      expect(panelReads.get(HELD_RUN_ID)?.state?.state).toBe("pending");
    },
  );

  it.each(["chat", "widget"] as const)(
    "%s: a publish gate the run reaches from an ORDINARY approval gate, under the SAME status, re-reads and draws the card",
    async (surface) => {
      const root = await mountArm(surface, false, true);
      const report = statusReporters.get(HELD_RUN_ID);
      expect(report, "the column hands the run panel its change-signal report").toBeTypeOf("function");
      // The run waits at an ordinary approval gate: `pending_approval`, and the card reads `none`.
      await act(async () => {
        report!(HELD_RUN_ID, "pending_approval:gate:task-ordinary::");
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(root.querySelector(CARD)).toBeNull();
      // It resumes and parks at its publish gate before any reading sees it running: still `pending_approval`, now
      // with no gate context, which is what the panel reports for that pause.
      publishStateMock.mockImplementation(async () => PENDING);
      stub?.restore();
      stub = installWidgetServiceStub({ publishDecision: () => PENDING, ...NO_HOLD });
      await act(async () => {
        report!(HELD_RUN_ID, "pending_approval:no-gate:1");
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });
      const cards = root.querySelectorAll<HTMLElement>(CARD);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.getAttribute("data-lifecycle-card-state")).toBe("pending");
      expect(panelReads.get(HELD_RUN_ID)?.state?.state).toBe("pending");
    },
  );

  it.each(["chat", "widget"] as const)(
    "%s: a publish gate opened LATER, after a `none` read between gates, with NO signal change, draws the card on the read's next tick",
    async (surface) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const root = await mountArm(surface, false, true);
        const report = statusReporters.get(HELD_RUN_ID);
        expect(report, "the column hands the run panel its change-signal report").toBeTypeOf("function");
        // The ordinary gate clears and the read taken between gates answers `none`; the status stays.
        await act(async () => {
          report!(HELD_RUN_ID, "pending_approval:no-gate:0", "pending_approval");
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
        });
        expect(root.querySelector(CARD)).toBeNull();
        // The publish decision opens with no report at all from the panel.
        publishStateMock.mockImplementation(async () => PENDING);
        stub?.restore();
        stub = installWidgetServiceStub({ publishDecision: () => PENDING, ...NO_HOLD });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_100);
        });
        await act(async () => {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
        });
        const cards = root.querySelectorAll<HTMLElement>(CARD);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.getAttribute("data-lifecycle-card-state")).toBe("pending");
        expect(panelReads.get(HELD_RUN_ID)?.state?.state).toBe("pending");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // ONE HELD-RUN CARD PER TURN. A run parked at its publish gate is parked THERE and nowhere else, so while the publish
  // read positively answers `pending` an hitl screen for the same run is a stale reading (its read resolved first, or
  // its re-read failed and kept the last answer) and the publish card is the turn's only card.
  const HITL_CARD = '[data-lifecycle-card="agent_hitl_screen"]';
  const HITL_ASKING = {
    state: "asking",
    runId: HELD_RUN_ID,
    screenRef: "hitl-screen-ref-4150",
    gate: {
      reviewTaskId: "task-4150",
      xRenderer: "cinatra.schema-field:output",
      inputSchema: { type: "object", properties: { answer: { type: "string" } } },
      currentValues: {},
      fieldName: "answer",
    },
  } as Record<string, unknown>;

  async function mountWithHitl(surface: SurfaceName, open: boolean) {
    hitlScreenStateMock.mockImplementation(async () => HITL_ASKING);
    const answer = open ? PENDING : { state: "none" };
    publishStateMock.mockImplementation(async () => answer);
    stub = installWidgetServiceStub({ publishDecision: () => answer, hitlScreen: () => HITL_ASKING });
    const mounted = await mountSurface(surface, { messages: lifecycleHeldTranscript() });
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    const root = mounted.container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`);
    if (!root) throw new Error(`the ${surface} surface did not mount`);
    return root;
  }

  it.each(["chat", "widget"] as const)(
    "%s: an hitl screen still answering `asking` beside an OPEN publish decision is stale: EXACTLY ONE card, the publish card",
    async (surface) => {
      const root = await mountWithHitl(surface, true);
      const cards = root.querySelectorAll<HTMLElement>(`${CARD}, ${HITL_CARD}`);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.getAttribute("data-lifecycle-card")).toBe("publish_decision");
      expect(cards[0]!.getAttribute("data-lifecycle-card-state")).toBe("pending");
    },
  );

  it.each(["chat", "widget"] as const)(
    "%s: a run that moves from an hitl question to its publish gate, with the hitl re-read FAILING, shows only the publish card",
    async (surface) => {
      const root = await mountWithHitl(surface, false);
      // The question is open and no publish decision is: the hitl screen is the turn's one card.
      expect(root.querySelectorAll(HITL_CARD)).toHaveLength(1);
      expect(root.querySelector(CARD)).toBeNull();
      // The run answers and parks at its publish gate; every hitl re-read now fails, so that card keeps `asking`.
      hitlScreenStateMock.mockImplementation(async () => {
        throw new Error("hitl re-read failed");
      });
      publishStateMock.mockImplementation(async () => PENDING);
      stub?.restore();
      stub = installWidgetServiceStub({ publishDecision: () => PENDING, hitlScreen: () => null });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await Promise.resolve();
      });
      const cards = root.querySelectorAll<HTMLElement>(`${CARD}, ${HITL_CARD}`);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.getAttribute("data-lifecycle-card")).toBe("publish_decision");
    },
  );

  it.each(["chat", "widget"] as const)(
    "%s: with NO open publish decision an asking hitl screen still draws, alone",
    async (surface) => {
      const root = await mountWithHitl(surface, false);
      const cards = root.querySelectorAll<HTMLElement>(`${CARD}, ${HITL_CARD}`);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.getAttribute("data-lifecycle-card")).toBe("agent_hitl_screen");
    },
  );

  // THE REVIEW REVEAL. A decided turn stands its run panel down and reveals it only while the panel reports a review.
  // A review the panel still reports from a retained produced-review reading is stale while the publish read
  // positively answers `pending`: the publish card is the turn's one held-run surface, and the panel stays stood down.
  const CONFIRMED = { state: "confirmed", runId: HELD_RUN_ID, skillNames: ["blog-content"] } as Record<string, unknown>;
  async function mountDecidedWithReview(surface: SurfaceName, open: boolean) {
    holdStateMock.mockImplementation(async () => CONFIRMED);
    panelReview.draws = true;
    const answer = open ? PENDING : { state: "none" };
    publishStateMock.mockImplementation(async () => answer);
    stub = installWidgetServiceStub({ publishDecision: () => answer, recommendationHold: () => CONFIRMED });
    const mounted = await mountSurface(surface, { messages: lifecycleHeldTranscript() });
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    const root = mounted.container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`);
    if (!root) throw new Error(`the ${surface} surface did not mount`);
    const panel = root.querySelector<HTMLElement>(`[data-inline-run-card="${HELD_RUN_ID}"]`);
    if (!panel) throw new Error(`the ${surface} turn did not mount its run panel`);
    return { root, panel };
  }

  it.each(["chat", "widget"] as const)(
    "%s: a STALE review report beside an OPEN publish decision does not reveal the stood-down panel",
    async (surface) => {
      const { root, panel } = await mountDecidedWithReview(surface, true);
      expect(root.querySelectorAll(CARD)).toHaveLength(1);
      expect(root.querySelector(CARD)!.getAttribute("data-lifecycle-card-state")).toBe("pending");
      const wrapper = panel.closest(`[data-inline-run-panel-stood-down="${HELD_RUN_ID}"]`);
      expect(wrapper, "the panel's stale review is revealed beside the publish card").not.toBeNull();
      expect(wrapper!.hasAttribute("hidden")).toBe(true);
    },
  );

  it.each(["chat", "widget"] as const)(
    "%s: with NO open publish decision the panel's review report still reveals it",
    async (surface) => {
      const { root, panel } = await mountDecidedWithReview(surface, false);
      expect(root.querySelector(CARD)).toBeNull();
      expect(panel.closest("[data-inline-run-panel-stood-down]")).toBeNull();
      expect(panel.closest("[hidden]")).toBeNull();
    },
  );

  it("/chat reads through the session action and never the broker", async () => {
    await mountArm("chat", true);
    expect(publishStateMock).toHaveBeenCalled();
    expect((stub?.calls ?? []).some((c) => c.url.startsWith(BROKER))).toBe(false);
  });

  it("the widget reads through the broker GET with its own credential, never the session action", async () => {
    await mountArm("widget", true);
    const reads = (stub?.calls ?? []).filter((c) => c.url.startsWith(`${BROKER}?`));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]!.url).toBe(`${BROKER}?runId=${encodeURIComponent(HELD_RUN_ID)}`);
    expect(reads[0]!.init.method).toBe("GET");
    expect(reads[0]!.init.credentials).toBe("omit");
    expect(reads[0]!.init.body).toBeUndefined();
    expect(publishStateMock).not.toHaveBeenCalled();
  });
});
