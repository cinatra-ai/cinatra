// @vitest-environment jsdom
/**
 * THE ARRIVAL STAYS ON AN UNTOUCHED PAGE (cinatra#3007, fix leg 11).
 *
 * WHAT WAS MEASURED, and it is the reason this file exists. The ninth graded
 * reading opened the conversation in both palettes BEFORE the gate was minted
 * and then never touched either page — nothing pressed, nothing scrolled, no
 * reload, 0 navigations — and read each one once a second for 539 polls. Both
 * landed the review card, at 3.083 s and 8.331 s after the gate row. Then,
 * counting only the polls AFTER the card had landed:
 *
 *   · light  — 509 polls, 256 with NO card, 80 separate absences, longest 43.670 s
 *   · dark   — 513 polls, 237 with NO card, 83 separate absences, longest 18.811 s
 *
 * Worse than the eighth reading on every count. One frame carries it: a page
 * with 0 navigations whose reading holds NO lifecycle card of any kind — not a
 * placeholder, not a skeleton — while its twin at the SAME second still holds
 * the card. Two palettes of one run disagreeing at one instant is per-page
 * state, and a page-wide reading each of them takes on its own schedule.
 *
 * THE CAUSE, reproduced below rather than reasoned about. The one page-wide
 * reading each surface takes on its own schedule is the review slot's, and the
 * whole of the conversation's card rests on ONE field of it: the panel draws the
 * review at `parkedOnProducedReview`, and on the A2A transport a conversation
 * really runs on, the row's park never rides the tick — so that reading IS
 * `slot.producedReviewPark` and nothing else.
 *
 * The shared reader believed a single look that answered `false` there. Its own
 * rule for a stumbled look protects the two GATE fields and says why ("never
 * take a review off a screen somebody is reading"), and then hands the park flag
 * the opposite treatment: `rowSaysTheParkIsOver` takes one look's `false` as the
 * row's own word, skips that protection entirely, and files the whole answer. The
 * card leaves, the panel falls to its own progress arm — which draws neither a
 * card nor a placeholder, and redraws the question the run already answered — and
 * it stays that way until the next look lands, which at the widened cadence is
 * ten seconds and past the belt thirty.
 *
 * The flag is no more authoritative than the fields it is read beside: the route
 * computes it from the run row it happened to read (a run whose row read answers
 * the park predicate `false` for one look serves `false`, whatever the gate row
 * says), and a park that has really ended is followed by the run LEAVING the
 * status, which re-keys this reader in render and empties the slot there. What
 * produces such a look UPSTREAM is not settled here; what is settled here is that
 * one of them may not take a review off a screen somebody is reading. So inside one status, beside a gate this
 * surface is already drawing, a lone `false` is a look that did not land on that
 * fact — and it is withheld while consecutive drops stay inside a small budget,
 * then believed, so a genuine release still lands and the withholding can never
 * become permanent.
 *
 * These cases SAMPLE the rendered thread across successive look cycles, the way
 * the reading polled it, rather than asserting one frame.
 *
 * Run:
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.park-flag-flap.test.tsx
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

/**
 * THE A2A TRANSPORT'S OWN SNAPSHOT, live rather than frozen.
 *
 * The panel's tick has TWO branches, and which one it takes is decided by the
 * `taskId` prop alone. `InlineAgentRunCard` passes `seed.taskId` for every run
 * dispatched through A2A - which is every run a conversation dispatches - so
 * the task-snapshot branch, not the seed-route fallback, is the one the
 * measured surface really runs. A case that wants that branch sets this.
 */
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
    runId: "run-3046",
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

/**
 * THE STREAM, MUTE AT `running` — which is what a parked run's stream really is.
 * It is the whole point of this file, so it is a live value the cases read rather
 * than a frozen literal: a case that wants the stream to speak sets it.
 */
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

const RUN_ID = "run-3046";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

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

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    ...over,
  };
}

/** The panel as a CONVERSATION really mounts it: the stream on, because the run
 *  was dispatched from a chat and the chat card seeds `agUiEnabled` off the row. */
function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: true as boolean | null,
    templateId: "tmpl-3046",
    surface: "chat" as "agent-detail" | "chat",
    ...over,
  };
}

/** The interrupt a parked run really carries: the LAST question it was asked,
 *  answered minutes ago, which the run has moved past. */
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

const PARK_WITHOUT_GATE = { ref: null, awaiting: true, producedReviewPark: true };
const PARK_WITH_GATE = {
  ref: "lcr-live-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** The two surfaces, mounted the way each really mounts this panel. */
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
  a2aSnapshot.value = null;
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


/**
 * ONE READING PER SAMPLE, taken the way the graded reading took it: is a review
 * card in the document, is a placeholder, and is the panel drawing its own
 * progress arm instead of either.
 */
async function sampleTheThread(
  samples: number,
  everyMs: number,
): Promise<Array<{ card: boolean; placeholder: boolean; progressArm: boolean }>> {
  const out: Array<{ card: boolean; placeholder: boolean; progressArm: boolean }> = [];
  for (let i = 0; i < samples; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    out.push({
      card: document.querySelector(REVIEW_CARD) !== null,
      placeholder: document.querySelector(PLACEHOLDER) !== null,
      progressArm: [...document.querySelectorAll("h2")].some((h) => /Agentic Run Progress/i.test(h.textContent ?? "")),
    });
  }
  return out;
}

/** How many separate times the card left, and the longest run of samples it was
 *  gone for — the two numbers the graded reading reports. */
function absences(samples: Array<{ card: boolean }>): {
  cardless: number;
  separate: number;
  longest: number;
} {
  let cardless = 0;
  let separate = 0;
  let longest = 0;
  let run = 0;
  for (const s of samples) {
    if (s.card) {
      run = 0;
      continue;
    }
    cardless += 1;
    if (run === 0) separate += 1;
    run += 1;
    if (run > longest) longest = run;
  }
  return { cardless, separate, longest };
}

/**
 * Mount the conversation the way it really mounts — the A2A transport, the
 * stream mute at `running`, the row parked with its answered question still on
 * it — and hand the seed route a slot answer decided per look.
 */
async function mountParkedConversation(
  gateForLook: (look: number) => Record<string, unknown>,
): Promise<void> {
  let parked = false;
  let looks = 0;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      looks += 1;
      const body = parked
        ? seedBody({
            status: "pending_approval",
            hitlContext: ANSWERED_INPUT_GATE,
            reviewGate: gateForLook(looks),
          })
        : seedBody();
      return new Response(JSON.stringify(body), {
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
  a2aSnapshot.value = {
    taskId: "task-3046",
    state: "working",
    cinatraStatus: "running",
    runId: RUN_ID,
    messages: [],
    hitlContext: null,
    error: null,
  };
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <AgenticRunPanel
        {...panelProps({
          surface: "chat",
          taskId: "task-3046",
          initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
        })}
      />
    </LifecycleCardSurfaceProvider>,
  );
  // THE RUN PARKS ON WHAT IT PRODUCED. The stream never speaks again.
  a2aSnapshot.value = {
    ...a2aSnapshot.value,
    cinatraStatus: "pending_approval",
    hitlContext: ANSWERED_INPUT_GATE,
  };
  parked = true;
  await waitFor(
    () => {
      if (!document.querySelector(REVIEW_CARD)) {
        throw new Error("the review screen never arrived");
      }
    },
    { timeout: 25_000 },
  );
}

describe("the arrival stays on an untouched page (cinatra#3007, fix leg 11)", () => {
  it("a lone look whose park flag reads false does not take the card off the thread", async () => {
    // The answer keeps the gate the surface is drawing and moves ONLY the park
    // flag — which is all it takes, because that flag is the whole of the
    // conversation's reading of the park.
    await mountParkedConversation((look) =>
      look % 3 === 0 ? { ...PARK_WITH_GATE, producedReviewPark: false } : PARK_WITH_GATE,
    );
    const samples = await sampleTheThread(80, 250);
    const gone = absences(samples);
    expect(
      gone,
      "the card left the thread on a page nobody touched",
    ).toEqual({ cardless: 0, separate: 0, longest: 0 });
    // And the arm the panel falls to when the park is withdrawn — the one the
    // graded reading photographed, with the already-answered question on it — is
    // never drawn either.
    expect(samples.filter((s) => s.progressArm)).toHaveLength(0);
  }, 120_000);

  it("an answer that empties the gate AND the park at once does not take it either", async () => {
    // THE TOTAL WITHDRAWAL, and it is a different answer from the route's own
    // fail-soft one (convergence). A slot read that throws costs the answer only
    // the two GATE fields — the route computes the park separately, off the run
    // row it already read — so the fail-soft shape keeps the park true and is the
    // one fix leg 9 closed. This is the other shape: the ROW's own park
    // predicate answered false, and the gate came back empty in the same answer.
    // The gate half was already protected; the park half walked straight past
    // that protection, and the card left all the same.
    await mountParkedConversation((look) =>
      look % 3 === 0
        ? { ref: null, awaiting: false, producedReviewPark: false }
        : PARK_WITH_GATE,
    );
    const samples = await sampleTheThread(80, 250);
    expect(absences(samples)).toEqual({ cardless: 0, separate: 0, longest: 0 });
    expect(samples.filter((s) => s.progressArm)).toHaveLength(0);
  }, 120_000);

  it("and a park that really ends is still believed — the withholding is bounded", async () => {
    // The other half of the rule, and the reason it is a budget rather than a
    // veto: a park the row has genuinely left must still clear, or a decided
    // review's card would be wedged over the run for the life of the mount.
    let ended = false;
    await mountParkedConversation(() =>
      ended ? { ref: null, awaiting: false, producedReviewPark: false } : PARK_WITH_GATE,
    );
    ended = true;
    await waitFor(
      () => {
        if (document.querySelector(REVIEW_CARD)) {
          throw new Error("the ended park never cleared the card");
        }
      },
      { timeout: 60_000 },
    );
  }, 120_000);
});

/**
 * THE SAME MOUNT, PARKED BEFORE ANY GATE EXISTS, on either surface.
 *
 * This is the reading the waiting box rests on and nothing else: `ref` null,
 * `awaiting` false, the park true. The ninth graded reading drew no box on any
 * of the four untouched parked surfaces, and the guard as first written asked
 * for a gate beside the flag before it would protect a drop - so here the box
 * had no protection at all and the first dropped flag took it.
 */
async function mountPreGatePark(
  surfaceIndex: number,
  parkForLook: (look: number) => Record<string, unknown>,
): Promise<void> {
  const [, surface, wrap] = SURFACES[surfaceIndex];
  let parked = false;
  let looks = 0;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      looks += 1;
      const body = parked
        ? seedBody({
            status: "pending_approval",
            hitlContext: ANSWERED_INPUT_GATE,
            reviewGate: parkForLook(looks),
          })
        : seedBody();
      return new Response(JSON.stringify(body), {
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
  a2aSnapshot.value = {
    taskId: "task-3046",
    state: "working",
    cinatraStatus: "running",
    runId: RUN_ID,
    messages: [],
    hitlContext: null,
    error: null,
  };
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(
    wrap(
      <AgenticRunPanel
        {...panelProps({
          surface,
          taskId: "task-3046",
          initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
        })}
      />,
    ) as React.ReactElement,
  );
  a2aSnapshot.value = {
    ...a2aSnapshot.value,
    cinatraStatus: "pending_approval",
    hitlContext: ANSWERED_INPUT_GATE,
  };
  parked = true;
  await waitFor(
    () => {
      if (!document.querySelector(PLACEHOLDER)) {
        throw new Error("the waiting box was never drawn on a parked run");
      }
    },
    { timeout: 25_000 },
  );
}

describe("the waiting box stays while the run is parked (cinatra#3007, fix leg 11)", () => {
  it.each([
    ["conversation", 0],
    ["run page", 1],
  ])(
    "%s - a lone look whose park flag reads false does not take the waiting box off a parked run",
    async (_name, index) => {
      await mountPreGatePark(index as number, (look) =>
        look % 3 === 0
          ? { ref: null, awaiting: false, producedReviewPark: false }
          : PARK_WITHOUT_GATE,
      );
      const samples = await sampleTheThread(60, 250);
      const boxless = samples.filter((sample) => !sample.placeholder);
      expect(
        boxless,
        "the waiting box left a parked run nobody touched",
      ).toHaveLength(0);
      // And the box is quiet: the arm that redraws the question the run already
      // answered is never drawn in its place.
      expect(samples.filter((sample) => sample.progressArm)).toHaveLength(0);
    },
    120_000,
  );
});
