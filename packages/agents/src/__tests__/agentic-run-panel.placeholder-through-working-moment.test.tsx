// @vitest-environment jsdom
/**
 * THE PLACEHOLDER STANDS THROUGH THE WHOLE WORKING MOMENT (cinatra#3739, on
 * the run page of cinatra#3007).
 *
 * The checklist sentence this file pins: "the placeholder stands in the run
 * detail column at every one-second reading from the Continue until the review
 * gate card stands". The drawing's own sentence: "While the run works, the
 * detail carries a placeholder. A run that will ask for a review carries, in
 * the run detail, the run progress card".
 *
 * WHAT WAS MEASURED. One real run on the run page, its context gate answered
 * by its one Continue, read once a second until the review card stood: the
 * paused plate for 84 readings, the placeholder for 1, and an empty column for
 * 19. Two branches, both on the page state mounted below:
 *
 *   - no RESUME frame reaches the stream after the Continue, so the stream's
 *     interrupt STAYS SET and kept counting as on file; the status stayed
 *     pending_approval while the row read running, and the answered form (hidden
 *     by the renderer-keyed suppression) left the paused plate behind;
 *   - once the review slot's reference was read, the placeholder gave way to a
 *     review card that draws nothing until its own resolve has answered.
 *
 * The panel is mounted the way `SetupCompletionWatcher` mounts it on that page:
 * the stream on, no task id, served `running` with the rail drawing the frame.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --no-coverage \
 *     src/__tests__/agentic-run-panel.placeholder-through-working-moment.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

const { approveReviewTask } = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask,
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3739-moment",
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
 * THE STREAM, as the live page's stream read through the whole working moment:
 * its last word is the context gate's INTERRUPT, and the interrupt STAYS SET
 * after the Continue, because no RESUME frame reaches the stream.
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

const RUN_ID = "run-3739-moment";
const CONTEXT_RENDERER = "@cinatra-ai/context-selection-agent:context-selector";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";
const PLATE = "[data-run-progress-panel]";
const QUESTION = '[data-conformance-id="hitl-screen-fields"]';
const CONTINUE = '[data-action="submit-hitl-screen"]';
const RESOLVE_PATH = "/api/lifecycle-views/resolve";

/** The context gate the run asks, as the stream carries it. */
const CONTEXT_GATE_INTERRUPT = {
  schema: {
    type: "object",
    title: "Draft Context",
    properties: { selectedRefs: { type: "array" } },
  },
  xRenderer: CONTEXT_RENDERER,
  values: {
    candidates: [],
    selectedRefs: [],
    slotMeta: { slotId: "draftContext", resolutionMode: "accumulate" },
  },
  reviewTaskId: `context-${RUN_ID}`,
};

/** The same gate as the run's row carries it once the run has parked. */
const ANSWERED_CONTEXT_GATE_ON_ROW = {
  xRenderer: CONTEXT_RENDERER,
  childRunId: null,
  reviewTaskId: `context-${RUN_ID}`,
  inputSchema: CONTEXT_GATE_INTERRUPT.schema,
  currentValues: CONTEXT_GATE_INTERRUPT.values,
  fieldName: null,
};

const NO_GATE = { ref: null, awaiting: false, producedReviewPark: false };
const PARK_WITH_GATE = {
  ref: "lcr-3739-moment-gate",
  awaiting: false,
  producedReviewPark: true,
};

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** What the run's seed route answered on the live page while the run worked. */
function workingRow(): Record<string, unknown> {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    lifecycleMoment: "hitl",
    reviewGate: NO_GATE,
  };
}

/** The same route once the run has parked on the review of what it produced. */
function parkedRow(): Record<string, unknown> {
  return {
    ...workingRow(),
    status: "pending_approval",
    hitlContext: ANSWERED_CONTEXT_GATE_ON_ROW,
    reviewGate: PARK_WITH_GATE,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The transport. The run route answers `row()`; the panel's own tick is the
 * read whose init carries no signal (`refetchDerivedContext`), while the review
 * slot reader and the moment-card reader read it with one. The review card's
 * resolve is HELD while `resolve.held` is true, the card's own pending look.
 */
function stubTransport(row: () => Record<string, unknown>) {
  const counts = { panelReads: 0, resolveAsks: 0 };
  const resolve = {
    held: true,
    waiting: [] as Array<() => void>,
    release() {
      this.held = false;
      for (const answer of this.waiting.splice(0)) answer();
    },
  };
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      if (!init?.signal) counts.panelReads += 1;
      return json(row());
    }
    if (url.includes(RESOLVE_PATH)) {
      counts.resolveAsks += 1;
      if (!resolve.held) return json(RESOLVE_PENDING);
      return new Promise<Response>((answer, refuse) => {
        resolve.waiting.push(() => answer(json(RESOLVE_PENDING)));
        init?.signal?.addEventListener("abort", () =>
          refuse(new DOMException("aborted", "AbortError")),
        );
      });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { counts, resolve };
}

/** The panel as `SetupCompletionWatcher` mounts it on the live run page. */
async function mountAsTheRunPage() {
  // Registered in the module graph the panel is imported into: every case
  // after the first imports a fresh one (`vi.resetModules` below).
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
      templateId="tmpl-3739-moment"
      initialHitlContext={null}
      initialReviewGate={NO_GATE}
      inputStepInRail={false}
      railDrawsTheFrame
    />,
  );
}

/** Press the context gate's one Continue, through the panel's own submit. */
async function pressContinue(): Promise<void> {
  const button = await waitFor(
    () => {
      const el = document.querySelector<HTMLButtonElement>(CONTINUE);
      if (!el || el.disabled) throw new Error("the Draft Context Continue is not standing");
      return el;
    },
    { timeout: 20_000 },
  );
  fireEvent.click(button);
  await waitFor(() => {
    if (approveReviewTask.mock.calls.length < 1) {
      throw new Error("the Continue did not reach the panel's own submit");
    }
  });
}

/** Let the panel's own tick read the seed route twice from now on. */
async function twoPanelTicks(counts: { panelReads: number }): Promise<void> {
  const from = counts.panelReads;
  await waitFor(
    () => {
      if (counts.panelReads - from < 2) {
        throw new Error(`the panel's own tick read the row ${counts.panelReads - from} times`);
      }
    },
    { timeout: 20_000 },
  );
}

type Reading = {
  placeholder: boolean;
  placeholderWellFormed: boolean;
  card: boolean;
  slot: string | null;
  plate: boolean;
  paused: boolean;
};

/** One reading of the run detail column. */
function readColumn(): Reading {
  const placeholder = document.querySelector(PLACEHOLDER);
  return {
    placeholder: placeholder !== null,
    placeholderWellFormed:
      placeholder !== null &&
      placeholder.getAttribute("role") === "status" &&
      placeholder.getAttribute("aria-busy") === "true" &&
      (placeholder.textContent ?? "").includes("Agentic Run Progress") &&
      placeholder.querySelector("button") === null,
    card: document.querySelector(REVIEW_CARD) !== null,
    slot: document.querySelector(SLOT)?.getAttribute("data-run-review-slot") ?? null,
    plate: document.querySelector(PLATE) !== null,
    paused: (document.body.textContent ?? "").includes("Run paused"),
  };
}

/** The readings, told as the distinct shapes they took and how often. */
function shapes(readings: Reading[]): string {
  const tally = new Map<string, number>();
  for (const r of readings) {
    const shape = r.card
      ? r.placeholder
        ? "placeholder+card"
        : "card"
      : r.placeholder
        ? "placeholder"
        : r.plate
          ? "plate"
          : r.slot !== null
            ? `empty ${r.slot} slot`
            : "nothing";
    tally.set(shape, (tally.get(shape) ?? 0) + 1);
  }
  return [...tally].map(([shape, n]) => `${shape} x${n}`).join(", ");
}

async function sample(count: number, everyMs: number): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    readings.push(readColumn());
  }
  return readings;
}

beforeEach(() => {
  streamState.status = "pending_approval";
  streamState.interruptContext = CONTEXT_GATE_INTERRUPT;
  approveReviewTask.mockReset();
  approveReviewTask.mockResolvedValue({ ok: true });
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

describe("the placeholder stands in the run detail through the whole working moment (cinatra#3739)", () => {
  it("the placeholder stands in the run detail column at every reading after the Continue while the run works", async () => {
    const { counts } = stubTransport(workingRow);
    await mountAsTheRunPage();
    await pressContinue();
    // The stream's interrupt is left exactly where it was: no RESUME arrives.
    expect(streamState.interruptContext).toBe(CONTEXT_GATE_INTERRUPT);
    await twoPanelTicks(counts);

    const readings = await sample(12, 1000);
    const wrong = readings.filter(
      (r) => !r.placeholder || !r.placeholderWellFormed || r.plate || r.paused,
    );
    expect(
      wrong.length,
      `the run detail held something other than the placeholder on ${wrong.length} of ${readings.length} readings after the Continue (${shapes(readings)}; first: ${JSON.stringify(wrong[0] ?? null)})`,
    ).toBe(0);
    expect(readings.every((r) => r.slot === "working" && !r.card)).toBe(true);
  }, 90_000);

  it("the placeholder stands until the review gate card has drawn, and never beside it", async () => {
    let row = workingRow;
    const { counts, resolve } = stubTransport(() => row());
    await mountAsTheRunPage();
    await pressContinue();
    await twoPanelTicks(counts);
    const readings: Reading[] = [readColumn()];

    // THE RUN PARKS on the review of what it produced, with its gate on file,
    // while the card's own resolve has not answered yet.
    row = parkedRow;
    await waitFor(
      () => {
        readings.push(readColumn());
        if (counts.resolveAsks < 1) throw new Error("the review card has not been mounted");
      },
      { timeout: 30_000, interval: 250 },
    );
    readings.push(...(await sample(12, 500)));

    // THE CARD'S RESOLVE ANSWERS, and the card draws.
    resolve.release();
    await waitFor(
      () => {
        readings.push(readColumn());
        if (!document.querySelector(REVIEW_CARD)) throw new Error("the card has not drawn");
      },
      { timeout: 20_000, interval: 100 },
    );
    readings.push(...(await sample(4, 500)));

    const notExactlyOne = readings.filter((r) => r.placeholder === r.card);
    expect(
      notExactlyOne.length,
      `the run detail held ${notExactlyOne.length} of ${readings.length} readings with neither or both of the placeholder and the review gate card (${shapes(readings)}; first: ${JSON.stringify(notExactlyOne[0] ?? null)})`,
    ).toBe(0);
    expect(readings.some((r) => r.plate || r.paused)).toBe(false);
    const last = readColumn();
    expect(last.card).toBe(true);
    expect(last.placeholder).toBe(false);
    expect(last.slot).toBe("review");
    expect(document.querySelectorAll(SLOT).length).toBe(1);
  }, 120_000);

  it("a live question on file is drawn as the question, never the placeholder", async () => {
    // A NEW interrupt from the stream, with a DIFFERENT review task, after the
    // Continue: the next step's question is drawn.
    const { counts } = stubTransport(workingRow);
    await mountAsTheRunPage();
    await pressContinue();
    streamState.interruptContext = {
      schema: {
        type: "object",
        title: "idea",
        properties: { title: { type: "string" } },
        required: ["title"],
        "x-object-text-property": "title",
      },
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      fieldName: "idea",
      reviewTaskId: `next-step-${RUN_ID}`,
    };
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    expect(document.querySelector(QUESTION)).not.toBeNull();

    // The SAME renderer asking again under a DIFFERENT review task is a new
    // question too: it is never read as the answered one.
    streamState.interruptContext = {
      ...CONTEXT_GATE_INTERRUPT,
      reviewTaskId: `context-again-${RUN_ID}`,
    };
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    cleanup();

    // The ROW reading pending_approval with its question on file, after the
    // Continue, with the stream's interrupt gone: the question is drawn.
    streamState.interruptContext = CONTEXT_GATE_INTERRUPT;
    const rowQuestion = {
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
    const second = stubTransport(() => ({
      ...workingRow(),
      status: "pending_approval",
      hitlContext: rowQuestion,
    }));
    await mountAsTheRunPage();
    await pressContinue();
    streamState.interruptContext = null;
    await twoPanelTicks(second.counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    expect(document.querySelector(QUESTION)).not.toBeNull();
  }, 120_000);
});

/**
 * THE QUESTION THE PERSON ANSWERED IS SPENT WHEREVER IT IS READ (cinatra#3739,
 * fix leg 19). The checklist sentences: "the question the person answered is
 * spent wherever it is read" and "the placeholder stands in the run detail
 * column at every one-second reading from the Continue until the review gate
 * card stands".
 *
 * WHAT WAS MEASURED after the first cure. The first one-second reading after the
 * Continue was still the paused plate: until the server resumes, the run's ROW
 * itself reads pending_approval and carries the answered question as its own
 * (a plate paint 56 ms after the press, the placeholder 816 ms after it, the row
 * reading running two seconds later). The cases below mount that row.
 */
const ANOTHER_QUESTION_SCHEMA = {
  type: "object",
  title: "idea",
  properties: { title: { type: "string" } },
  required: ["title"],
  "x-object-text-property": "title",
};

/** The row as the seed route answers it before the server has resumed. */
function rowStillOnTheAnsweredQuestion(): Record<string, unknown> {
  return {
    ...workingRow(),
    status: "pending_approval",
    hitlContext: ANSWERED_CONTEXT_GATE_ON_ROW,
  };
}

/** Let the panel's own tick read the seed route once before the press. */
async function onePanelTickBeforeThePress(counts: { panelReads: number }): Promise<void> {
  await waitFor(
    () => {
      if (counts.panelReads < 1) throw new Error("the panel's own tick has not read the row yet");
    },
    { timeout: 20_000 },
  );
}

describe("the question the person answered is spent wherever it is read (cinatra#3739)", () => {
  it("the placeholder stands from the first reading after the Continue while the row still carries the answered question", async () => {
    // The row answers pending_approval with the ANSWERED question for its first
    // two readings after the press, then running with no question.
    let pressedAtRead: number | null = null;
    let answeredRowReadsAfterPress = 0;
    const seen = { panelReads: () => 0 };
    const transport = stubTransport(() => {
      if (pressedAtRead === null) return rowStillOnTheAnsweredQuestion();
      if (seen.panelReads() - pressedAtRead <= 2) {
        answeredRowReadsAfterPress += 1;
        return rowStillOnTheAnsweredQuestion();
      }
      return workingRow();
    });
    seen.panelReads = () => transport.counts.panelReads;
    await mountAsTheRunPage();
    await onePanelTickBeforeThePress(transport.counts);
    pressedAtRead = transport.counts.panelReads;
    await pressContinue();
    // The stream's interrupt is left exactly where it was: no RESUME arrives.
    expect(streamState.interruptContext).toBe(CONTEXT_GATE_INTERRUPT);

    // The first reading is the first paint after the press, before the tick has
    // answered running.
    const readings: Reading[] = [readColumn()];
    readings.push(...(await sample(16, 500)));
    await waitFor(
      () => {
        if (transport.counts.panelReads - (pressedAtRead ?? 0) < 3) {
          throw new Error("the panel's own tick has not read the row running yet");
        }
      },
      { timeout: 20_000 },
    );
    readings.push(...(await sample(4, 1000)));

    const wrong = readings.filter(
      (r) => !r.placeholder || !r.placeholderWellFormed || r.plate || r.paused,
    );
    expect(
      wrong.length,
      `the run detail held something other than the placeholder on ${wrong.length} of ${readings.length} readings after the Continue while the row carried the answered question (${shapes(readings)}; first: ${JSON.stringify(wrong[0] ?? null)})`,
    ).toBe(0);
    expect(readings.every((r) => r.slot === "working" && !r.card)).toBe(true);
    // The row really was read carrying the answered question after the press.
    expect(answeredRowReadsAfterPress).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("after the Continue, a row question naming another review task is drawn as the question, never the placeholder", async () => {
    let rowQuestion: Record<string, unknown> = ANSWERED_CONTEXT_GATE_ON_ROW;
    const { counts } = stubTransport(() => ({
      ...workingRow(),
      status: "pending_approval",
      hitlContext: rowQuestion,
    }));
    await mountAsTheRunPage();
    await onePanelTickBeforeThePress(counts);
    await pressContinue();

    // ANOTHER review task on the row, the stream still holding the answered
    // interrupt: the run is waiting, never working.
    rowQuestion = {
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      childRunId: null,
      reviewTaskId: `wayflow-next-${RUN_ID}`,
      inputSchema: ANOTHER_QUESTION_SCHEMA,
      currentValues: {},
      fieldName: "idea",
    };
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }

    // The stream's answered interrupt retired: the row's question is drawn.
    streamState.interruptContext = null;
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    expect(document.querySelector(QUESTION)).not.toBeNull();

    // The ANSWERED review task asking another question (another renderer and
    // field) is a new question too: it is never read as the answered one.
    rowQuestion = {
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      childRunId: null,
      reviewTaskId: ANSWERED_CONTEXT_GATE_ON_ROW.reviewTaskId,
      inputSchema: ANOTHER_QUESTION_SCHEMA,
      currentValues: {},
      fieldName: "idea",
    };
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    expect(document.querySelector(QUESTION)).not.toBeNull();
  }, 120_000);

  it("a refused or thrown Continue gives the answered question back, never the placeholder", async () => {
    const refusal = { ok: false, blocked: "no-longer-pending" as const };
    for (const road of ["refused", "thrown"] as const) {
      cleanup();
      vi.unstubAllGlobals();
      streamState.interruptContext = CONTEXT_GATE_INTERRUPT;
      let settled = false;
      approveReviewTask.mockReset();
      if (road === "refused") {
        approveReviewTask.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          settled = true;
          return refusal;
        });
      } else {
        approveReviewTask.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          settled = true;
          throw new Error("the review service did not answer");
        });
      }
      // The row still reads pending_approval with the answered question.
      const { counts } = stubTransport(rowStillOnTheAnsweredQuestion);
      await mountAsTheRunPage();
      await onePanelTickBeforeThePress(counts);
      await pressContinue();
      await waitFor(
        () => {
          if (!settled) throw new Error(`the ${road} submit has not settled`);
          if (!document.querySelector(QUESTION)) {
            throw new Error(`the question was not drawn again after the ${road} submit`);
          }
        },
        { timeout: 20_000 },
      );
      await twoPanelTicks(counts);
      for (const reading of await sample(6, 500)) {
        expect(reading.placeholder, `the ${road} submit drew the placeholder`).toBe(false);
      }
      expect(document.querySelector(QUESTION), `the ${road} submit lost the question`).not.toBeNull();
      if (road === "refused") {
        expect(
          document.querySelector('[data-conformance-id="review-gate-blocked"]'),
          "the refused submit lost its blocked reading",
        ).not.toBeNull();
      }
    }
  }, 120_000);

  it("after the Continue, a stream question under the answered review task with another renderer and field is drawn, never the placeholder", async () => {
    // "the question the person answered is spent wherever it is read" - and
    // only that question. A run's gates can share one review task, so a NEW
    // stream interrupt under the answered review task that asks another
    // renderer and field is a new question, while the row still reads running
    // with no question of its own.
    const { counts } = stubTransport(workingRow);
    await mountAsTheRunPage();
    await pressContinue();
    streamState.interruptContext = {
      schema: ANOTHER_QUESTION_SCHEMA,
      xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      values: {},
      fieldName: "idea",
      reviewTaskId: CONTEXT_GATE_INTERRUPT.reviewTaskId,
    };
    await twoPanelTicks(counts);
    for (const reading of await sample(6, 500)) {
      expect(reading.placeholder).toBe(false);
    }
    expect(document.querySelector(QUESTION)).not.toBeNull();
  }, 120_000);
});
