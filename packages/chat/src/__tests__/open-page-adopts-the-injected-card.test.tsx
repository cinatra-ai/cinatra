// @vitest-environment jsdom
/**
 * A PAGE THAT STAYED OPEN ACROSS THE RUN RECEIVES THE RUN'S CARDS (cinatra#3051,
 * the ninth proof round's live-update finding).
 *
 * THE MEASUREMENT THIS FILE STANDS ON. With the run `completed` and its review
 * gate `pending`, two third-party pages that had been open since before the
 * dispatch drew NO review slot, NO placeholder and NO review card for ten
 * minutes (243 samples), while a page loaded afterwards drew the card from the
 * persisted turn in about 36 seconds. The same round measured the same silence
 * one moment earlier: at the run's schedule moment the widget drew zero schedule
 * cards, so the release had to be taken on the application's own surface.
 *
 * WHY BOTH ARE ONE DEFECT. The server does not deliver a lifecycle card as a new
 * message. `src/lib/lifecycle/lifecycle-run-outbox.ts` writes the card INTO the
 * turn that dispatched the run — the turn the open page has already rendered —
 * and `assembleThreadPayloadFromParts` hands that turn back under the id the
 * page already knows ("a turn the spine ALREADY CARRIES is repaired, never
 * duplicated"). `adoptServerMessages` only ever appended whole NEW messages, so
 * a repair to a message it already had was invisible to it for as long as the
 * page stayed open. A reload read the same turn and drew the card, which is
 * exactly the asymmetry the round measured.
 *
 * So the seam takes the repair too — additively, and under the same rules that
 * govern an addition.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let releaseTurn: (() => void) | null = null;
const driveAssistantChatTurn = vi.fn(
  async () =>
    new Promise<void>((resolve) => {
      releaseTurn = () => resolve();
    }),
);

vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    driveAssistantChatTurn: (...a: unknown[]) => driveAssistantChatTurn(...(a as [])),
  };
});

import { useConversationColumnTurns } from "../conversation-column";
import type { UiMessage } from "../types";

const REVIEW_CARD = {
  viewType: "artifact_review_gate",
  schemaVersion: 1,
  ref: "ref-gate-db53edd5",
} as const;

const SCHEDULE_CARD = {
  viewType: "schedule_proposal",
  schemaVersion: 1,
  ref: "ref-schedule-1",
} as const;

/** The dispatch turn as the OPEN page rendered it: the tool call that started
 *  the run, and no card of any kind yet. */
const dispatchTurn = (): UiMessage =>
  ({
    id: "a1",
    role: "assistant",
    content: "Starting the agent for you.",
    parts: [
      { kind: "text", content: "Starting the agent for you." },
      { kind: "tool_call", id: "call-1", name: "agent_run", status: "completed" },
    ],
  }) as unknown as UiMessage;

/** The SAME turn as the server hands it back once the outbox has written the
 *  gate into it — same id, same content, one view folded onto the producing
 *  step and the run pinned on it. */
const dispatchTurnWithCard = (card: Record<string, unknown> = REVIEW_CARD): UiMessage =>
  ({
    id: "a1",
    role: "assistant",
    content: "Starting the agent for you.",
    parts: [
      { kind: "text", content: "Starting the agent for you." },
      {
        kind: "tool_call",
        id: "call-1",
        name: "agent_run",
        status: "completed",
        runId: "724a04f3-71c4-458c-ae7d-c64844152f9f",
        views: [card],
      },
    ],
  }) as unknown as UiMessage;

const SEEDED: UiMessage[] = [
  { id: "u1", role: "user", content: "Please start the agent." } as UiMessage,
  dispatchTurn(),
];

function mountTurns(initialMessages: UiMessage[] = SEEDED) {
  return renderHook(() =>
    useConversationColumnTurns({ threadId: "t-3051-open", initialMessages }),
  );
}

function slottedViews(message: UiMessage | undefined): unknown[] {
  const parts = (message as { parts?: Array<Record<string, unknown>> } | undefined)?.parts ?? [];
  const call = parts.find((p) => p.kind === "tool_call" && p.id === "call-1");
  return Array.isArray(call?.views) ? (call!.views as unknown[]) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseTurn = null;
});

describe("the open page and the card written into a turn it already has", () => {
  it("takes the review card the server folded onto the dispatch turn", () => {
    const { result } = mountTurns();
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    expect(took, "the repair is a reading the column took").toBe(1);
    expect(slottedViews(result.current.messages[1])).toEqual([REVIEW_CARD]);
  });

  it("pins the run the server named on the producing call", () => {
    const { result } = mountTurns();
    act(() => {
      result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    const parts = (result.current.messages[1] as { parts?: Array<Record<string, unknown>> }).parts!;
    const call = parts.find((p) => p.id === "call-1")!;
    expect(call.runId).toBe("724a04f3-71c4-458c-ae7d-c64844152f9f");
  });

  it("takes a turn-level card the server folded in with no producing step", () => {
    const { result } = mountTurns();
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([
        SEEDED[0]!,
        { ...dispatchTurn(), dataParts: [SCHEDULE_CARD] } as unknown as UiMessage,
      ]);
    });
    expect(took).toBe(1);
    expect(
      (result.current.messages[1] as { dataParts?: unknown[] }).dataParts,
    ).toEqual([SCHEDULE_CARD]);
  });

  it("adds each card once, however many times the look repeats", () => {
    const { result } = mountTurns();
    act(() => {
      result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    let second = 0;
    act(() => {
      second = result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    expect(second, "a second identical look adds nothing").toBe(0);
    expect(slottedViews(result.current.messages[1])).toHaveLength(1);
  });

  it("adds no second copy of a card the turn carries on its Slack slots", () => {
    // THE SECOND CARRIAGE (cinatra#2825). A pinned layout that omits the
    // ordered `parts` still carries the lifecycle SLOTS on `lifecycleParts`,
    // and the view reads `parts ?? lifecycleParts`. So a card already sitting
    // THERE is already on screen: the repair must read that carriage too, or
    // the next server reading of the same turn folds a second copy in at turn
    // level and the reader sees the one card twice.
    const carriedOnSlackSlots = {
      id: "a1",
      role: "assistant",
      content: "Starting the agent for you.",
      lifecycleParts: [
        { kind: "tool_call", id: "call-1", name: "agent_run", views: [REVIEW_CARD] },
      ],
    } as unknown as UiMessage;
    const { result } = mountTurns([SEEDED[0]!, carriedOnSlackSlots]);
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    expect(took, "the card is already carried — nothing is owed").toBe(0);
    expect(
      (result.current.messages[1] as { dataParts?: unknown[] }).dataParts ?? [],
      "no turn-level duplicate of a card the Slack slots already carry",
    ).toEqual([]);
  });

  it("never rewrites what is on screen — only the card is added", () => {
    const { result } = mountTurns();
    act(() => {
      result.current.adoptServerMessages([
        SEEDED[0]!,
        {
          ...dispatchTurnWithCard(),
          content: "A DIFFERENT SENTENCE THE SERVER HOLDS",
        } as unknown as UiMessage,
      ]);
    });
    expect(
      result.current.messages[1]!.content,
      "the reader's own copy of the turn is untouched",
    ).toBe("Starting the agent for you.");
    expect(slottedViews(result.current.messages[1])).toEqual([REVIEW_CARD]);
  });

  it("takes nothing while a turn taken in this browser is live", async () => {
    const { result } = mountTurns();
    await act(async () => {
      void result.current.onSubmit("hello");
    });
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([SEEDED[0]!, dispatchTurnWithCard()]);
    });
    expect(took, "a live turn owns the list").toBe(0);
    await act(async () => {
      releaseTurn?.();
    });
  });

  it("keeps the identity of the list when the reading carries nothing new", () => {
    const { result } = mountTurns();
    const before = result.current.messages;
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([SEEDED[0]!, dispatchTurn()]);
    });
    expect(took).toBe(0);
    expect(result.current.messages).toBe(before);
  });
});
