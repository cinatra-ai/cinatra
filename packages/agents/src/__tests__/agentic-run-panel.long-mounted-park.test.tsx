// @vitest-environment jsdom
/**
 * THE PAGE THAT WAS ALREADY OPEN (cinatra#3007, fix leg 8).
 *
 * Every earlier leg was proved on a mount that arrived AFTER the park, and every
 * graded reading since has failed on the other one. The seventh reading watched four
 * untouched surfaces for 900 s each with one-second polls and zero navigations:
 * one of the four swapped, at 467 s; the other three never did; and a page
 * opened fresh at that same instant drew the card at once on both palettes. On
 * the untouched run page six of the seven noisy elements were still drawn while
 * the run was parked.
 *
 * So the case these cases pin is the standing page, and nothing else:
 *
 *   · the panel mounts while the run is `pending_approval` ASKING ITS SETUP
 *     QUESTION — the shape that takes no status edge anywhere, because the park
 *     is later written onto that same already-parked row;
 *   · the tick runs for ten minutes, exactly as it does on a real open page,
 *     with the stream mute at `running`;
 *   · THEN the person answers, the run produces its output and the park is
 *     written; then the gate row is minted.
 *
 * The page is never remounted and nothing is pressed. What it must do is what a
 * freshly opened page does: draw the quiet reading while the gate is minting,
 * and swap the review into the same slot when the gate exists — on BOTH hosts,
 * inside the reader's own stated cadence.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.long-mounted-park.test.tsx
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
    runId: "run-3007-leg8",
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

/** The stream, mute at `running` for the life of the park — a parked run
 *  announces nothing on the wire, which is why the row has to be read. */
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

const RUN_ID = "run-3007-leg8";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const SLOT = "[data-run-review-slot]";

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

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
  ref: "lcr-leg8-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** How long a real page had been open before its run parked, on the seventh
 *  reading: about eight minutes on one watch and about thirty on the other. Ten
 *  minutes of ticking is inside both. */
const THE_QUESTION_WINDOW_MS = 600_000;
/** THE READER'S STATED INTERVAL, on a surface whose own tick is answering: the
 *  caller bumps its liveness every five seconds while a run is parked and the
 *  reader takes its look on that evidence, so a standing page is never more than
 *  one tick plus one look behind the row. Twelve seconds is that with margin,
 *  and it is far inside the thirty the acceptance asks for. */
const THE_STATED_INTERVAL_MS = 12_000;

/** Walk the clock in slices small enough that every newly scheduled timer is
 *  seen — the panel ticks at five seconds while a run is parked and the reader
 *  at up to ten — and READ THE DOM at every second, which is the cadence the
 *  graded readings watch their untouched pages at. */
async function letTheOpenPageRun(
  ms: number,
  watch?: (secondsElapsed: number) => void,
): Promise<void> {
  const SLICE_MS = 1000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  watch?.(0);
  for (let elapsed = 0; elapsed < ms; elapsed += SLICE_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLICE_MS);
    });
    watch?.((elapsed + SLICE_MS) / 1000);
  }
}

/** The seven elements the graded readings counted on the untouched run page. */
function theSevenNoisyElements(): Record<string, boolean> {
  const body = document.body.textContent ?? "";
  const pressable = (re: RegExp) =>
    [...document.querySelectorAll("button, a")].some((e) =>
      re.test((e.textContent ?? "").trim()),
    );
  return {
    progressHeading: /Agentic Run Progress/i.test(body),
    pendingApprovalPill: /pending approval/i.test(body),
    pausedBanner: /Run paused/i.test(body),
    reviewApprovalControl: pressable(/Review approval/i),
    loadingApprovalStep: /Loading the approval step/i.test(body),
    recheckControl: pressable(/Re-?check/i),
    noMessagesYet: /No messages yet/i.test(body),
  };
}

const ALL_QUIET = {
  progressHeading: false,
  pendingApprovalPill: false,
  pausedBanner: false,
  reviewApprovalControl: false,
  loadingApprovalStep: false,
  recheckControl: false,
  noMessagesYet: false,
};

/** The row, as the two transports report it. `hitl` is the interrupt on file;
 *  `gate` is the slot the seed route answers with. */
const row = {
  hitl: null as Record<string, unknown> | null,
  gate: NOT_PARKED as Record<string, unknown>,
};

function askingItsSetupQuestion(): void {
  row.hitl = SETUP_ASK;
  row.gate = NOT_PARKED;
}
function parkedWithNoGateYet(): void {
  row.hitl = null;
  row.gate = PARK_WITHOUT_GATE;
}
function parkedWithItsGate(): void {
  row.hitl = null;
  row.gate = PARK_WITH_GATE;
}

function stubTheTransports(): { slotLooks: number[] } {
  const slotLooks: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        slotLooks.push(Date.now());
        return new Response(
          JSON.stringify({
            status: "pending_approval",
            error: null,
            startedAt: null,
            completedAt: null,
            messages: [],
            hitlContext: row.hitl,
            reviewGate: row.gate,
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
  return { slotLooks };
}

const SURFACES = [
  [
    "conversation",
    "chat" as const,
    (node: React.ReactNode) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>
    ),
  ],
  ["run page", "agent-detail" as const, (node: React.ReactNode) => node],
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
  askingItsSetupQuestion();
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

describe("the page that was already open when the run parked", () => {
  it.each(SURFACES)(
    "%s — draws the quiet reading and swaps the review in, with no remount",
    async (_name, surface, wrap) => {
      const { slotLooks } = stubTheTransports();
      // The tick's own transport. Task-backed, exactly as a conversation-
      // dispatched run is, so the park can reach the surface only through the
      // shared slot reader.
      a2aSnapshot.value = {
        taskId: "task-3007",
        state: "input-required",
        cinatraStatus: "pending_approval",
        runId: RUN_ID,
        messages: [],
        get hitlContext() {
          return row.hitl;
        },
        error: null,
      };
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            runId={RUN_ID}
            taskId="task-3007"
            initialStatus="pending_approval"
            initialError={null}
            initialMessages={[]}
            agUiEnabled
            templateId="tmpl-3007"
            surface={surface}
            initialHitlContext={SETUP_ASK}
            initialReviewGate={NOT_PARKED}
          />,
        ),
      );

      // TEN MINUTES OF BEING OPEN, with the question on the screen and the tick
      // running — the ordinary life of a page somebody left open. The run is
      // `pending_approval` for every second of it, which is the whole shape of
      // the defect: the park is written onto this same already-parked row, so
      // the status column never once moves.
      await letTheOpenPageRun(THE_QUESTION_WINDOW_MS);
      const looksSpentOnTheQuestion = slotLooks.length;

      // THE PERSON ANSWERS AND THE RUN PRODUCES ITS OUTPUT. The step goes away,
      // the run parks on the review of what it produced, and the stream — which
      // has resumed and gone quiet again — keeps saying `running` for ever.
      // Nothing is pressed here and nothing is remounted.
      streamState.status = "running";
      parkedWithNoGateYet();
      const noisyFramesWhileParked: Array<{ at: number; drawn: string[] }> = [];
      let quietAt: number | null = null;
      await letTheOpenPageRun(THE_STATED_INTERVAL_MS, (at) => {
        const drawn = Object.entries(theSevenNoisyElements())
          .filter(([, on]) => on)
          .map(([name]) => name);
        if (drawn.length > 0) noisyFramesWhileParked.push({ at, drawn });
        if (quietAt === null && document.querySelector(PLACEHOLDER) !== null) quietAt = at;
      });

      expect(
        slotLooks.length,
        "the standing page stopped reading its own run, so no park can ever reach it",
      ).toBeGreaterThan(looksSpentOnTheQuestion);
      expect(
        noisyFramesWhileParked,
        "a one-second watch of the standing parked page caught the noisy arm",
      ).toEqual([]);
      expect(
        quietAt,
        "the standing parked page never drew the quiet placeholder",
      ).not.toBeNull();
      const quietBox = document.querySelector(PLACEHOLDER);
      expect(quietBox).not.toBeNull();
      // The identity a graded reading has to be able to read BEFORE the swap.
      const named = quietBox?.querySelector(
        '[data-conformance-id="review-gate-placeholder-run-ref"]',
      );
      expect(named, "the quiet box names no run").not.toBeNull();
      expect(RUN_ID.startsWith((named?.textContent ?? "").trim())).toBe(true);
      expect(quietBox?.getAttribute("aria-label") ?? "").toContain(
        (named?.textContent ?? "").trim(),
      );

      // THE GATE ROW IS MINTED. The swap must arrive in the same slot, in the
      // same mount, inside the reader's stated interval — and no frame of the
      // watch may carry the arm on the way there.
      parkedWithItsGate();
      let swappedAt: number | null = null;
      await letTheOpenPageRun(THE_STATED_INTERVAL_MS, (at) => {
        const drawn = Object.entries(theSevenNoisyElements())
          .filter(([, on]) => on)
          .map(([name]) => name);
        if (drawn.length > 0) noisyFramesWhileParked.push({ at, drawn });
        if (
          swappedAt === null &&
          document.querySelector(SLOT)?.getAttribute("data-run-review-slot") === "review"
        ) {
          swappedAt = at;
        }
      });

      expect(
        swappedAt,
        "the review never replaced the placeholder on the page that was already open",
      ).not.toBeNull();
      expect(noisyFramesWhileParked).toEqual([]);
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "review",
      );
    },
    180_000,
  );
});
