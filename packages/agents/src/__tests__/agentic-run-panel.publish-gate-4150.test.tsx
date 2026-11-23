// @vitest-environment jsdom
/**
 * cinatra#4150 -- a run parked at a PUBLISH gate is `pending_approval` with no gate context and no generic review task
 * (publish-decision-actions.ts, `holdRunAtPublishGate`). The panel draws the publish card for it and must NOT also
 * draw the generic approval banner (its "Review approval" link, its loading line and its Re-check) beside the card.
 * A pause that is not a publish gate keeps the generic banner exactly as before.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy(
    {} as Record<string, () => null>,
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        return StubIcon;
      },
      has: () => true,
      ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
    },
  );
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-9413",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const publishStateMock = vi.fn();
vi.mock("../publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: (input: { runId: string }) => publishStateMock(input),
}));

const RUN_ID = "run-4150-gate";
const PENDING = {
  state: "pending",
  runId: RUN_ID,
  agentName: "Blog publisher",
  rows: [{ label: "Title", value: "Spring launch" }],
  mayDecide: true,
};

// The stream's reading, mutable so a suite can move the run to another gate WITHOUT a status change.
const streamState = vi.hoisted(() => ({
  interruptContext: null as null | Record<string, unknown>,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: streamState.interruptContext,
    streamedText: "",
  })),
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

async function mountPanel(onRunChangeSignal?: (runId: string, signal: string) => void) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const element = () => (
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
      onRunChangeSignal={onRunChangeSignal}
    />
  );
  const mounted = render(element());
  await flush();
  return { ...mounted, rerenderPanel: async () => { mounted.rerender(element()); await flush(); } };
}

beforeEach(() => {
  cleanup();
  publishStateMock.mockReset();
  streamState.interruptContext = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel at a publish gate (cinatra#4150)", () => {
  it("draws the publish card and NOT the generic approval banner beside it", async () => {
    publishStateMock.mockImplementation(async () => PENDING);
    const mounted = await mountPanel();
    const cards = mounted.container.querySelectorAll('[data-lifecycle-card="publish_decision"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(screen.queryByRole("link", { name: "Review approval" })).toBeNull();
    expect(mounted.container.querySelector('[data-testid="hitl-recovery-state"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain("awaiting human approval");
  });

  it("a pause that is NOT a publish gate keeps the generic approval banner", async () => {
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const mounted = await mountPanel();
    expect(mounted.container.querySelector('[data-lifecycle-card="publish_decision"]')).toBeNull();
    expect(await screen.findByRole("link", { name: "Review approval" })).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="hitl-recovery-state"]')).not.toBeNull();
  });

  // ONE READ DECIDES BOTH SURFACES. Successive reads disagree here (a transient fault reads as `none`), and every
  // later read fails, which keeps the last answer. Whatever the first answer is, exactly one surface draws.
  const surfaces = (container: HTMLElement) => ({
    card: container.querySelectorAll('[data-lifecycle-card="publish_decision"]').length,
    banner: screen.queryAllByRole("link", { name: "Review approval" }).length,
  });

  it("a publish gate reached from an ORDINARY approval gate with NO status change re-reads and draws the card", async () => {
    // The run resumes from an ordinary approval gate and parks at its publish gate before any reading sees the
    // running state between them: the status is `pending_approval` both times. The card's read must still move.
    streamState.interruptContext = { schema: {}, xRenderer: "", values: {}, reviewTaskId: "task-ordinary-gate" };
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const signals: string[] = [];
    const mounted = await mountPanel((_runId, signal) => signals.push(signal));
    expect(surfaces(mounted.container).card).toBe(0);
    const before = signals.at(-1);

    streamState.interruptContext = null;
    publishStateMock.mockImplementation(async () => PENDING);
    await mounted.rerenderPanel();
    expect(surfaces(mounted.container)).toEqual({ card: 1, banner: 0 });
    // The host is told too, so a host that owns the read (a conversation turn) re-reads on the same move.
    expect(signals.at(-1)).not.toBe(before);
  });

  it("a SECOND publish gate after a settled one, with no status change between them, re-reads on the run's next reading", async () => {
    // Gate 1 is approved and the card reads `approved`; the run resumes and parks at gate 2 before any reading sees it
    // running, and no gate context marks either pause. The run's next reading must re-read the card.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "pending_approval", hitlContext: null, messages: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      publishStateMock.mockImplementation(async () => ({ ...PENDING, state: "approved", deciderName: "Ana" }));
      const mounted = await mountPanel();
      expect(mounted.container.querySelector('[data-conformance-id="publish-card-approved"]')).not.toBeNull();

      publishStateMock.mockImplementation(async () => PENDING);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await flush();
      expect(fetchMock).toHaveBeenCalled();
      const card = mounted.container.querySelector('[data-lifecycle-card="publish_decision"]');
      expect(card?.getAttribute("data-lifecycle-card-state")).toBe("pending");
      expect(surfaces(mounted.container)).toEqual({ card: 1, banner: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("a publish gate opened LATER, after a `none` read between gates, with no signal change, draws the card on the read's next tick", async () => {
    // The review finding's timing on this panel: the ordinary gate clears, the read taken between gates answers
    // `none`, the status stays `pending_approval`, and the run's own reading does not land (the row read fails), so
    // the change signal the panel computes does not move when the publish decision opens afterwards.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    try {
      streamState.interruptContext = { schema: {}, xRenderer: "", values: {}, reviewTaskId: "task-ordinary-gate" };
      publishStateMock.mockImplementation(async () => ({ state: "none" }));
      const signals: string[] = [];
      const mounted = await mountPanel((_runId, signal) => signals.push(signal));
      streamState.interruptContext = null;
      await mounted.rerenderPanel();
      expect(surfaces(mounted.container).card).toBe(0);
      const signalBetweenGates = signals.at(-1);

      publishStateMock.mockImplementation(async () => PENDING);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await flush();
      expect(signals.at(-1)).toBe(signalBetweenGates);
      expect(surfaces(mounted.container)).toEqual({ card: 1, banner: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("reads pending then none: the card draws and the banner does not", async () => {
    publishStateMock
      .mockImplementationOnce(async () => PENDING)
      .mockImplementationOnce(async () => ({ state: "none" }))
      .mockImplementation(async () => {
        throw new Error("transient");
      });
    const mounted = await mountPanel();
    expect(surfaces(mounted.container)).toEqual({ card: 1, banner: 0 });
  });

  it("reads none then pending: the banner draws and the card does not", async () => {
    publishStateMock
      .mockImplementationOnce(async () => ({ state: "none" }))
      .mockImplementationOnce(async () => PENDING)
      .mockImplementation(async () => {
        throw new Error("transient");
      });
    const mounted = await mountPanel();
    expect(surfaces(mounted.container)).toEqual({ card: 0, banner: 1 });
  });

  it("a FAILED read with no earlier answer keeps the generic banner: never neither surface", async () => {
    publishStateMock.mockImplementation(async () => {
      throw new Error("transient");
    });
    const mounted = await mountPanel();
    expect(surfaces(mounted.container)).toEqual({ card: 0, banner: 1 });
  });
});
