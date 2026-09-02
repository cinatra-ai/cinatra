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
import { act, cleanup, configure, fireEvent, waitFor } from "@testing-library/react";

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

const hitlReading = { current: { state: "none" } as Record<string, unknown> };
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: async () => hitlReading.current,
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
import { mountSurface } from "./conversation-column-harness";

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
        <input
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
