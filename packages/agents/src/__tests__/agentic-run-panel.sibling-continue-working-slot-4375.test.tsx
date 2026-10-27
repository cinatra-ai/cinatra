// @vitest-environment jsdom
/**
 * THE SIBLING CARD'S CONTINUE HOLDS THE PANEL'S WORKING SLOT (cinatra#4375).
 *
 * Inside a conversation (`site_widget`, `chat_thread`) the run's question and
 * its Continue belong to the conversation's own HITL screen card, a sibling of
 * the run panel. The panel held its working slot after a Continue only when its
 * OWN submit had armed the answered-question key (cinatra#3739, fix leg 19), so
 * a Continue on the sibling card left the widget's panel on its collapsed
 * "pending approval" progress plate while the stream and the row still carried
 * the answered question.
 *
 * Mounted as the conversation view mounts them (`chat-messages-view.tsx`): the
 * real `AgentHitlScreenCard` and the real `AgenticRunPanel` side by side under
 * one host declaration. Only the server, stream and slot-reader ports are
 * fixtures. This is not a hosted-widget run or capture proof.
 *
 * Run:
 *   pnpm exec vitest run --no-coverage \
 *     packages/agents/src/__tests__/agentic-run-panel.sibling-continue-working-slot-4375.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/embed/assistant",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/** The cookie door's answer (`chat_thread`), held until the arm releases it. */
const cookieDoor = vi.hoisted(() => ({
  answer: { ok: true } as { ok: boolean; blocked?: string } | "throw",
  held: null as Promise<void> | null,
}));
const { approveReviewTask } = vi.hoisted(() => ({
  approveReviewTask: vi.fn(),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask,
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-4375",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ kind: "ok", entries: [] })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

/** The cookie door's screen read (`chat_thread`): the card's own question. */
const { getAgentHitlScreenStateAction } = vi.hoisted(() => ({
  getAgentHitlScreenStateAction: vi.fn(),
}));
vi.mock("../agent-hitl-screen-actions", () => ({ getAgentHitlScreenStateAction }));

/**
 * THE STREAM, as it reads through the working moment: its last word is the
 * question's INTERRUPT, and it STAYS SET after the Continue, because no RESUME
 * frame reaches the stream before the server resumes.
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

import {
  LifecycleCardSurfaceProvider,
  answeredHitlQuestionKey,
  createAnsweredHitlQuestionRegister,
  useAnsweredHitlQuestionRegister,
  type AnsweredHitlQuestionRegister,
  type RunReviewSlot,
} from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { AgenticRunPanel } from "../agentic-run-panel";

const RUN_ID = "run-4375";
const TASK = "task-4375";
// A MID-RUN gate: the card draws its own outer Continue for it on every host.
const RENDERER = "cinatra.schema-field:output";
const SCHEMA = { type: "object", properties: { answer: { type: "string" } } };

const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const PLATE = "[data-run-progress-panel]";
const SLOT = "[data-run-review-slot]";
const CARD = '[data-lifecycle-card="agent_hitl_screen"]';
const CARD_CONTINUE = `${CARD} [data-action="submit-hitl-screen"]`;

type Question = { reviewTaskId: string; xRenderer: string; fieldName: string | null };
const ANSWERED: Question = { reviewTaskId: TASK, xRenderer: RENDERER, fieldName: null };

/** The question as the card's authorized read answers it. */
function asking(q: Question) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-4375",
    gate: { reviewTaskId: q.reviewTaskId, xRenderer: q.xRenderer, inputSchema: SCHEMA, currentValues: {}, fieldName: q.fieldName },
  };
}
/** The question as the stream's interrupt carries it. */
function interrupt(q: Question): Record<string, unknown> {
  return {
    schema: SCHEMA,
    xRenderer: q.xRenderer,
    values: {},
    reviewTaskId: q.reviewTaskId,
    ...(q.fieldName !== null ? { fieldName: q.fieldName } : {}),
  };
}
/** The question as the run's row carries it. */
function onRow(q: Question): Record<string, unknown> {
  return {
    xRenderer: q.xRenderer,
    childRunId: null,
    reviewTaskId: q.reviewTaskId,
    inputSchema: SCHEMA,
    currentValues: {},
    fieldName: q.fieldName,
  };
}

const NOT_PARKED: RunReviewSlot = { ref: null, awaiting: false, producedReviewPark: false };

/** What the run's own row answers, per arm. */
let rowAnswer: () => Response;
function rowWith(q: Question): () => Response {
  return () =>
    json({
      status: "pending_approval",
      error: null,
      startedAt: null,
      completedAt: null,
      messages: [],
      hitlContext: onRow(q),
      lifecycleMoment: "hitl",
      reviewGate: NOT_PARKED,
    });
}

/** The broker door's answer (`site_widget`), held until the arm releases it. */
let brokerSubmit: "accepted" | "refused" | "http-refused" | "throw";
let submitHeld: Promise<void> | null;
let releaseSubmit: () => void;
let cardQuestion: Question;
let requests: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function hold(): void {
  submitHeld = new Promise<void>((done) => {
    releaseSubmit = done;
  });
  cookieDoor.held = submitHeld;
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:session-free-4375",
    priority: 90,
    condition: (_f, _s, ctx) => typeof ctx.xRenderer === "string" && ctx.xRenderer.startsWith("cinatra.schema-field"),
    renderer: () => <span>question-4375</span>,
    credentialSafe: true,
  });
  streamState.status = "pending_approval";
  streamState.interruptContext = interrupt(ANSWERED);
  rowAnswer = rowWith(ANSWERED);
  cardQuestion = ANSWERED;
  brokerSubmit = "accepted";
  cookieDoor.answer = { ok: true };
  requests = [];
  hold();
  getAgentHitlScreenStateAction.mockImplementation(async () => asking(cardQuestion));
  approveReviewTask.mockImplementation(async () => {
    await cookieDoor.held;
    if (cookieDoor.answer === "throw") throw new Error("the decision road refused this");
    return cookieDoor.answer;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/hitl-screen/submit")) {
        await submitHeld;
        if (brokerSubmit === "throw") throw new TypeError("network down");
        if (brokerSubmit === "http-refused") return json({ error: "forbidden" }, 403);
        return json({ outcome: brokerSubmit === "accepted" ? { ok: true } : { ok: false, blocked: "refused" } });
      }
      if (url.includes("/hitl-screen")) return json(asking(cardQuestion));
      if (url.includes("/api/agents/runs/")) return rowAnswer();
      if (url.endsWith("/recommendation-hold")) return json({ state: "none" });
      if (url.startsWith("/api/notifications")) return json({ notifications: [] });
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "unit-broker-4375" }),
  credentials: "omit" as const,
};
const FRAME = { assistant: "wordpress", instanceId: "unit-instance-4375" };

const readReviewSlot = vi.fn(async () => NOT_PARKED);

/**
 * The panel's props, as `InlineAgentRunCard` passes them in a conversation: its
 * first question is the seed, which is the run's row at mount.
 */
function panel(seedQuestion: Question = ANSWERED) {
  return (
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled
      agentPackageName="@cinatra-ai/blog-draft-writer-agent"
      templateId="tmpl-4375"
      initialHitlContext={onRow(seedQuestion) as never}
      surface="chat"
      initialReviewGate={NOT_PARKED}
      readReviewSlot={readReviewSlot}
    />
  );
}

/** The card and the panel side by side, as the conversation view mounts them. */
function mountConversation(host: "site_widget" | "chat_thread", seedQuestion: Question = ANSWERED) {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      auth={host === "site_widget" ? WIDGET_AUTH : undefined}
      frame={host === "site_widget" ? FRAME : undefined}
    >
      <div data-agent-run-slot={RUN_ID}>
        {panel(seedQuestion)}
        <div data-agent-run-screen-slot={RUN_ID}>
          <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK} />
        </div>
      </div>
    </LifecycleCardSurfaceProvider>,
  );
}

type Reading = { placeholder: boolean; plate: boolean; slot: string | null };
function readColumn(): Reading {
  return {
    placeholder: document.querySelector(PLACEHOLDER) !== null,
    plate: document.querySelector(PLATE) !== null,
    slot: document.querySelector(SLOT)?.getAttribute("data-run-review-slot") ?? null,
  };
}

/** Wait until the panel's own tick has read the run's row `n` more times. */
async function rowReads(n: number): Promise<void> {
  const count = () => requests.filter((u) => u.includes("/api/agents/runs/")).length;
  const from = count();
  await waitFor(
    () => {
      if (count() - from < n) throw new Error(`the panel read the row ${count() - from} of ${n} times`);
    },
    { timeout: 30_000 },
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Wait until the panel stands on the question's plate with no hold: the slot
 * reader has answered "not parked", so neither the park nor its unheard window
 * holds the working slot, and the sibling card's Continue stands.
 */
async function blockedOnTheQuestion(): Promise<HTMLButtonElement> {
  await waitFor(
    () => {
      if (readReviewSlot.mock.calls.length < 1) throw new Error("the slot reader has not been asked");
      const r = readColumn();
      if (!r.plate || r.placeholder) throw new Error(`the panel is not on the plate yet: ${JSON.stringify(r)}`);
    },
    { timeout: 20_000 },
  );
  return waitFor(
    () => {
      const button = document.querySelector<HTMLButtonElement>(CARD_CONTINUE);
      if (!button || button.disabled) throw new Error("the sibling card's Continue is not standing");
      return button;
    },
    { timeout: 20_000 },
  );
}

/**
 * Press the sibling's Continue, let its submit land with the arm's answer, and
 * return every reading of the column from the landing on: one per DOM change,
 * then a few more over the panel's own ticks.
 */
async function pressSiblingContinue(button: HTMLButtonElement): Promise<{ before: Reading; after: Reading[] }> {
  await act(async () => {
    button.click();
    await flush();
  });
  await waitFor(() => {
    const sent =
      requests.some((u) => u.endsWith("/hitl-screen/submit")) || approveReviewTask.mock.calls.length > 0;
    if (!sent) throw new Error("the sibling's Continue issued no submit");
  });
  const before = readColumn();
  const after: Reading[] = [];
  const observer = new MutationObserver(() => after.push(readColumn()));
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  await act(async () => {
    releaseSubmit();
    await flush();
  });
  after.push(readColumn());
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    after.push(readColumn());
  }
  observer.disconnect();
  return { before, after };
}

function told(readings: Reading[]): string {
  return readings.map((r) => (r.placeholder ? `placeholder(${r.slot})` : r.plate ? "plate" : `other(${r.slot})`)).join(", ");
}

function expectWorkingFromTheFirstReading(before: Reading, after: Reading[]): void {
  expect(before.plate, "before the submit landed the panel stood on the plate").toBe(true);
  expect(after.length).toBeGreaterThan(0);
  expect(
    after[0].placeholder && after[0].slot === "working" && !after[0].plate,
    `the first reading after the sibling's submit landed is not the working slot (${told(after)})`,
  ).toBe(true);
  expect(
    after.filter((r) => r.plate || !r.placeholder).length,
    `a reading after the landing left the working slot (${told(after)})`,
  ).toBe(0);
}

function expectStillBlocked(after: Reading[]): void {
  expect(
    after.filter((r) => r.placeholder || !r.plate).length,
    `the panel left the question's plate (${told(after)})`,
  ).toBe(0);
}

describe("AC 1: the sibling card's Continue on the widget holds the working slot (cinatra#4375)", () => {
  it("site_widget: after the sibling's Continue lands, the first reading is the working slot with its placeholder, never the plate", async () => {
    mountConversation("site_widget");
    const button = await blockedOnTheQuestion();
    const { before, after } = await pressSiblingContinue(button);
    // The submit went through the broker door, and nothing released the block
    // but the answer: the stream and the row still carry the answered question.
    expect(requests.some((u) => u.endsWith("/hitl-screen/submit"))).toBe(true);
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(streamState.status).toBe("pending_approval");
    expect(streamState.interruptContext).toEqual(interrupt(ANSWERED));
    expectWorkingFromTheFirstReading(before, after);
  }, 60_000);
});

describe("AC 2: refusals stay blocked", () => {
  for (const answer of ["refused", "http-refused", "throw"] as const) {
    it(`site_widget: a sibling submit that is ${answer} leaves the panel on the plate`, async () => {
      brokerSubmit = answer;
      mountConversation("site_widget");
      const button = await blockedOnTheQuestion();
      const { after } = await pressSiblingContinue(button);
      expect(requests.some((u) => u.endsWith("/hitl-screen/submit"))).toBe(true);
      expectStillBlocked(after);
    }, 60_000);
  }

  for (const answer of [{ ok: false, blocked: "no-longer-pending" }, "throw"] as const) {
    it(`chat_thread: a sibling submit answered ${JSON.stringify(answer)} leaves the panel on the plate`, async () => {
      // "no longer pending" settles the CARD as a landing, but it is not this
      // submit's accepted answer, so it tells the panel nothing.
      cookieDoor.answer = answer;
      mountConversation("chat_thread");
      const button = await blockedOnTheQuestion();
      const { after } = await pressSiblingContinue(button);
      expect(approveReviewTask).toHaveBeenCalled();
      expectStillBlocked(after);
    }, 60_000);
  }

  it("site_widget: a failed row read, with no accepted Continue, leaves the panel on the plate", async () => {
    rowAnswer = () => json({ error: "unavailable" }, 500);
    mountConversation("site_widget");
    await blockedOnTheQuestion();
    await rowReads(2);
    const readings: Reading[] = [];
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      readings.push(readColumn());
    }
    expectStillBlocked(readings);
  }, 60_000);

  it("site_widget: a malformed row read, with no accepted Continue, leaves the panel on the plate", async () => {
    // A body that is not JSON: the panel's own read fails it as a transport failure.
    rowAnswer = () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
    mountConversation("site_widget");
    await blockedOnTheQuestion();
    await rowReads(2);
    const readings: Reading[] = [];
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      readings.push(readColumn());
    }
    expectStillBlocked(readings);
  }, 60_000);

  it("site_widget: a row question with no review task, after an accepted Continue, is still an open question", async () => {
    mountConversation("site_widget");
    const button = await blockedOnTheQuestion();
    rowAnswer = rowWith({ reviewTaskId: "", xRenderer: RENDERER, fieldName: null });
    // Two of the panel's own ticks read the changed row before the landing.
    await rowReads(2);
    const { after } = await pressSiblingContinue(button);
    expectStillBlocked(after);
  }, 60_000);
});

describe("AC 3: another question stays open", () => {
  const cases: Array<{ name: string; stream: Question; row: Question }> = [
    {
      name: "a different review task on the stream",
      stream: { reviewTaskId: "task-4375-next", xRenderer: RENDERER, fieldName: null },
      row: ANSWERED,
    },
    {
      name: "the same review task with a different renderer on the row",
      stream: ANSWERED,
      row: { reviewTaskId: TASK, xRenderer: "cinatra.schema-field:other-output", fieldName: null },
    },
    {
      name: "the same review task and renderer with a different field on the row",
      stream: ANSWERED,
      row: { reviewTaskId: TASK, xRenderer: RENDERER, fieldName: "destination" },
    },
  ];
  for (const c of cases) {
    it(`site_widget: with the answered question on file and ${c.name}, no placeholder covers it`, async () => {
      streamState.interruptContext = interrupt(c.stream);
      rowAnswer = rowWith(c.row);
      mountConversation("site_widget", c.row);
      const button = await blockedOnTheQuestion();
      // The panel has read the row's own question before the Continue lands.
      await rowReads(1);
      const { after } = await pressSiblingContinue(button);
      expect(requests.some((u) => u.endsWith("/hitl-screen/submit"))).toBe(true);
      expectStillBlocked(after);
    }, 60_000);
  }
});

describe("AC 4: the chat host, with the same sibling-Continue setup", () => {
  it("chat_thread: PARITY - after the sibling's Continue lands, the first reading is the working slot with its placeholder", async () => {
    mountConversation("chat_thread");
    const button = await blockedOnTheQuestion();
    const { before, after } = await pressSiblingContinue(button);
    expect(approveReviewTask).toHaveBeenCalledTimes(1);
    expect(requests.some((u) => u.endsWith("/hitl-screen/submit"))).toBe(false);
    expectWorkingFromTheFirstReading(before, after);
  }, 60_000);
});

describe("the conversation's answered-question register", () => {
  it("records only a run and a question with a review task and a renderer, keyed on task, renderer and field", () => {
    const register = createAnsweredHitlQuestionRegister();
    const heard = vi.fn();
    register.subscribe(heard);
    register.announceAnswered("", ANSWERED);
    register.announceAnswered(RUN_ID, { reviewTaskId: "", xRenderer: RENDERER, fieldName: null });
    register.announceAnswered(RUN_ID, { reviewTaskId: TASK, xRenderer: "", fieldName: null });
    expect(register.answeredOn(RUN_ID)).toBeNull();
    expect(heard).not.toHaveBeenCalled();
    register.announceAnswered(RUN_ID, ANSWERED);
    expect(register.answeredOn(RUN_ID)).toBe(answeredHitlQuestionKey(ANSWERED));
    expect(register.answeredOn("run-other")).toBeNull();
    expect(answeredHitlQuestionKey({ reviewTaskId: TASK, xRenderer: RENDERER })).toBe(
      answeredHitlQuestionKey(ANSWERED),
    );
    expect(answeredHitlQuestionKey({ ...ANSWERED, xRenderer: "other" })).not.toBe(answeredHitlQuestionKey(ANSWERED));
    expect(answeredHitlQuestionKey({ ...ANSWERED, fieldName: "f" })).not.toBe(answeredHitlQuestionKey(ANSWERED));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("a nested host declaration shares the enclosing conversation's register", () => {
    const seen: Array<AnsweredHitlQuestionRegister | null> = [];
    function Probe() {
      seen.push(useAnsweredHitlQuestionRegister());
      return null;
    }
    render(
      <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAME}>
        <Probe />
        <LifecycleCardSurfaceProvider host="run_card">
          <Probe />
        </LifecycleCardSurfaceProvider>
      </LifecycleCardSurfaceProvider>,
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).not.toBeNull();
    expect(seen.every((r) => r === seen[0])).toBe(true);
  });

  it("run_card: the run page keeps its own submit as the one source; an announcement there releases nothing", async () => {
    let register: AnsweredHitlQuestionRegister | null = null;
    function Grab() {
      register = useAnsweredHitlQuestionRegister();
      return null;
    }
    const host: LifecycleCardHost = "run_card";
    render(
      <LifecycleCardSurfaceProvider host={host}>
        <Grab />
        {panel()}
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(
      () => {
        if (readReviewSlot.mock.calls.length < 1) throw new Error("the slot reader has not been asked");
        if (document.querySelector(PLACEHOLDER)) throw new Error("the unheard window still holds");
      },
      { timeout: 20_000 },
    );
    await act(async () => {
      register!.announceAnswered(RUN_ID, ANSWERED);
      await flush();
    });
    const readings: Reading[] = [];
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      readings.push(readColumn());
    }
    expect(
      readings.filter((r) => r.placeholder).length,
      `the run page drew the placeholder from an announcement it does not own (${told(readings)})`,
    ).toBe(0);
  }, 60_000);
});
