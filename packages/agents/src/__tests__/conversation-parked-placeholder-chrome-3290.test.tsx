// @vitest-environment jsdom
/**
 * THE CONVERSATION'S RUN CARD, WHILE THE RUN IS WORKING (cinatra#3007, fix
 * leg 17; cinatra#3290, #3291, #3292).
 *
 * The thirteenth graded reading measured the box the review lands in, on a
 * conversation surface held open before the gate existed, in both palettes, and
 * found three departures inside one drawing paragraph:
 *
 *   1. no spinning arc in the slot;
 *   2. an "Awaiting input" status pill at the right of the box's header;
 *   3. a "No messages yet." result line in its body.
 *
 * The drawing gives that box one reading: "while the run is working that card is
 * a placeholder for the review screen: the card frame, and a spinning icon, the
 * indigo arc of Components section Skeleton / Spinner. It names no status,
 * reports no result and draws nothing to press."
 *
 * THE STATE THE READING WAS TAKEN IN. The run was `pending_approval` with a
 * setup question still on its row — a question this host draws no screen for
 * (`runCardOwnsLifecycleCopy` is false for `chat_thread`, so the panel's own
 * HITL screen card is not mounted in a transcript). The panel therefore had
 * nothing pressable for the box and fell through to the run-progress reading at
 * the foot of the file: the heading, the status badge, and the empty-transcript
 * line. Every one of those three is a thing the drawing's sentence forbids, and
 * the arc it does give was drawn nowhere.
 *
 * So this pins the box for that state, per palette-independent DOM: the
 * placeholder is the box, the arc spins in it, and neither a status word nor a
 * result line is anywhere in the panel's own subtree.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/conversation-parked-placeholder-chrome-3290.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// NOT stubbed to null: the arc is an inline `svg` in the placeholder itself, and
// a stubbed icon module would make the "no icon" reading unmeasurable here.
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

const a2aSnapshot = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => a2aSnapshot.value),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3290",
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

const streamState = vi.hoisted(() => ({ status: "running" as string | null }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3290-working";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';

/** The question the run recorded — and the one a transcript draws no screen
 *  for, which is the whole shape of the measured reading. */
const SETUP_ASK = {
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
};

const NOT_PARKED = { ref: null, awaiting: false, producedReviewPark: false };

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

function stubTheTransports(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        return new Response(
          JSON.stringify({
            status: "pending_approval",
            error: null,
            startedAt: null,
            completedAt: null,
            messages: [],
            hitlContext: SETUP_ASK,
            reviewGate: NOT_PARKED,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(RESOLVE_PENDING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** The reading the graded round took: what the box says about status, and what
 *  it reports as a result. Read off the whole panel, because the departures were
 *  measured on the panel's chrome and not inside the placeholder component. */
function whatTheBoxSays(): {
  placeholder: boolean;
  spinningArc: number;
  statusPill: boolean;
  resultLine: boolean;
} {
  const body = document.body.textContent ?? "";
  const box = document.querySelector(PLACEHOLDER);
  return {
    placeholder: box !== null,
    spinningArc: document.querySelectorAll("svg.animate-spin").length,
    statusPill: /Awaiting input|pending approval|Pending approval/i.test(body),
    resultLine: /No messages yet|Waiting to start/i.test(body),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
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
});

describe("the conversation's run card while the run is working", () => {
  it("draws the placeholder with its spinning arc, and names no status and no result", async () => {
    stubTheTransports();
    a2aSnapshot.value = {
      taskId: "task-3290",
      state: "input-required",
      cinatraStatus: "pending_approval",
      runId: RUN_ID,
      messages: [],
      hitlContext: SETUP_ASK,
      error: null,
    };
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel
          runId={RUN_ID}
          taskId="task-3290"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled
          templateId="tmpl-3290"
          surface="chat"
          initialHitlContext={SETUP_ASK}
          initialReviewGate={NOT_PARKED}
        />
      </LifecycleCardSurfaceProvider>,
    );

    // Let the surface settle exactly as an open transcript does.
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    const reading = whatTheBoxSays();
    // cinatra#3290 — the drawing's own icon, in the slot.
    expect(reading.placeholder, "the conversation drew no placeholder box").toBe(true);
    expect(reading.spinningArc, "the placeholder drew no spinning arc").toBeGreaterThan(0);
    // cinatra#3291 — "It names no status".
    expect(reading.statusPill, "the box named a status").toBe(false);
    // cinatra#3292 — "reports no result".
    expect(reading.resultLine, "the box reported a result").toBe(false);
  }, 60_000);
});
