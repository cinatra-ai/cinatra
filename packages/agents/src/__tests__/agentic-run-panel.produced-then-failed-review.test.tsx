// @vitest-environment jsdom
/**
 * A RUN WHOSE OUTPUT WAS GENERATED AND WHOSE TASK THEN FAILED STILL SHOWS ITS
 * REVIEW (cinatra#3051).
 *
 * THE MEASUREMENT THIS PINS. The sixth proof round drove a real run from inside
 * the embedded widget's own composer. The run generated its output, its task
 * then failed, and six seconds later its review gate was minted PENDING on the
 * produced artifact. Over a 94-sample re-read NEITHER surface drew a review
 * card: both widget columns held the working placeholder and the app's own run
 * surface drew none either, while the row said `failed` and the gate said
 * `pending`.
 *
 * WHY NOTHING DREW IT, and it took both halves to close the question:
 *
 *   · the run card is the review screen's own placeholder, and it admitted the
 *     run's review slot only for `status === "completed"`; and
 *   · the platform's injected delivery is deliberately suppressed for exactly
 *     the turn that draws the run card, on the ground that the run card shows
 *     the gate.
 *
 * So on a run that ended any other way the first half was shut and the second
 * half had stood down for it, and the question reached no host at all.
 *
 * WHAT THE RATIFIED DRAWING SAYS, verbatim, and it is not a status:
 *
 *   "The placeholder is replaced, in place, by the review. When the run's
 *    output is generated, the placeholder becomes the Review requested screen —
 *    the same slot, in the same turn. It happens on its own: the reader neither
 *    asks for the card nor presses anything to bring it."
 *
 *   "Four hosts, one card set. … Every card appears on every host, and it is
 *    the same card wherever it appears."
 *
 *   "What holds a card back is the reader, not the host."
 *
 * AND THE ONE THING THAT DOES STILL HOLD IT BACK, kept rather than lost: a run
 * carries its gate for ever, so a SETTLED gate must not take the slot back from
 * the run's own current reading — the failure block with its Retry. Only an
 * OPEN question does, and the control below is that reading.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.produced-then-failed-review.test.tsx
 */
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const approveReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
const rejectReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../hitl-actions", () => ({ approveReviewTask, rejectReviewTask }));

const getAgentBuilderTask = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask }));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3051-failed",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

// No live stream: these pins are about what the run's OWN state makes the card
// draw, and a stream would supply a status of its own.
vi.mock("../use-ag-ui-run-stream", () => ({
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

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";

const RUN_ID = "run-3051-failed";
const GATE_REF = "lcr-opaque-3051-failed";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

/** The embed's own declaration — structural values, not real ones. */
const WIDGET_AUTH = {
  headers: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
    "X-Cinatra-Widget-Assistant": "wordpress",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }),
  credentials: "omit" as const,
};
const WIDGET_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

const onWidget = (children: ReactNode) => (
  <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={WIDGET_FRAME}>
    {children}
  </LifecycleCardSurfaceProvider>
);

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

function stubFetch(run: () => Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(run()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESOLVE_PENDING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * THE RUN THE ROUND MEASURED, as its own seed route answers it: the task failed
 * with the runtime's own uninformative catch-all, and the gate minted on what
 * the run produced is still open.
 */
function producedThenFailed(over: Record<string, unknown> = {}) {
  return {
    status: "failed",
    error: "WayFlow task failed",
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: GATE_REF, awaiting: false, pending: true },
    ...over,
  };
}

function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "failed",
    initialError: "WayFlow task failed",
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    templateId: "tmpl-3051",
    surface: "chat" as "agent-detail" | "chat",
    ...over,
  };
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the output was generated and the task then failed", () => {
  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" — the slot holds the review, not the placeholder and not silence',
    async (surface) => {
      stubFetch(() => producedThenFailed());
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...panelProps({
            surface,
            initialReviewGate: { ref: GATE_REF, awaiting: false, pending: true },
          })}
        />,
      );

      const card = await waitFor(
        () => {
          const el = document.querySelector(REVIEW_CARD);
          if (!el) throw new Error("no review card drew for the pending gate");
          return el;
        },
        { timeout: 10_000 },
      );
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "review",
      );
      expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
      expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
      expect(screen.queryByText(/Review requested/i)).not.toBeNull();
    },
    15_000,
  );

  it("draws on the widget host too, as the same card, on the reader's own proof", async () => {
    stubFetch(() => producedThenFailed());
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            initialReviewGate: { ref: GATE_REF, awaiting: false, pending: true },
          })}
        />,
      ),
    );

    const card = await waitFor(
      () => {
        const el = document.querySelector(REVIEW_CARD);
        if (!el) throw new Error("no review card drew for the pending gate");
        return el;
      },
      { timeout: 10_000 },
    );
    expect(document.querySelectorAll(REVIEW_CARD)).toHaveLength(1);
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
  }, 15_000);

  it("finds the gate through its own look, in one mount, exactly as the round drove it", async () => {
    // THE ROUND'S OWN SEQUENCE, in one mount and with nobody re-opening
    // anything: the surface is mounted while the run works and knows of no
    // review; the run's output is generated and its task then fails; the gate
    // is minted on the produced artifact a moment later. The surface has to go
    // and look after the run ENDS — and looking only under `completed` is why
    // it never did.
    let body: Record<string, unknown> = {
      status: "running",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: null,
      reviewGate: { ref: null, awaiting: false, pending: false },
    };
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "running",
          initialError: null,
          initialReviewGate: { ref: null, awaiting: false, pending: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector(REVIEW_CARD)).toBeNull();

    body = producedThenFailed();

    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) {
          throw new Error("the surface never looked for the run's review");
        }
      },
      { timeout: 10_000 },
    );
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  }, 20_000);
});

describe("the run was released into its schedule first, and the widget still hears the end", () => {
  // THE ROUND'S ACTUAL SEQUENCE. The run was set up inside the widget, its
  // schedule was released, and only then did it run, produce its output and
  // end. On the widget the app's cookie-session run stream stands down — there
  // is no wire — so the panel's own tick is the ONLY transport. The tick used to
  // stop at any status that was neither live nor a pending approval, and
  // `pending_trigger` is exactly that: the surface sat on the last status it had
  // been told while the row ran on without it.
  it("keeps reading past pending_trigger, and draws the review the run ended with", async () => {
    let body: Record<string, unknown> = {
      status: "pending_trigger",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: null,
      reviewGate: { ref: null, awaiting: false, pending: false },
    };
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            // The wire is ENABLED on the run itself; it is the HOST that makes
            // it stand down, which is the road this pin is about.
            agUiEnabled: true,
            initialStatus: "pending_trigger",
            initialError: null,
            initialReviewGate: { ref: null, awaiting: false, pending: false },
          })}
        />,
      ),
    );

    // The schedule step's own reading, and no review anywhere yet.
    await waitFor(() => expect(document.querySelector(REVIEW_CARD)).toBeNull());

    // The trigger fires, the run works, produces its output and ends. Nobody
    // re-opens anything.
    body = producedThenFailed();

    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) {
          throw new Error("the widget never heard the run end");
        }
      },
      { timeout: 15_000 },
    );
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
  }, 25_000);
});

describe("what still holds the review back", () => {
  it("a SETTLED gate does not take the slot from the run's own failure reading", async () => {
    stubFetch(() => producedThenFailed({ reviewGate: { ref: GATE_REF, awaiting: false, pending: false } }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialReviewGate: { ref: GATE_REF, awaiting: false, pending: false },
        })}
      />,
    );

    // The run's own terminal rendering, which names the failure.
    await waitFor(() => {
      if (!screen.queryByText(/Agentic Run Progress/i)) {
        throw new Error("the run's own reading did not draw");
      }
    });
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
    expect(document.querySelector(SLOT)).toBeNull();
  }, 15_000);

  it("a run with no gate at all keeps its failure reading and holds no placeholder", async () => {
    stubFetch(() => producedThenFailed({ reviewGate: { ref: null, awaiting: false, pending: false } }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({ initialReviewGate: { ref: null, awaiting: false, pending: false } })}
      />,
    );

    await waitFor(() => {
      if (!screen.queryByText(/Agentic Run Progress/i)) {
        throw new Error("the run's own reading did not draw");
      }
    });
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
  }, 15_000);
});


describe("a PAUSED run keeps its own reading, on every host (convergence)", () => {
  // The run page's flow panel leaves `stopped` on its pause branch so the
  // reader keeps the affordance that resumes the run. If this panel drew the
  // review there, the SAME run would answer two ways on two hosts — which the
  // ratified drawing forbids in as many words: "Every card appears on every
  // host, and it is the same card wherever it appears." Nothing measured says
  // a paused run was hiding a pending gate, so the two panels agree the
  // conservative way and `stopped` keeps the branches it shipped with.
  it("does not take the slot for a stopped run, open gate or not", async () => {
    stubFetch(() => ({
      status: "stopped",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: null,
      reviewGate: { ref: GATE_REF, awaiting: false, pending: true },
    }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      onWidget(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: "stopped",
            initialError: null,
            initialReviewGate: { ref: GATE_REF, awaiting: false, pending: true },
          })}
        />,
      ),
    );

    // A settle window: the slot IS read for a stopped run (looking is one
    // question), and the reading must still not put the review in the slot.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).not.toBe(
      "review",
    );
  }, 20_000);
});

describe("the until-terminal tick is belted and never stacks (convergence)", () => {
  // "Until the run ends" is not the same sentence as "for ever". A run can stay
  // non-terminal by design and not because anyone is waiting on it — the
  // defining run of a recurring schedule keeps its status while each cron tick
  // launches a clone — so the tick that hears a released run end is bounded,
  // and a tick that finds the previous read still out skips rather than
  // stacking a second request on top of it.
  const PARKED = {
    status: "pending_trigger",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false, pending: false },
  };

  const snapshotCalls = (mock: ReturnType<typeof vi.fn>) =>
    mock.mock.calls.filter((call) => String(call[0]).includes("/api/agents/runs/")).length;

  it("stops asking after its belt, and asks nothing more afterwards", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch(() => PARKED);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      const { UNTIL_TERMINAL_TICK_LIMIT } = await import("../lifecycle-card-runtime");
      render(
        onWidget(
          <AgenticRunPanel
            {...panelProps({
              agUiEnabled: true,
              initialStatus: "pending_trigger",
              initialError: null,
              initialReviewGate: { ref: null, awaiting: false, pending: false },
            })}
          />,
        ),
      );

      // Well past the belt.
      await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
      // The belt's own arithmetic: the tick that SPENDS the last look still
      // takes it, so a parked run costs exactly the belt plus that one read —
      // and then nothing, which is the whole point.
      const atBelt = snapshotCalls(fetchMock);
      expect(atBelt).toBe(UNTIL_TERMINAL_TICK_LIMIT + 1);

      // And nothing more, for as long as the tab stays open.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(snapshotCalls(fetchMock)).toBe(atBelt);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("keeps ONE read in flight — a hung read does not queue the next ones", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        () => new Promise<Response>(() => {}), // never answers
      );
      vi.stubGlobal("fetch", fetchMock);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        onWidget(
          <AgenticRunPanel
            {...panelProps({
              agUiEnabled: true,
              initialStatus: "pending_trigger",
              initialError: null,
              initialReviewGate: { ref: null, awaiting: false, pending: false },
            })}
          />,
        ),
      );

      await vi.advanceTimersByTimeAsync(60 * 1000); // twelve ticks' worth
      expect(snapshotCalls(fetchMock)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
