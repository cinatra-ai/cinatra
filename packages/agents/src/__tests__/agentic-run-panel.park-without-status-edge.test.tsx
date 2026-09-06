// @vitest-environment jsdom
/**
 * THE PARK THAT TAKES NO STATUS EDGE (cinatra#3007).
 *
 * `agentic-run-panel.live-park-swap.test.tsx` pins the swap for a run that parks
 * while it is WORKING: the status moves from `running` to the parked status, and
 * that edge is what re-keys the shared review-slot reader and starts it looking.
 * Every case in that file, and every case in `agentic-run-panel.review-slot.test.tsx`,
 * is that shape.
 *
 * The blog draft writer is not that shape, and the fourth capture measured it.
 * It ASKS FIRST — a setup question, which parks the run in `pending_approval`
 * while it waits — and the person answers minutes later. The run then does its
 * work and its produced output opens a review, and the park is written onto a row
 * that is ALREADY in that status: `parkRun`'s `fromStatus === PARKED_STATUS`
 * branch records the withheld terminal write and takes no status edge at all.
 *
 * So the one signal the slot reader keys on never moves again. It answered once,
 * during the QUESTION, with "not parked, no gate", and stopped. From there the
 * park was invisible to both surfaces for the whole 966 s the capture recorded:
 * the conversation drew the panel's own progress badge reading "pending approval"
 * with "No messages yet." under it and no spinner at all; the answered setup ask
 * kept a live Continue because the panel never stopped publishing it; the run
 * page drew no lifecycle card for the pending review; and the review card
 * appeared only after a page reload, which re-seeds the reader from the row.
 *
 * These cases run that sequence on both surfaces, on the transport a conversation
 * really dispatches through (a task-backed tick, whose snapshot carries no gate
 * reading of its own), with the stream mute at `running` throughout — and require
 * the four readings the drawing at the contract's pin gives that window.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.park-without-status-edge.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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

/** The A2A task snapshot — the branch a conversation-dispatched run really takes,
 *  and the one that carries NO gate reading, so the row's park can reach the
 *  surface through the shared slot reader and through nothing else. */
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
    runId: "run-3007",
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

/** The stream, mute at `running` — a parked run announces nothing on the wire. */
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

const RUN_ID = "run-3007";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The setup question the run really asks before it does any work. */
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
const PARK_WITHOUT_GATE = { ref: null, awaiting: true, producedReviewPark: true };
const PARK_WITH_GATE = {
  ref: "lcr-no-edge-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/**
 * The run's seed route. Its `/api/agents/runs/` answers are the SLOT READER'S
 * looks and nothing else on these cases: the tick is task-backed, so it reads
 * the A2A snapshot instead of this route.
 */
function stubFetch(run: () => Record<string, unknown>) {
  const slotLooks: number[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      slotLooks.push(1);
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
  return { fetchMock, slotLooks };
}

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "pending_approval",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: SETUP_ASK,
    reviewGate: NOT_PARKED,
    ...over,
  };
}

function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: true as boolean | null,
    templateId: "tmpl-3007",
    // EVERY real run of this shape has one: the chat card seeds it off the row
    // and the run page reads it from the same row. It selects the task-snapshot
    // branch of the tick — the branch that carries no gate reading.
    taskId: "task-3007",
    surface: "chat" as "agent-detail" | "chat",
    initialReviewGate: NOT_PARKED,
    ...over,
  };
}

const SURFACES = [
  [
    "conversation",
    "chat" as const,
    (node: React.ReactNode) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>
    ),
    "chat_thread",
  ],
  ["run page", "agent-detail" as const, (node: React.ReactNode) => node, "run_card"],
] as const;

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
  a2aSnapshot.value = {
    taskId: "task-3007",
    state: "input-required",
    cinatraStatus: "pending_approval",
    runId: RUN_ID,
    messages: [],
    hitlContext: SETUP_ASK,
    error: null,
  };
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

/** Wait until the reader has answered at least `n` looks — the question phase
 *  spends exactly one, and it is the one that ended the looking. */
async function afterSlotLooks(slotLooks: number[], n: number): Promise<void> {
  await waitFor(
    () => {
      if (slotLooks.length < n) throw new Error("the slot has not been looked at yet");
    },
    { timeout: 20_000 },
  );
}

describe("a park written onto a row that is already parked on a question", () => {
  it.each(SURFACES)(
    "%s — the review card arrives in the slot on its own, with no status edge to trigger it",
    async (_name, surface, wrap, expectedHost) => {
      let body: Record<string, unknown> = seedBody();
      const { slotLooks } = stubFetch(() => body);
      const published: Array<unknown> = [];
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              onActiveGateChange: (_runId: string, gate: unknown) => {
                published.push(gate);
              },
            })}
          />,
        ),
      );

      // THE QUESTION IS LIVE, and the surface says so: the panel publishes the
      // gate descriptor, which is what draws the ask in the conversation.
      await waitFor(
        () => {
          if (!published.some((g) => g !== null)) throw new Error("no gate published");
        },
        { timeout: 20_000 },
      );
      // …and the reader has spent its one look on the question.
      await afterSlotLooks(slotLooks, 1);

      // THE PERSON ANSWERS AND THE RUN PARKS ON WHAT IT PRODUCED. The row's
      // status does NOT move — it was already parked on the question — and the
      // stream stays mute. The only thing that changes is the row.
      body = seedBody({ reviewGate: PARK_WITH_GATE });

      const card = await waitFor(
        () => {
          const el = document.querySelector(REVIEW_CARD);
          if (!el) throw new Error("the review screen did not arrive on its own");
          return el;
        },
        { timeout: 30_000 },
      );
      expect(streamState.status).toBe("running");
      expect(document.querySelectorAll(SLOT).length).toBe(1);
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "review",
      );
      expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
      expect(card.getAttribute("data-lifecycle-card-host")).toBe(expectedHost);

      // AND THE ANSWERED ASK SETTLES. The conversation's own HITL screen card
      // re-reads on the panel's published signal alone, so a park that never
      // clears the descriptor leaves the answered question drawn as `asking`
      // with a live Continue on it for as long as the park lasts.
      expect(
        published[published.length - 1],
        "the answered setup ask is still published as a live gate",
      ).toBeNull();
      expect(document.querySelector("#field-idea")).toBeNull();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    },
    60_000,
  );

  it.each(SURFACES)(
    "%s — the park with no gate row yet replaces the question with the QUIET placeholder",
    async (_name, surface, wrap) => {
      let body: Record<string, unknown> = seedBody();
      const { slotLooks } = stubFetch(() => body);
      const published: Array<unknown> = [];
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              onActiveGateChange: (_runId: string, gate: unknown) => {
                published.push(gate);
              },
            })}
          />,
        ),
      );
      await waitFor(
        () => {
          if (!published.some((g) => g !== null)) throw new Error("no gate published");
        },
        { timeout: 20_000 },
      );
      await afterSlotLooks(slotLooks, 1);

      // The run parks; its review gate has not been minted yet. Same status.
      body = seedBody({ reviewGate: PARK_WITHOUT_GATE });

      const placeholder = await waitFor(
        () => {
          const slot = document.querySelector(SLOT);
          if (slot?.getAttribute("data-run-review-slot") !== "working") {
            throw new Error("the slot is not holding the placeholder");
          }
          const el = document.querySelector(PLACEHOLDER);
          if (!el) throw new Error("no placeholder");
          return el as HTMLElement;
        },
        { timeout: 30_000 },
      );

      // THE DRAWING AT THE CONTRACT'S PIN, cards §II: "the card frame, and a
      // spinning icon … It names no status, reports no result and draws nothing
      // to press."
      expect(placeholder.querySelectorAll("svg.animate-spin").length).toBe(1);
      expect(screen.queryByRole("heading", { name: /Agentic Run Progress/i })).toBeNull();
      expect(screen.queryByText(/No messages yet/i)).toBeNull();
      expect(screen.queryByText(/pending approval/i)).toBeNull();
      expect(screen.queryByText(/could not be loaded/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /Re-check/i })).toBeNull();
      expect(document.querySelector("#field-idea")).toBeNull();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
      // AWAITED RATHER THAN READ ONCE (cinatra#3046, fix leg 17). The placeholder
      // above stopped being this assertion's synchronisation point on the
      // conversation host: that host now draws the quiet box for the WHOLE
      // working window, so the box is already standing while the park is still
      // one look away. The property is unchanged and is still this run's own —
      // the answered setup ask must not stay published as a live gate once the
      // park is read — it is waited for instead of sampled at the instant an
      // earlier paint happened to make true.
      await waitFor(
        () => {
          if (published[published.length - 1] !== null) {
            throw new Error("the answered setup ask is still published as a live gate");
          }
        },
        { timeout: 30_000 },
      );
    },
    60_000,
  );
});
