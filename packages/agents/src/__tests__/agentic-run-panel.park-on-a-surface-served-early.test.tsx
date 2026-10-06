// @vitest-environment jsdom
/**
 * THE SURFACE THAT WAS SERVED BEFORE THE RUN STARTED WORKING (cinatra#3007,
 * fix leg 9).
 *
 * The eighth graded reading measured the swap on FOUR untouched surfaces per run,
 * twice, and the failure it recorded is per RUN rather than per surface: one
 * run's four surfaces drew the noisy arm for 315 s and never swapped, while the
 * other run's two conversations swapped at 14 s. A bound that is spent by
 * something the SURFACE did cannot produce that shape; a bound decided by
 * something about the RUN can.
 *
 * THE MECHANISM. This panel's tick is the only carrier of the run ROW on a
 * first-party surface: `resolveRunSurfaceStatus` needs it to overrule a stream
 * that is mute for the whole of a park, the park's own third fact rides beside
 * it, and the shared review-slot reader takes its answers as the evidence that
 * this surface's transport works at all. Whether that tick runs was decided by
 * `pollStatus`, which is deliberately never written while the stream is enabled
 * — so the answer was fixed once, by the status the run happened to be in when
 * this surface was SERVED, and no later reading could revisit it. A conversation
 * card served while its run is `pending_input` — the status the chat's own
 * insert creates a run in — therefore never read the row again for the life of
 * the tab: the row could never overrule the mute stream, the reader never looked
 * under the parked status, and the park the run reached minutes later was
 * invisible on every surface served in that window.
 *
 * These cases mount the panel exactly as a conversation mounts it, with the seed
 * a card served in that window really carries, and require both halves of the
 * park to arrive with nothing pressed.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.park-on-a-surface-served-early.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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
    runId: "run-3007-early",
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

/** The stream, replaying the run's log and then silent — which is what a parked
 *  run's stream really is: it announces terminal states and a park is not one. */
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

const RUN_ID = "run-3007-early";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

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

/** The answered setup question the run's row still carries while it is parked. */
const ANSWERED_INPUT_GATE = {
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

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "pending_input",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    ...over,
  };
}

/** The panel as the conversation mounts it, with the seed a card SERVED BEFORE
 *  the run started working really carries: the run's own insert status. */
function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    // The chat's own insert status, and the whole point of these cases: it is
    // not one of the three the tick's firing guard was written for.
    initialStatus: "pending_input",
    initialError: null,
    initialMessages: [],
    agUiEnabled: true as boolean | null,
    templateId: "tmpl-3007",
    surface: "chat" as "agent-detail" | "chat",
    initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    ...over,
  };
}

function mount(node: React.ReactNode) {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>,
  );
}

beforeEach(() => {
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
});

describe("a conversation card served before its run started working", () => {
  it("still learns the park and swaps the review card in, with nothing pressed", async () => {
    let body = seedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = mount(<AgenticRunPanel {...panelProps()} />);

    // The run works, and then parks with its gate already on file. The stream
    // says nothing about either — it announces terminal states, and a park is
    // not one — so the ROW is the only thing that can tell this surface.
    body = seedBody({
      status: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
      reviewGate: {
        ref: "lcr-early-served-gate",
        awaiting: false,
        producedReviewPark: true,
      },
    });

    await waitFor(
      () => {
        if (!container.querySelector(REVIEW_CARD)) {
          throw new Error("the review card never arrived on the untouched surface");
        }
      },
      { timeout: 25_000 },
    );
  }, 45_000);

  it("draws the quiet placeholder while the park's gate is still being minted, and none of the run's own arm", async () => {
    let body = seedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = mount(<AgenticRunPanel {...panelProps()} />);

    body = seedBody({
      status: "pending_approval",
      hitlContext: null,
      reviewGate: { ref: null, awaiting: true, producedReviewPark: true },
    });

    const placeholder = await waitFor(
      () => {
        const el = container.querySelector(PLACEHOLDER);
        if (!el) throw new Error("the quiet placeholder was never drawn while parked");
        return el as HTMLElement;
      },
      { timeout: 25_000 },
    );
    expect(placeholder.querySelectorAll("svg.animate-spin").length).toBe(1);

    // AND NOT THE RUN'S OWN ARM. These are the five the eighth graded reading
    // counted on every untouched surface of the run that never swapped.
    const text = container.textContent ?? "";
    expect(text).not.toContain("awaiting human approval before continuing");
    expect(text).not.toContain("Review approval");
    expect(text).not.toContain("Loading the approval step for this run");
    expect(text).not.toContain("Re-check");
    expect(text).not.toContain("No messages yet.");
  }, 45_000);
});
