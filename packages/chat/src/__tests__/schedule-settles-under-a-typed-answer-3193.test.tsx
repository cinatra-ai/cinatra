// @vitest-environment jsdom
/**
 * THE SCHEDULE SETTLES UNDER A HALF-TYPED ANSWER (cinatra#3193).
 *
 * The turn that carries a settled schedule card draws the agent's own next
 * screen in a marked place of its own rather than beside the card
 * (cinatra#3174, criterion 2). The two placements have different parents, so
 * the shape flipping is not one component moving: React reconciles them as
 * different trees, unmounts the instance that was on screen and mounts another
 * in its place.
 *
 * AND THE FLIP CAN HAPPEN LONG AFTER THE SCREEN WAS DRAWN. Which shape the turn
 * is in is answered by a resolve, so on a reload the screen is drawn FIRST and
 * the settlement moves it afterwards. A person who was already typing into the
 * screen when that happened lost every word of it, and the screen went blank
 * for as long as the new instance took to re-read its own authority. That is
 * what this file measures: the schedule settles AFTER the screen has drawn with
 * an answer half-typed into it, and the answer is still there and still
 * submittable when it lands in its new place.
 *
 * NOTHING IS STUBBED THAT WOULD HIDE IT. The screen is the REAL card, reading
 * the real state through the shipped action, drawing a real registered field
 * renderer with a real input, and answering through the real Continue - so what
 * the assertions read is the buffer the person's keystrokes actually filled.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-settles-under-a-typed-answer-3193.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer this column mounts reads `window.localStorage` on mount. jsdom
// under Node 25 exposes the property without its methods, which throws before
// any assertion here runs. Installed ONLY when the environment is missing it.
if (
  typeof globalThis.window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RUN_ID = "5a1d8c22-9b47-4f10-8e63-1c0a7d4b2e95";
const CARD_REF = "sched-ref-3193";
const GATE_RENDERER = "cinatra.schema-field:output";
/** What the person types and never sends before the schedule settles. */
const HALF_TYPED = "the second half of the quarterly write-up";

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));

const hitlReading = { current: { state: "none" } as Record<string, unknown>, pending: null as Promise<Record<string, unknown>> | null, forRun: null as ((runId: string) => Record<string, unknown>) | null };
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async (runId: string) => hitlReading.forRun?.(runId) ?? hitlReading.pending ?? hitlReading.current,
}));

const approveMock = vi.fn(async () => undefined);
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) =>
    approveMock(...(args as Parameters<typeof approveMock>)),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The run panel draws nothing here: what this file measures is the screen and
// the card, and the panel's own lines are counted by the criterion-1 suite.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => <div data-inline-run-card={runId} />,
}));

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { fieldRendererRegistry } from "../../../agents/src/field-renderer-registry";
import { RUN_SEED_ROUTE } from "../run-seed-request";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { chatSurfaceElement, mountSurface } from "./conversation-column-harness";
import { Input } from "@/components/ui/input";

/**
 * A REAL FIELD, so the buffer under test is filled by keystrokes rather than by
 * this file. A mid-run gate (`:output`) buffers into the card's own Continue,
 * which is the shape a person answering an agent mid-run is in.
 */
function registerTypedAnswerRenderer(): void {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:typed-answer",
    priority: 90,
    condition: (_field, _schema, ctx) => ctx.xRenderer === GATE_RENDERER,
    credentialSafe: true,
    renderer: ({ value, onChange }) => {
      const held =
        value !== null && typeof value === "object"
          ? ((value as { answer?: unknown }).answer ?? "")
          : (value ?? "");
      return (
        <Input
          data-testid="typed-answer"
          value={typeof held === "string" ? held : ""}
          onChange={(event) => onChange({ answer: event.currentTarget.value })}
        />
      );
    },
  });
}

const GATE = {
  reviewTaskId: "review-3193",
  xRenderer: GATE_RENDERER,
  inputSchema: {
    type: "object",
    properties: { answer: { type: "string", title: "Answer" } },
  },
  currentValues: {},
  fieldName: undefined,
};

const HITL_SCREEN = {
  state: "asking",
  runId: RUN_ID,
  screenRef: "hitl-3193",
  gate: GATE,
};

/** The run while its schedule is still the moment it stands at. */
const RUN_AT_SCHEDULE = {
  status: "armed",
  error: null,
  messages: [],
  lifecycleMoment: "schedule",
  lifecycleCard: { kind: "trigger_schedule_proposal", ref: CARD_REF },
};

/** The run once the schedule has fired and it has moved on. */
const RUN_PAST_SCHEDULE = {
  status: "running",
  error: null,
  messages: [],
  lifecycleMoment: null,
  lifecycleCard: null,
};

const PENDING_ENVELOPE = {
  kind: "trigger_schedule_proposal",
  state: { state: "pending", canDecide: true, canComment: false },
  body: {
    phase: "proposal",
    version: 1,
    agentName: "Quarterly write-up",
    schedule: { kind: "immediate" },
    durationCopy: null,
    canConfirm: true,
    restrictedReason: null,
  },
};

const SETTLED_ENVELOPE = {
  kind: "trigger_schedule_proposal",
  state: { state: "settled" },
  body: {
    phase: "settled",
    version: 1,
    agentName: "Quarterly write-up",
    runId: RUN_ID,
    schedule: { kind: "immediate" },
    triggerType: "immediate",
    scheduleCopy: "Runs right after setup",
    timezone: "UTC",
    gatedSteps: [],
    released: true,
    arming: false,
    canSave: false,
    canCancel: false,
  },
};

const runReading = { current: RUN_AT_SCHEDULE as Record<string, unknown> };
const cardReading = { current: PENDING_ENVELOPE as Record<string, unknown> };

let restoreFetch: typeof globalThis.fetch;

beforeEach(() => {
  registerTypedAnswerRenderer();
  approveMock.mockClear();
  hitlReading.current = HITL_SCREEN;
  hitlReading.pending = null;
  hitlReading.forRun = null;
  runReading.current = RUN_AT_SCHEDULE;
  cardReading.current = PENDING_ENVELOPE;
  restoreFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.startsWith(`${RUN_SEED_ROUTE}/`)) return json(runReading.current);
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) return json(cardReading.current);
    return json({}, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  globalThis.fetch = restoreFetch;
});

/** The reloaded turn: the `agent_run` part with the schedule view the step
 *  produced, which is the carriage a person meets after a reload. */
function scheduleTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Write the quarterly summary right after setup." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "t1",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          views: [
            {
              viewType: "trigger_schedule_proposal",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: CARD_REF,
            },
          ],
        },
      ],
    } as unknown as UiMessage,
  ];
}

const SCREEN = '[data-lifecycle-card="agent_hitl_screen"]';
const CONTINUE = '[data-action="submit-hitl-screen"]';
const turnContainer = (root: HTMLElement) =>
  root.querySelector(`[data-agent-run-slot="${RUN_ID}"]`);

describe("the schedule settles after the screen was drawn (cinatra#3193)", () => {
  it(
    "keeps what the person typed, and keeps it submittable, across the relocation",
    async () => {
      const { container } = await mountSurface("chat", { messages: scheduleTurn() });

      // 1. THE SCREEN IS DRAWN FIRST, in the turn's own container — the shape a
      //    turn whose schedule has not settled is in.
      const field = await waitFor(() => {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="typed-answer"]',
        );
        if (input === null) throw new Error("the screen's field never drew");
        return input;
      });
      expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)).toBeNull();
      expect(turnContainer(container)?.contains(field)).toBe(true);

      // 2. THE PERSON TYPES, and does not send.
      await act(async () => {
        fireEvent.change(field, { target: { value: HALF_TYPED } });
      });
      await waitFor(() => {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="typed-answer"]',
        );
        if (input?.value !== HALF_TYPED) throw new Error("the field never took the text");
      });
      expect(approveMock).not.toHaveBeenCalled();

      // 3. THE SCHEDULE SETTLES UNDERNEATH THEM. The run moves past its moment
      //    and the card resolves to its settled reading — the two answers the
      //    turn's shape is elected from — and the card re-resolves on the same
      //    focus signal a person sends by coming back to the tab.
      runReading.current = RUN_PAST_SCHEDULE;
      cardReading.current = SETTLED_ENVELOPE;
      const slot = await waitFor(
        () => {
          window.dispatchEvent(new Event("focus"));
          const moved = container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`);
          if (moved === null) throw new Error("the turn never elected the settled shape");
          return moved;
        },
        { timeout: 20_000 },
      );

      // 4. THE PLACEMENT REALLY CHANGED — this is the relocation, not a frame
      //    before it.
      const moved = container.querySelector<HTMLInputElement>('[data-testid="typed-answer"]');
      expect(moved).not.toBeNull();
      expect(slot.contains(moved!)).toBe(true);
      expect(turnContainer(container)?.contains(moved!)).toBe(false);

      // 5. AND THE WORDS SURVIVED IT.
      expect(moved!.value).toBe(HALF_TYPED);

      // 6. STILL SUBMITTABLE, through the card's own Continue, carrying exactly
      //    what was typed before the schedule settled.
      const continueControl = container.querySelector<HTMLButtonElement>(CONTINUE);
      expect(continueControl).not.toBeNull();
      await act(async () => {
        fireEvent.click(continueControl!);
      });
      await waitFor(() => {
        if (approveMock.mock.calls.length === 0) throw new Error("Continue submitted nothing");
      });
      const [, payload] = approveMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(payload.answer).toBe(HALF_TYPED);
    },
    45_000,
  );

  it(
    "does not blank the screen while it moves",
    async () => {
      const { container } = await mountSurface("chat", { messages: scheduleTurn() });
      await waitFor(() => {
        if (container.querySelector(SCREEN) === null) throw new Error("the screen never drew");
      });

      // EVERY FRAME THE WAIT PASSES THROUGH IS READ, not only the one the new
      // placement first exists on. A card that had to re-read its own authority
      // before it could draw again leaves the turn with no screen at all for as
      // long as that read is in flight, and the wait below runs straight through
      // those frames — so the low-water mark is what discriminates, and a single
      // reading taken after the wait settled would not.
      const screensSeen: number[] = [];
      runReading.current = RUN_PAST_SCHEDULE;
      cardReading.current = SETTLED_ENVELOPE;
      await waitFor(
        () => {
          window.dispatchEvent(new Event("focus"));
          screensSeen.push(container.querySelectorAll(SCREEN).length);
          if (container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`) === null) {
            throw new Error("the turn never elected the settled shape");
          }
        },
        { timeout: 20_000 },
      );
      expect(container.querySelectorAll(SCREEN).length).toBe(1);
      expect(screensSeen.length).toBeGreaterThan(0);
      expect(Math.min(...screensSeen)).toBe(1);
    },
    45_000,
  );
});


/** Durable views with no producing-step stamp remain turn-level after reload. */
function reloadedUnpositionedScheduleTurn(): UiMessage[] {
  const messages = scheduleTurn();
  const assistant = messages[1]!;
  const positioned = assistant.parts![0]!;
  return [messages[0]!, { ...assistant, parts: [{ ...positioned, views: [] }],
    dataParts: [{ viewType: "trigger_schedule_proposal", schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: CARD_REF }],
  } as UiMessage];
}

describe("reloaded settled schedule and a late next screen (cinatra#3984)", () => {
  it.each([false, true])("keeps the actual late screen after the durable schedule (Slack=%s)", async (slackMode) => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    let resolveScreen!: (reading: Record<string, unknown>) => void;
    hitlReading.pending = new Promise((resolve) => { resolveScreen = resolve; });
    const { container } = await mountSurface("chat", { messages: reloadedUnpositionedScheduleTurn(), slackMode });
    await waitFor(() => expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull());
    expect(container.querySelector(SCREEN)).toBeNull();
    await act(async () => { resolveScreen(HITL_SCREEN); });
    await waitFor(() => expect(container.querySelector(SCREEN)).not.toBeNull());
    const schedule = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')!;
    const screen = container.querySelector(SCREEN)!;
    expect(schedule.compareDocumentPosition(screen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(turnContainer(container)?.contains(screen)).toBe(false);
    expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)?.contains(screen)).toBe(true);
    expect(container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]')).toHaveLength(1);
    expect(container.querySelectorAll(SCREEN)).toHaveLength(1);
  });
});


describe("settled durable schedule ownership (cinatra#3984)", () => {
  it("does not associate the schedule with a different run in the same turn", async () => {
    const otherRunId = "39840000-1111-4222-8333-444444444444";
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    hitlReading.current = { ...HITL_SCREEN, runId: otherRunId, gate: { ...GATE, runId: otherRunId } };
    const messages = reloadedUnpositionedScheduleTurn();
    messages[1] = { ...messages[1]!, parts: [{ ...messages[1]!.parts![0]!, runId: otherRunId }] } as UiMessage;
    const { container } = await mountSurface("chat", { messages });
    await waitFor(() => {
      expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull();
      expect(container.querySelector(SCREEN)).not.toBeNull();
    });
    expect(container.querySelector(`[data-agent-run-slot="${otherRunId}"]`)?.contains(container.querySelector(SCREEN))).toBe(true);
    expect(container.querySelector(`[data-agent-run-screen-slot="${otherRunId}"]`)).toBeNull();
  });

  it("does not move a next screen in another assistant turn with the same run ID", async () => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    const original = reloadedUnpositionedScheduleTurn();
    const scheduleMessage = { ...original[1]!, parts: [] };
    const nextMessage = { ...original[1]!, id: "a2", dataParts: [], parts: [{ ...original[1]!.parts![0]!, views: [] }] };
    const { container } = await mountSurface("chat", { messages: [original[0]!, scheduleMessage, nextMessage] as UiMessage[] });
    await waitFor(() => {
      expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull();
      expect(container.querySelector(SCREEN)).not.toBeNull();
    });
    expect(turnContainer(container)?.contains(container.querySelector(SCREEN))).toBe(true);
    expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)).toBeNull();
  });

  it("gives the screen its ordinary slot back when the schedule is withdrawn", async () => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    const { container } = await mountSurface("chat", { messages: reloadedUnpositionedScheduleTurn() });
    await waitFor(() => expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)?.contains(container.querySelector(SCREEN))).toBe(true));
    cardReading.current = { ...SETTLED_ENVELOPE, state: { state: "absent" }, body: null } as unknown as typeof SETTLED_ENVELOPE;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => {
      expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).toBeNull();
      expect(turnContainer(container)?.contains(container.querySelector(SCREEN))).toBe(true);
      expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)).toBeNull();
    });
  });
});


it("keeps a typed answer and its actual Continue when the durable schedule settles later (cinatra#3984)", async () => {
  runReading.current = RUN_PAST_SCHEDULE;
  const { container } = await mountSurface("chat", { messages: reloadedUnpositionedScheduleTurn() });
  const field = await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>('[data-testid="typed-answer"]');
    if (!input) throw new Error("the real next screen has not resolved");
    return input;
  });
  expect(container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]')).toHaveLength(1);
  await act(async () => { fireEvent.change(field, { target: { value: HALF_TYPED } }); });
  runReading.current = RUN_PAST_SCHEDULE;
  cardReading.current = SETTLED_ENVELOPE;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => {
    const slot = container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`);
    const moved = container.querySelector<HTMLInputElement>('[data-testid="typed-answer"]');
    expect(slot?.contains(moved)).toBe(true);
    expect(moved?.value).toBe(HALF_TYPED);
  });
  await act(async () => { fireEvent.click(container.querySelector(CONTINUE)!); });
  await waitFor(() => expect(approveMock).toHaveBeenCalled());
  expect((approveMock.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].answer).toBe(HALF_TYPED);
});

it("moves only the matching screen when two real run slots share the turn (cinatra#3984)", async () => {
  const otherRunId = "39840000-1111-4222-8333-444444444444";
  runReading.current = RUN_PAST_SCHEDULE;
  cardReading.current = SETTLED_ENVELOPE;
  hitlReading.forRun = (runId) => ({ ...HITL_SCREEN, runId, gate: { ...GATE, runId, reviewTaskId: `review-${runId}` } });
  const messages = reloadedUnpositionedScheduleTurn();
  const first = messages[1]!.parts![0]!;
  messages[1] = { ...messages[1]!, parts: [first, { ...first, id: "t2", runId: otherRunId }] } as UiMessage;
  const { container } = await mountSurface("chat", { messages });
  await waitFor(() => expect(container.querySelectorAll(SCREEN)).toHaveLength(2));
  const matchingSlot = await waitFor(() => {
    const slot = container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`);
    expect(slot).not.toBeNull();
    expect(slot!.querySelector(SCREEN)).not.toBeNull();
    return slot!;
  });
  const otherSlot = container.querySelector(`[data-agent-run-slot="${otherRunId}"]`);
  expect(otherSlot).not.toBeNull();
  expect(otherSlot!.querySelector(SCREEN)).not.toBeNull();
  expect(container.querySelector(`[data-agent-run-screen-slot="${otherRunId}"]`)).toBeNull();
  const schedule = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
  expect(schedule).not.toBeNull();
  expect(schedule!.compareDocumentPosition(matchingSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});


/** Live turns carry the schedule at the run's producing slot; durable reloads
 * can carry the same admitted schedule in the turn-level data-part list. The
 * prose is intentionally nonempty: without it the response-action row never
 * mounts, which hid the reload ordering defect from the original controls. */
function proseScheduleTurn(reloaded: boolean): UiMessage[] {
  const messages = reloaded ? reloadedUnpositionedScheduleTurn() : scheduleTurn();
  const assistant = messages[1]!;
  messages[1] = {
    ...assistant,
    content: "The scheduled run has moved on to its next question.",
    lifecycleParts: assistant.parts,
    parts: undefined,
  } as UiMessage;
  return messages;
}

function expectScheduleScreenActionsInOrder(container: HTMLElement): void {
  const schedule = container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
  const screen = container.querySelector(SCREEN);
  const copy = container.querySelector('[title="Copy response"]');
  expect(schedule).not.toBeNull();
  expect(screen).not.toBeNull();
  expect(copy).not.toBeNull();
  expect(schedule!.compareDocumentPosition(screen!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen!.compareDocumentPosition(copy!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(turnContainer(container)?.contains(screen)).toBe(false);
  expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)?.contains(screen)).toBe(true);
  expect(container.querySelectorAll('[data-lifecycle-card="trigger_schedule_proposal"]')).toHaveLength(1);
  expect(container.querySelectorAll(SCREEN)).toHaveLength(1);
  expect(container.querySelectorAll('[title="Copy response"]')).toHaveLength(1);
}

// App round C6 uses two assistant mentions, selecting multi-participant mode
// (chat-routing.ts:33-39). Its AG-UI flat projection keeps lifecycleParts and
// dataParts without parts (ag-ui-chat-client.ts:494-541). This is that same
// shared-column prop/data shape; no external Slack connector is involved.
async function mountProseTurn(reloaded: boolean, theme: "github-light" | "github-dark", streaming = false) {
  const surface = chatSurfaceElement({ messages: proseScheduleTurn(reloaded), slackMode: true, streamingIds: streaming ? ["a1"] : [] });
  const column = (surface.props as { children: React.ReactElement<{ theme: "github-light" | "github-dark" }> }).children;
  const result = render(React.cloneElement(surface, {}, React.cloneElement(column, { theme })));
  await waitFor(() => expect(result.container.querySelector("[data-conversation-list]")).not.toBeNull());
  return result;
}

describe("response actions follow the schedule's next screen on live and reload roads (cinatra#3984)", () => {
  it.each(["github-light", "github-dark"] as const)("keeps the same real card/action order in both turn shapes (%s)", async (theme) => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    for (const reloaded of [false, true]) {
      const result = await mountProseTurn(reloaded, theme);
      await waitFor(() => { expect(result.container.querySelector(SCREEN)).not.toBeNull(); expect(result.container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull(); });
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expectScheduleScreenActionsInOrder(result.container);
      const field = result.container.querySelector<HTMLInputElement>('[data-testid="typed-answer"]')!;
      await act(async () => { fireEvent.change(field, { target: { value: HALF_TYPED } }); });
      await act(async () => { fireEvent.click(result.container.querySelector(CONTINUE)!); });
      await waitFor(() => expect(approveMock).toHaveBeenCalled());
      expect((approveMock.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1].answer).toBe(HALF_TYPED);
      result.unmount();
      approveMock.mockClear();
    }
  });

  it.each(["github-light", "github-dark"] as const)("places an actually late reloaded screen before existing actions (%s)", async (theme) => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    let resolveScreen!: (reading: Record<string, unknown>) => void;
    hitlReading.pending = new Promise((resolve) => { resolveScreen = resolve; });
    const { container } = await mountProseTurn(true, theme);
    await waitFor(() => expect(container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]')).not.toBeNull());
    expect(container.querySelector(SCREEN)).toBeNull();
    expect(container.querySelectorAll('[title="Copy response"]')).toHaveLength(1);
    await act(async () => { resolveScreen(HITL_SCREEN); });
    await waitFor(() => expect(container.querySelector(SCREEN)).not.toBeNull());
    expectScheduleScreenActionsInOrder(container);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(container.querySelector(SCREEN)).not.toBeNull());
    expectScheduleScreenActionsInOrder(container);
  });
});


it("keeps response actions absent while this scheduled turn is streaming (cinatra#3984)", async () => {
  runReading.current = RUN_PAST_SCHEDULE;
  cardReading.current = SETTLED_ENVELOPE;
  const { container } = await mountProseTurn(true, "github-light", true);
  await waitFor(() => expect(container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`)?.querySelector(SCREEN)).not.toBeNull());
  expect(container.querySelectorAll(SCREEN)).toHaveLength(1);
  expect(container.querySelector('[title="Copy response"]')).toBeNull();
});

describe("live and durable schedule cards share a non-collapsing screen stack (cinatra#3984)", () => {
  it.each(["github-light", "github-dark"] as const)("preserves the live card stack when the screen reloads (%s)", async (theme) => {
    runReading.current = RUN_PAST_SCHEDULE;
    cardReading.current = SETTLED_ENVELOPE;
    for (const reloaded of [false, true]) {
      const result = await mountProseTurn(reloaded, theme);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      await waitFor(() => {
        const schedule = result.container.querySelector('[data-lifecycle-card="trigger_schedule_proposal"]');
        const screen = result.container.querySelector(SCREEN);
        expect(schedule).not.toBeNull();
        expect(screen).not.toBeNull();
        let stack = schedule!.parentElement;
        while (stack && !stack.contains(screen!)) stack = stack.parentElement;
        // Both real cards retain their own vertical margins. The live column
        // keeps them from collapsing and contributes its ordinary inter-slot
        // gap; a reload must preserve that same composition, including a late
        // screen, rather than compensate by changing either card's frame.
        expect(stack?.classList.contains("flex")).toBe(true);
        expect(stack?.classList.contains("flex-col")).toBe(true);
        expect(stack?.classList.contains("gap-2")).toBe(true);
        expectScheduleScreenActionsInOrder(result.container);
      }, { timeout: 3_000 });
      result.unmount();
    }
  });
});
