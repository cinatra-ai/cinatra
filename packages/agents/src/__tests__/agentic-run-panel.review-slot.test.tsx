// @vitest-environment jsdom
/**
 * THE RUN CARD IS THE REVIEW SCREEN'S PLACEHOLDER, AND THEN THE SCREEN
 * (cinatra#2997).
 *
 * The maintainer's request for changes on pull request 2890, verbatim — it is
 * the whole specification these pins hold:
 *
 *   "The 'Agentic Run Progress' card should basically just be a card (maybe even
 *    an empty review screen) with a spinning icon which is a temporary
 *    placeholder for the review screen. Once the agent is done and the output
 *    generated, that 'Agentic Run Progress' card is being automatically replaced
 *    with the 'Review requested' screen. On the run page, the same is true.
 *    Also, the 'Open the run page' link in the top right below the 'Agentic Run
 *    Progress' card should be removed."
 *
 * (The link is the chat wrapper's, so it is pinned where it lived:
 *  packages/chat/src/__tests__/inline-agent-run-card-canonical-link.test.tsx.)
 *
 * What is pinned here, on the REAL component, on BOTH surfaces:
 *
 *   1. WHILE THE AGENT WORKS the card is the placeholder — the spinner and the
 *      empty review screen — and it says nothing else: no heading, no status
 *      word, no transcript.
 *   2. WHEN THE WORK OPENS A REVIEW the SAME slot holds the review screen, and
 *      the placeholder is gone. Nobody asked for it and no new turn happened:
 *      the panel read the run's own state and swapped.
 *   3. EXACTLY ONE review card draws when it does — one root, on the run_card
 *      host, in the one slot.
 *   4. A RUN THAT PRODUCED NOTHING REVIEWABLE keeps its completion notice. The
 *      request says nothing about that run, so nothing about it changes.
 *   5. A GATE THAT NEEDS INPUT still draws its form. A review on file does not
 *      hide the question the run is actually blocked on.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.review-slot.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// The spinner is the design system's. Kept REAL (not stubbed) so the pin reads
// the shipped component's own class on the shipped markup.
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
    runId: "run-2997",
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

// No live stream: these pins are about what the run's own STATE makes the card
// draw, and a stream would supply its own status.
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

const RUN_ID = "run-2997";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

/** The review card resolves its own gate server-side; this is the answer the
 *  core's own suite uses for an OPEN gate the reader may decide. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/**
 * One fetch stub for BOTH of the panel's reads: the lifecycle resolve the card
 * makes, and the run's own seed read the slot uses. `run` is what the seed
 * answers with, and it can change between ticks — which is how the live
 * replacement below is driven without touching the component.
 */
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

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false },
    ...over,
  };
}

function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    templateId: "tmpl-2997",
    surface: "agent-detail" as "agent-detail" | "chat",
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

describe("while the agent works, the card is the placeholder", () => {
  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" — the spinning icon and the empty review screen, and nothing else',
    async (surface) => {
      stubFetch(() => seedBody());
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...panelProps({ surface, initialReviewGate: { ref: null, awaiting: false } })}
        />,
      );

      const placeholder = await waitFor(() => {
        const el = document.querySelector(PLACEHOLDER);
        if (!el) throw new Error("no placeholder");
        return el;
      });
      // The spinning icon: the design system's own spinner, by its animation
      // class, inside the placeholder.
      expect(placeholder.querySelector("svg.animate-spin")).not.toBeNull();
      // THE EMPTY REVIEW SCREEN IS EMPTY (cinatra#3044). The ratified drawing's
      // section II enumerates what the placeholder is: "the card frame, and a
      // spinning icon, the indigo arc of Components section Skeleton / Spinner.
      // It names no status, reports no result and draws nothing to press." Its
      // own placeholder example draws the card box with one arc in it and
      // nothing else, so the frame stands empty behind the arc rather than
      // carrying the gate's bar motif. A graded set measured those bars beside
      // the arc; this is where they were pinned in.
      expect(placeholder.querySelector('[data-conformance-id="review-gate-loading"]')).toBeNull();
      // A card, and it is the WORKING reading of the one slot.
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "working",
      );
      // And nothing the words do not allow.
      expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
      expect(screen.queryByText(/No messages yet/i)).toBeNull();
      expect(screen.queryByText(/Waiting to start/i)).toBeNull();
      expect(document.querySelector("[data-run-completion]")).toBeNull();
    },
  );

  it("a queued run is working too — the work is under way, not reported on", async () => {
    stubFetch(() => seedBody({ status: "queued" }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "queued",
          initialReviewGate: { ref: null, awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(screen.queryByText(/Waiting to start/i)).toBeNull();
  });
});

describe("the placeholder is replaced, in place, by the review screen", () => {
  it.each([["chat" as const], ["agent-detail" as const]])(
    'surface="%s" — one mount: placeholder while working, the review screen once the review opens',
    async (surface) => {
      // The run is working, then finishes with its output's review open. The
      // panel is never re-mounted and nothing else is rendered: the swap is the
      // component reading the run's own state.
      let body = seedBody();
      stubFetch(() => body);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...panelProps({ surface, initialReviewGate: { ref: null, awaiting: false } })}
        />,
      );

      await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
      expect(document.querySelector(REVIEW_CARD)).toBeNull();

      body = seedBody({
        status: "completed",
        reviewGate: { ref: "lcr-opaque-2997", awaiting: false },
      });

      const card = await waitFor(
        () => {
          const el = document.querySelector(REVIEW_CARD);
          if (!el) throw new Error("the review screen did not arrive");
          return el;
        },
        { timeout: 10_000 },
      );

      // THE SAME SLOT, now reading `review`.
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "review",
      );
      expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
      // The placeholder is GONE — replaced, not accompanied.
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
      // It is the 'Review requested' screen, on the run card host.
      expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
      expect(card.getAttribute("data-lifecycle-card-host")).toBe("run_card");
      expect(screen.queryByText(/Review requested/i)).not.toBeNull();
      // And the progress card it replaced is not beside it.
      expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
      expect(document.querySelector("[data-run-completion]")).toBeNull();
    },
    15_000,
  );

  // THE FRAME THAT MUST NOT EXIST. A run reaches `completed` a moment before the
  // sweeper opens the review on what it produced. If the card reads "the run is
  // done, and I know of no review" for even one frame it paints the completion
  // notice, and the reader watches the finished run announce itself as having
  // nothing to review — immediately before the review appears. The whole point
  // of the placeholder is that this frame never happens, so it is watched for
  // rather than sampled.
  it("never paints the completion notice in the gap before the review opens", async () => {
    let body = seedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(
      <AgenticRunPanel
        {...panelProps({
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialReviewGate: { ref: null, awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());

    let completionEverDrawn = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector("[data-run-completion]")) completionEverDrawn = true;
    });
    observer.observe(container, { childList: true, subtree: true });

    // The run finishes; its review is a beat behind, and the outbox says so.
    body = seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } });
    await waitFor(
      () => {
        if (!vi.mocked(globalThis.fetch).mock.calls.some(
          (c) => String(c[0]).includes("/api/agents/runs/"),
        )) throw new Error("no read yet");
      },
      { timeout: 10_000 },
    );
    // Let the completed status and at least one slot read land.
    await new Promise((r) => setTimeout(r, 3000));
    expect(document.querySelector(PLACEHOLDER)).not.toBeNull();

    // Then the review opens, and the same slot becomes the screen.
    body = seedBody({
      status: "completed",
      reviewGate: { ref: "lcr-opaque-2997", awaiting: false },
    });
    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) throw new Error("no review yet");
      },
      { timeout: 10_000 },
    );
    observer.disconnect();

    expect(completionEverDrawn).toBe(false);
    expect(document.querySelector("[data-run-completion]")).toBeNull();
  }, 30_000);

  it("a run whose review is already open draws it on the FIRST paint", async () => {
    stubFetch(() =>
      seedBody({ status: "completed", reviewGate: { ref: "lcr-opaque-2997", awaiting: false } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "completed",
          initialReviewGate: { ref: "lcr-opaque-2997", awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(REVIEW_CARD)).not.toBeNull());
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  });

  it("draws EXACTLY ONE review card — one root, in the one slot", async () => {
    stubFetch(() =>
      seedBody({ status: "completed", reviewGate: { ref: "lcr-opaque-2997", awaiting: false } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "completed",
          initialReviewGate: { ref: "lcr-opaque-2997", awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(REVIEW_CARD)).not.toBeNull());
    expect(
      document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
    ).toBe(1);
    expect(document.querySelectorAll(SLOT).length).toBe(1);
  });

  it("the gate the run is PARKED on is addressed by its own ref, not the slot's", async () => {
    stubFetch(() =>
      seedBody({ status: "pending_approval", reviewGate: { ref: "lcr-from-slot", awaiting: false } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "pending_approval",
          initialHitlContext: {
            xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
            childRunId: null,
            reviewTaskId: "review-task-2997",
            inputSchema: { type: "object" },
            currentValues: { lifecycleCardRef: "lcr-parked-gate" },
          },
          initialReviewGate: { ref: "lcr-from-slot", awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(REVIEW_CARD)).not.toBeNull());
    // The card resolves by POSTing the ref it was handed; the pin reads which
    // ticket it asked with.
    const asked = (vi.mocked(globalThis.fetch).mock.calls as unknown[][])
      .filter((c) => !String(c[0]).includes("/api/agents/runs/"))
      .map((c) => String((c[1] as { body?: unknown } | undefined)?.body ?? ""));
    expect(asked.some((b) => b.includes("lcr-parked-gate"))).toBe(true);
    expect(asked.some((b) => b.includes("lcr-from-slot"))).toBe(false);
  });
});

describe("the answer goes stale when the run moves (cinatra#2997)", () => {
  // A run can complete, be retried, and complete AGAIN. The ticket from the
  // first completion is not the second completion's review, and keeping it would
  // draw the previous review's settled card over a run that is about to open a
  // new one. Freshness is keyed to the run's status and resolved DURING RENDER,
  // so there is no frame in which the stale answer is drawn.
  //
  // Pinned on the shared reader itself. A live panel learns a status change from
  // its stream, and driving a stream through the panel would be testing the
  // stream; what has to be true is a property of the reader, and this reads it
  // where it lives — the same reader BOTH run panels use.
  it("drops the answer the moment the run's status moves, and reads again", async () => {
    const { useRunReviewSlot } = await import("../lifecycle-card-runtime");
    const answers: Array<{ ref: string | null; awaiting: boolean } | null> = [
      { ref: "lcr-second-review", awaiting: false },
    ];
    const read = vi.fn(async () => answers.shift() ?? null);
    const seen: Array<{ ref: string | null; may: boolean }> = [];

    function Probe({ status }: { status: string }) {
      const { slot, mayStillOpen } = useRunReviewSlot({
        status,
        initial: { ref: "lcr-first-review", awaiting: false },
        read,
      });
      seen.push({ ref: slot.ref, may: mayStillOpen });
      return <div data-probe-ref={slot.ref ?? ""} data-probe-may={String(mayStillOpen)} />;
    }

    const { rerender } = render(<Probe status="completed" />);
    // The mount's own answer stands, and nothing is read for it.
    expect(document.querySelector("[data-probe-ref]")?.getAttribute("data-probe-ref")).toBe(
      "lcr-first-review",
    );
    expect(read).not.toHaveBeenCalled();

    // The run goes back to work: the first completion's ticket is dropped in the
    // SAME frame, never drawn under the new status.
    rerender(<Probe status="running" />);
    expect(document.querySelector("[data-probe-ref]")?.getAttribute("data-probe-ref")).toBe("");
    expect(seen.some((f) => f.ref === "lcr-first-review" && f.may)).toBe(false);

    // And it completes again: the reader looks afresh and the SECOND review is
    // what arrives — the first one never comes back.
    rerender(<Probe status="completed" />);
    expect(document.querySelector("[data-probe-ref]")?.getAttribute("data-probe-ref")).toBe("");
    await waitFor(() =>
      expect(
        document.querySelector("[data-probe-ref]")?.getAttribute("data-probe-ref"),
      ).toBe("lcr-second-review"),
    );
    expect(read).toHaveBeenCalledTimes(1);
    for (const frame of seen) {
      // At no point after the first completion did the first ticket draw again.
      expect(frame.ref === "lcr-first-review" ? seen.indexOf(frame) < 2 : true).toBe(true);
    }
  });

  // EVERY completed mount holds the placeholder for its first look, including
  // one that arrived with no slot at all (the run page's dev-preview child card
  // is the mount that does). Without it such a mount paints a completion notice
  // in front of a review nobody has asked about yet, and then swaps — which is
  // the flash the placeholder exists to prevent.
  it("an unseeded completed mount holds the placeholder for its FIRST look", async () => {
    const { useRunReviewSlot } = await import("../lifecycle-card-runtime");
    let resolveRead: (v: { ref: string | null; awaiting: boolean } | null) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<{ ref: string | null; awaiting: boolean } | null>((r) => {
          resolveRead = r;
        }),
    );
    function Probe() {
      const { slot, mayStillOpen } = useRunReviewSlot({ status: "completed", read });
      return (
        <div data-probe-may={String(mayStillOpen)} data-probe-ref={slot.ref ?? ""} />
      );
    }
    render(<Probe />);
    const may = () =>
      document.querySelector("[data-probe-may]")?.getAttribute("data-probe-may");
    expect(may()).toBe("true");
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(may()).toBe("true");

    resolveRead({ ref: "lcr-found", awaiting: false });
    await waitFor(() =>
      expect(
        document.querySelector("[data-probe-ref]")?.getAttribute("data-probe-ref"),
      ).toBe("lcr-found"),
    );
    expect(may()).toBe("false");
  });

  it("a read that FAILS is not an answer — it keeps looking, and stops holding the placeholder", async () => {
    const { useRunReviewSlot } = await import("../lifecycle-card-runtime");
    const read = vi.fn(async () => {
      throw new Error("transport down");
    });
    function Probe({ status }: { status: string }) {
      const { mayStillOpen } = useRunReviewSlot({
        status,
        initial: { ref: null, awaiting: false },
        read,
      });
      return <div data-probe-may={String(mayStillOpen)} />;
    }
    // The run was working when this surface mounted and has just finished, so
    // the mount's own answer no longer describes it and nothing has answered
    // under the new status yet.
    const { rerender } = render(<Probe status="running" />);
    rerender(<Probe status="completed" />);
    // It holds the placeholder while it has never heard back…
    expect(document.querySelector("[data-probe-may]")?.getAttribute("data-probe-may")).toBe(
      "true",
    );
    // …and lets go of it once the silence has gone on, while still looking.
    await waitFor(
      () =>
        expect(
          document.querySelector("[data-probe-may]")?.getAttribute("data-probe-may"),
        ).toBe("false"),
      { timeout: 30_000 },
    );
    expect(read.mock.calls.length).toBeGreaterThan(1);
  }, 40_000);
});

describe("the readings the request does not cover are untouched", () => {
  it("a run that produced nothing reviewable keeps its completion notice", async () => {
    stubFetch(() => seedBody({ status: "completed" }));
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "completed",
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialReviewGate: { ref: null, awaiting: false },
        })}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-run-completion]")).not.toBeNull(),
    );
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
    expect(screen.queryByText(/Agentic Run Progress/i)).not.toBeNull();
  });

  it("a run still waiting for its review keeps the placeholder up, not a completion notice", async () => {
    stubFetch(() =>
      seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "completed",
          agentId: "cinatra-ai/blog-draft-writer-agent",
          initialReviewGate: { ref: null, awaiting: true },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector("[data-run-completion]")).toBeNull();
  });

  // A RUN CARRIES ITS GATE FOR EVER. A run that was reviewed and then went back
  // to work — a retry, a re-trigger, a failure, a schedule — must not keep
  // showing the settled review in place of the state it is actually in. The
  // slot's ref draws only for a run that has FINISHED, which is the state the
  // request is about ("once the agent is done and the output generated").
  it.each([
    ["failed" as const, /Retry/i],
    ["pending_trigger" as const, /Agentic Run Progress/i],
    ["armed" as const, /Agentic Run Progress/i],
  ])(
    "a %s run with a gate on file draws its own state, not the review",
    async (runStatus, expected) => {
      stubFetch(() =>
        seedBody({ status: runStatus, reviewGate: { ref: "lcr-old-gate", awaiting: false } }),
      );
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        <AgenticRunPanel
          {...panelProps({
            initialStatus: runStatus,
            initialError: runStatus === "failed" ? "the run failed" : null,
            agentId: "cinatra-ai/blog-draft-writer-agent",
            initialReviewGate: { ref: "lcr-old-gate", awaiting: false },
          })}
        />,
      );

      expect(await screen.findByText(expected)).not.toBeNull();
      expect(document.querySelector(REVIEW_CARD)).toBeNull();
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
    },
  );

  it("a run that went BACK to work after a review draws the placeholder, not the settled card", async () => {
    stubFetch(() =>
      seedBody({ status: "running", reviewGate: { ref: "lcr-old-gate", awaiting: false } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "running",
          initialReviewGate: { ref: "lcr-old-gate", awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector(PLACEHOLDER)).not.toBeNull());
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
  });

  it("a gate that needs INPUT still draws its form, review on file or not", async () => {
    stubFetch(() =>
      seedBody({ status: "pending_approval", reviewGate: { ref: "lcr-earlier", awaiting: false } }),
    );
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          initialStatus: "pending_approval",
          initialHitlContext: {
            xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
            childRunId: null,
            reviewTaskId: `setup-${RUN_ID}`,
            inputSchema: {
              type: "object",
              title: "idea",
              properties: { title: { type: "string" } },
              required: ["title"],
              "x-object-text-property": "title",
            },
            currentValues: {},
            fieldName: "idea",
          },
          initialReviewGate: { ref: "lcr-earlier", awaiting: false },
        })}
      />,
    );

    await waitFor(() => expect(document.querySelector("#field-idea")).not.toBeNull());
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  });
});
