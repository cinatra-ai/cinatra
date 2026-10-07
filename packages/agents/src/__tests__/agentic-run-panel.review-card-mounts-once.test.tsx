// @vitest-environment jsdom
/**
 * THE REVIEW GATE CARD IS MOUNTED ONCE, AND IT STAYS (cinatra#3007, F2).
 *
 * The checklist sentence this file pins: "the review gate card mounted over a
 * pending gate is mounted exactly ONCE" across at least six simulated poll
 * ticks and stream updates that repeat the boot's answers, and no tick draws
 * the empty plate while the gate is pending. The drawing's own sentence: "It is
 * replaced, in place, when the output is generated. The placeholder becomes the
 * Review requested gate above".
 *
 * WHAT WAS MEASURED. Once the gate row stood pending, the review gate card in
 * the run detail mounted and unmounted ninety-three times in six minutes, its
 * longest stand under seven seconds, and between the stands the detail was an
 * empty box. The run's seed route answers every read with a FRESH ticket for the
 * same gate — the ticket is sealed with a new random nonce on each read — and a
 * card handed a new ticket draws nothing until its own resolve answers again.
 *
 * The case below mounts the panel the way the run page mounts it and answers
 * every read of the seed route the way the boot did: the run parked on its
 * produced output's review, the same pending gate, a new ticket each time. It
 * counts how many times the card's root enters the document.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/agentic-run-panel.review-card-mounts-once.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
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

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3007-f2",
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

const { readRunOutputEvidence, getRunRecommendationHoldStateAction } = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

/**
 * THE STREAM, as the run page's stream really reads in the measured minute:
 * its last word is the context gate's INTERRUPT, and the RESUME that answered it
 * retired the interrupt without moving the status (`use-ag-ui-run-stream.ts`,
 * the RESUME arm: "the next RUN_STARTED or terminal event drives the status").
 */
const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string | null,
  interruptContext: null as Record<string, unknown> | null,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: streamState.interruptContext,
    lifecycleInterrupt: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));
const RUN_ID = "run-3007-f2";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

/** The resolve route's answer for the one pending gate, whatever ticket names it. */
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The question the run asked before it went to work, answered long ago: the
 *  route keeps deriving it for a parked run. */
const ANSWERED_CONTEXT_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `context-${RUN_ID}`,
  inputSchema: {
    type: "object",
    title: "Draft Context",
    properties: { selectedRefs: { type: "array" } },
  },
  currentValues: {},
};

let ticketSeq = 0;
/** A fresh ticket per read, for the SAME gate, exactly as the route mints them. */
function freshTicket(): string {
  ticketSeq += 1;
  return `lcr-gate-3007-f2-nonce-${ticketSeq}`;
}

function parkedRow() {
  return {
    status: "pending_approval",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: ANSWERED_CONTEXT_GATE,
    lifecycleMoment: "hitl",
    reviewGate: { ref: freshTicket(), awaiting: false, producedReviewPark: true, reviewTaskId: "review-task-3007-f2" },
  };
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  // The stream's last word is the context gate's, spent: its RESUME retired the
  // interrupt and nothing has spoken since — the park announces nothing.
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
  ticketSeq = 0;
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
  vi.useRealTimers();
  vi.resetModules();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("sonner");
  vi.doUnmock("lucide-react");
  vi.doUnmock("../hitl-actions");
  vi.doUnmock("../a2a-actions");
  vi.doUnmock("../server-actions");
  vi.doUnmock("../agent-ui-override-registry");
  vi.doUnmock("../run-recommendation-actions");
  vi.doUnmock("../run-actions");
  vi.doUnmock("../use-ag-ui-run-stream");
  vi.resetModules();
});

/** Count every time a review card root ENTERS the document. */
function countCardMounts(): { mounts: () => number; stop: () => void } {
  let mounts = document.querySelector(REVIEW_CARD) ? 1 : 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(REVIEW_CARD)) mounts += 1;
        mounts += node.querySelectorAll(REVIEW_CARD).length;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { mounts: () => mounts, stop: () => observer.disconnect() };
}

describe("the review gate card over a pending gate is mounted once (cinatra#3007, F2)", () => {
  it("the review gate card mounted over a pending gate is mounted exactly ONCE across the boot's repeated answers", async () => {
    let runReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          runReads += 1;
          return new Response(JSON.stringify(parkedRow()), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // The card's own resolve, a network round trip away.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify(RESOLVE_PENDING), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const counter = countCardMounts();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="running"
        initialError={null}
        initialMessages={[]}
        agUiEnabled
        agentId="cinatra-ai/blog-draft-writer-agent"
        agentPackageName="@cinatra-ai/blog-draft-writer-agent"
        templateId="tmpl-3007-f2"
        initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
        inputStepInRail
        railDrawsTheFrame
      />,
    );

    await waitFor(
      () => {
        if (!document.querySelector(REVIEW_CARD)) throw new Error("the review card never arrived");
      },
      { timeout: 25_000 },
    );
    const readsAtArrival = runReads;

    // SIX POLL TICKS AND MORE, sampled the way the round read the page.
    const samples: Array<{ card: boolean; placeholder: boolean }> = [];
    while (runReads - readsAtArrival < 12) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      samples.push({
        card: document.querySelector(REVIEW_CARD) !== null,
        placeholder: document.querySelector(PLACEHOLDER) !== null,
      });
      if (samples.length > 400) break;
    }
    counter.stop();

    expect(runReads - readsAtArrival, "the seed route was read fewer than twelve times").toBeGreaterThanOrEqual(12);
    expect(
      counter.mounts(),
      `the review gate card was mounted ${counter.mounts()} times over ${runReads - readsAtArrival} reads of the run while its gate stayed pending`,
    ).toBe(1);
    const empty = samples.filter((s) => !s.card && !s.placeholder);
    expect(empty.length, `${empty.length} of ${samples.length} readings drew the empty plate while the gate was pending`).toBe(0);
  }, 120_000);
});
