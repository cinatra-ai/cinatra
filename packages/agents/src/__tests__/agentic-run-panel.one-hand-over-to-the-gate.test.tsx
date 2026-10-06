// @vitest-environment jsdom
/**
 * ONE HAND-OVER FROM THE PLACEHOLDER TO THE GATE (cinatra#3007, fix leg 20).
 *
 * The drawing's sentence this file pins, specs/app-artifact-review.html §I:
 *
 *   "One run detail, twice, in the same column under the same rail: first the
 *    placeholder, then the gate itself."
 *
 * WHAT PICTURE ROUND 2 MEASURED. On one real run, the page never reloaded,
 * the review gate card first stood in the run detail and then the placeholder
 * came back three times before the card held; after the decision the settled
 * card and the placeholder swapped five more times before the settled card
 * held. The card remounts, its box empties, and the box's observer puts the
 * placeholder back.
 *
 * THE MEASURED CAUSE (read at the unchanged head): the run's
 * status and the review slot's reference are read by two readers at two
 * moments. For one reading they disagree - the status leaves the park for a
 * beat, or the run released by the decision reads running before it reads
 * completed - the in-place reference goes null for that reading, the card
 * UNMOUNTS, and on the next reading it is mounted again and draws nothing
 * until its own resolve has answered, while the observer puts the placeholder
 * back in the box.
 *
 * The panel is mounted the way the run page mounts it, and every read of the
 * run's seed route is answered from a script. A tape records, from the
 * document itself, every time the review card's root enters the document and
 * every time the placeholder comes back after the card first drew.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/agentic-run-panel.one-hand-over-to-the-gate.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

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
    runId: "run-3007-fx20",
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
 * THE STREAM, as the run page's stream reads through a park: its last word is
 * the spent `pending_approval` of the question answered before the run went to
 * work, with that question's interrupt retired. It is set per case.
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

const RUN_ID = "run-3007-fx20";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";
const QUESTION = '[data-conformance-id="hitl-screen-fields"]';
const RESOLVE_PATH = "/api/lifecycle-views/resolve";

/** The ticket of the gate the run parked on, and of the gate that follows it. */
const GATE_ONE = "lcr-3007-fx20-gate-one";
const GATE_TWO = "lcr-3007-fx20-gate-two";

/** A real question the run is now waiting on, naming another review task. */
const ANOTHER_OPEN_QUESTION = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `another-question-${RUN_ID}`,
  inputSchema: {
    type: "object",
    properties: { brief: { type: "string", title: "Brief" } },
    required: ["brief"],
  },
  currentValues: {},
  fieldName: "brief",
};

type Row = Record<string, unknown>;

function row(over: Partial<{
  status: string;
  ref: string | null;
  park: boolean;
  hitlContext: unknown;
}>): Row {
  return {
    status: over.status ?? "pending_approval",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    // A run parked on the review of what it produced carries NO question: the
    // one it asked before it went to work was answered, and the seed route
    // derives none for the park (hitl-context.ts, fix leg 20).
    hitlContext: over.hitlContext === undefined ? null : over.hitlContext,
    lifecycleMoment: "hitl",
    reviewGate: {
      ref: over.ref === undefined ? GATE_ONE : over.ref,
      awaiting: false,
      producedReviewPark: over.park ?? true,
    },
  };
}

/** The run parked on the review of what it produced, its gate on file. */
const parkedOnGateOne = (): Row => row({});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The transport. Every read of the run's seed route is answered by `script`,
 * which the case moves from phase to phase; the resolve route answers each
 * ticket with the state `gates` holds for it, a network round trip away.
 */
function stubTransport() {
  const state = {
    script: parkedOnGateOne as () => Row,
    runReads: 0,
    gates: new Map<string, "pending" | "settled">([[GATE_ONE, "pending"]]),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        state.runReads += 1;
        return json(state.script());
      }
      if (url.includes(RESOLVE_PATH)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { ref?: string };
        await new Promise((resolve) => setTimeout(resolve, 40));
        const gate = state.gates.get(String(body.ref));
        if (gate === undefined) return new Response("{}", { status: 404 });
        return json({
          kind: "artifact_review_gate",
          state:
            gate === "pending"
              ? { state: "pending", canDecide: true, canComment: true }
              : { state: "settled", outcome: "approved", decidedByName: "Dana Okonkwo" },
          body: null,
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return state;
}

/**
 * THE TAPE, read off the document itself: every time the review card's root
 * enters the document, and every time the placeholder comes back after the
 * card first drew, in order.
 */
function startTape() {
  const tape = {
    cardMounts: 0,
    placeholderReturns: 0,
    cardFirstDrew: false,
    events: [] as string[],
    stop: () => {},
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        const cards = (node.matches(REVIEW_CARD) ? 1 : 0) + node.querySelectorAll(REVIEW_CARD).length;
        const placeholders =
          (node.matches(PLACEHOLDER) ? 1 : 0) + node.querySelectorAll(PLACEHOLDER).length;
        if (cards > 0) {
          tape.cardMounts += cards;
          tape.cardFirstDrew = true;
          tape.events.push("card");
        }
        if (placeholders > 0 && tape.cardFirstDrew) {
          tape.placeholderReturns += placeholders;
          tape.events.push("placeholder");
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  tape.stop = () => observer.disconnect();
  return tape;
}

/** The panel as the run page mounts it, inside the rail's frame. */
async function mountAsTheRunPage() {
  const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
  ensureDefaultFieldRenderersRegistered();
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="running"
      initialError={null}
      initialMessages={[]}
      agUiEnabled
      agentId="cinatra-ai/blog-draft-writer-agent"
      agentPackageName="@cinatra-ai/blog-draft-writer-agent"
      templateId="tmpl-3007-fx20"
      initialReviewGate={{ ref: null, awaiting: false, producedReviewPark: false }}
      inputStepInRail
      railDrawsTheFrame
    />,
  );
}

async function waitForCard(ref: string, timeout = 25_000): Promise<void> {
  await waitFor(
    () => {
      const card = document.querySelector(REVIEW_CARD);
      const island = document.querySelector(`iframe[src*="${encodeURIComponent(ref)}"]`);
      if (!card || !island) throw new Error(`the review card for ${ref} has not drawn`);
    },
    { timeout },
  );
}

/** Let `n` more reads of the run's seed route happen. */
async function reads(state: { runReads: number }, n: number, timeout = 30_000): Promise<void> {
  const from = state.runReads;
  await waitFor(
    () => {
      if (state.runReads - from < n) throw new Error(`only ${state.runReads - from} of ${n} reads`);
    },
    { timeout },
  );
}

/** Answer exactly the NEXT read of the run's seed route with `once`. */
function answerNextReadWith(state: { script: () => Row }, once: () => Row): void {
  const after = state.script;
  let spent = false;
  state.script = () => {
    if (spent) return after();
    spent = true;
    return once();
  };
}

beforeEach(() => {
  streamState.status = "pending_approval";
  streamState.interruptContext = null;
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


describe("one hand-over from the placeholder to the gate (cinatra#3007, fix leg 20)", () => {
  // H1 - the measured shape: one reading of the run answers it from before the
  // park (the status still `running`, no park, no gate) between readings that
  // answer the gate. The status and the slot's reference disagree for that one
  // reading; at the head the card unmounted there and was mounted again.
  it("H1: the card mounts once and the placeholder never returns after the card first drew, across a reading that answers without the gate", async () => {
    const state = stubTransport();
    const tape = startTape();
    await mountAsTheRunPage();
    await waitForCard(GATE_ONE);
    await reads(state, 2);
    answerNextReadWith(state, () =>
      row({ status: "running", ref: null, park: false, hitlContext: null }),
    );
    await reads(state, 8);
    tape.stop();

    expect(
      { mounts: tape.cardMounts, placeholderReturns: tape.placeholderReturns },
      `the tape after the card first drew: ${tape.events.join(", ")}`,
    ).toEqual({ mounts: 1, placeholderReturns: 0 });
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
  }, 120_000);

  // H2 - after the decision the run is released: it reads `running`, then
  // `completed`, and the slot names the decided gate. The settled card is the
  // gate itself and is never given back to the placeholder.
  it("H2: after the decision the card stays mounted once through running and completed, and the placeholder never returns", async () => {
    const state = stubTransport();
    const tape = startTape();
    await mountAsTheRunPage();
    await waitForCard(GATE_ONE);
    await reads(state, 2);

    state.gates.set(GATE_ONE, "settled");
    streamState.status = "running";
    state.script = () => row({ status: "running", ref: GATE_ONE, park: false });
    await reads(state, 3);
    streamState.status = "completed";
    state.script = () => row({ status: "completed", ref: GATE_ONE, park: false });
    await reads(state, 4);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    tape.stop();

    expect(
      { mounts: tape.cardMounts, placeholderReturns: tape.placeholderReturns },
      `the tape after the card first drew: ${tape.events.join(", ")}`,
    ).toEqual({ mounts: 1, placeholderReturns: 0 });
    expect(document.querySelector(REVIEW_CARD)).not.toBeNull();
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
  }, 120_000);

  // H3 - GUARD. A slot that names a NEW gate - the run decided the first and
  // parked at a successor - hands over to THAT gate's card, keyed on its own
  // reference: the first gate's card is not kept over it, and the column is
  // never empty while the successor's card resolves.
  it("H3: a slot naming a successor gate mounts that gate's card, and the column is never empty on the way", async () => {
    const state = stubTransport();
    await mountAsTheRunPage();
    await waitForCard(GATE_ONE);
    await reads(state, 2);

    const readings: Array<{ card: boolean; placeholder: boolean }> = [];
    const sampler = window.setInterval(() => {
      readings.push({
        card: document.querySelector(REVIEW_CARD) !== null,
        placeholder: document.querySelector(PLACEHOLDER) !== null,
      });
    }, 50);
    state.gates.set(GATE_ONE, "settled");
    state.gates.set(GATE_TWO, "pending");
    state.script = () => row({ ref: GATE_TWO });
    try {
      await waitForCard(GATE_TWO, 30_000);
    } finally {
      window.clearInterval(sampler);
    }

    expect(
      document.querySelector(`iframe[src*="${encodeURIComponent(GATE_ONE)}"]`),
      "the first gate's card was kept over the successor",
    ).toBeNull();
    const empty = readings.filter((r) => !r.card && !r.placeholder);
    expect(empty.length, `${empty.length} of ${readings.length} readings drew an empty column`).toBe(0);
    const both = readings.filter((r) => r.card && r.placeholder);
    expect(both.length, `${both.length} readings drew the placeholder beside a drawn card`).toBe(0);
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
  }, 120_000);

  // H4 - GUARD. A real question on file that names ANOTHER review task is the
  // question the run is waiting on: it is drawn, and no card is kept over it.
  it("H4: a question on file naming another review task is drawn as the question, and no card is kept over it", async () => {
    const state = stubTransport();
    await mountAsTheRunPage();
    await waitForCard(GATE_ONE);
    await reads(state, 2);

    state.script = () => row({ ref: null, park: false, hitlContext: ANOTHER_OPEN_QUESTION });
    await waitFor(
      () => {
        if (!document.querySelector(QUESTION)) throw new Error("the question is not drawn");
      },
      { timeout: 60_000 },
    );
    await reads(state, 3);

    expect(document.querySelector(QUESTION)).not.toBeNull();
    expect(document.querySelector(REVIEW_CARD)).toBeNull();
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  }, 120_000);
});
