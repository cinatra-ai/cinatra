// @vitest-environment jsdom
/**
 * A MOUNTED COLUMN LEARNS ABOUT WHAT HAPPENED AFTER IT OPENED (cinatra#3051).
 *
 * The column's list was seeded ONCE, at mount, and nothing but a turn taken in
 * this browser could ever add to it. On a third-party page that is the whole
 * defect: a panel opened at ten past cannot learn that a run was released at
 * twenty past, because the only reading it ever took was the one it took before
 * the run existed.
 *
 * `adoptServerMessages` is the one seam by which a later server reading may
 * enter a mounted column. It is deliberately the weakest thing that closes the
 * gap, and each of its rules is a different way of losing somebody's work if it
 * is left out — so each of them is an arm below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/** A turn that never finishes, so "while a turn is live" is a real state and not
 *  a simulated flag. */
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

const msg = (id: string, role: "user" | "assistant"): UiMessage =>
  ({ id, role, content: id }) as UiMessage;

/** What the column was seeded with when the panel opened. */
const SEEDED: UiMessage[] = [msg("u1", "user"), msg("a1", "assistant")];

function mountTurns(initialMessages: UiMessage[] = SEEDED) {
  return renderHook(() =>
    useConversationColumnTurns({ threadId: "t-3051", initialMessages }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseTurn = null;
});

describe("adoptServerMessages", () => {
  it("takes the turn that was released AFTER the column opened", () => {
    const { result } = mountTurns();
    let took = 0;
    act(() => {
      took = result.current.adoptServerMessages([...SEEDED, msg("a2", "assistant")]);
    });
    expect(took).toBe(1);
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
  });

  it("ONLY ADDS — it never replaces what is on screen", () => {
    const { result } = mountTurns();
    // The server's picture of `a1` differs (an older revision, a different
    // reduction). The reader is looking at theirs; a wholesale swap for a
    // snapshot taken somewhere else is how an unsaved edit disappears.
    act(() => {
      result.current.adoptServerMessages([
        msg("u1", "user"),
        { ...msg("a1", "assistant"), content: "a different reading of a1" },
        msg("a2", "assistant"),
      ]);
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(["u1", "a1", "a2"]);
  });

  it("keeps the SAME list object when it learned nothing, so no render follows", () => {
    const { result } = mountTurns();
    const before = result.current.messages;
    let took = -1;
    act(() => {
      took = result.current.adoptServerMessages(SEEDED);
    });
    expect(took).toBe(0);
    expect(result.current.messages).toBe(before);
  });

  it("adopts NOTHING while a turn is live, and takes the same news on the next look", async () => {
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("start a run");
    });
    expect(result.current.streamingCount).toBe(1);

    const during = result.current.messages;
    let tookDuring = -1;
    act(() => {
      tookDuring = result.current.adoptServerMessages([...SEEDED, msg("a2", "assistant")]);
    });
    // A reading taken mid-stream is a picture of a conversation that is still
    // moving; the turn owns the list until it settles.
    expect(tookDuring).toBe(0);
    expect(result.current.messages).toBe(during);

    await act(async () => {
      releaseTurn?.();
      await Promise.resolve();
    });
    let tookAfter = -1;
    act(() => {
      tookAfter = result.current.adoptServerMessages([...SEEDED, msg("a2", "assistant")]);
    });
    expect(tookAfter).toBe(1);
    expect(result.current.messages.map((m) => m.id)).toContain("a2");
  });

  it("never folds back a turn an OPEN EDIT removed", () => {
    const { result } = mountTurns([...SEEDED, msg("u2", "user"), msg("a2", "assistant")]);
    act(() => {
      result.current.onEditAndResend("u2", "actually, never mind");
    });
    // `a2` is removed and the assertion is standing — no save has carried it
    // yet, so the SERVER still has that turn.
    expect(result.current.peekRemovedMessageIds().ids).toContain("a2");

    let took = -1;
    act(() => {
      took = result.current.adoptServerMessages([
        ...SEEDED,
        msg("u2", "user"),
        msg("a2", "assistant"),
      ]);
    });
    // Adopting it would put the reader's edit straight back — the permanent undo
    // the truncation intent exists to prevent, reached from a new direction.
    expect(took).toBe(0);
    expect(result.current.messages.map((m) => m.id)).not.toContain("a2");
  });

  it("takes nothing at all from an empty or absent answer", () => {
    const { result } = mountTurns();
    act(() => {
      expect(result.current.adoptServerMessages([])).toBe(0);
      expect(result.current.adoptServerMessages(null)).toBe(0);
      expect(result.current.adoptServerMessages(undefined)).toBe(0);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});

// ---------------------------------------------------------------------------
// THE TWO RULES THE CONVERGENCE ROUND ASKED FOR (finding 4).
//
// Both are about a reading that is a little bit STALE — which every reading
// taken on a chain of looks eventually is — and both are ways the reader's own
// list could be spoiled by one.
// ---------------------------------------------------------------------------
describe("adoptServerMessages, on a reading that is behind", () => {
  it("takes the TAIL and not a message from the middle, so the order stays the one it was spoken in", () => {
    // The column knows u1, a1 and a3; the server's reading also has a2, which
    // belongs BETWEEN a1 and a3. Everything this seam takes is appended, so
    // taking a2 would put it after a3 and leave the reader looking at a
    // conversation nobody had in that order.
    const { result } = mountTurns([msg("u1", "user"), msg("a1", "assistant"), msg("a3", "assistant")]);
    let took = -1;
    act(() => {
      took = result.current.adoptServerMessages([
        msg("u1", "user"),
        msg("a1", "assistant"),
        msg("a2", "assistant"),
        msg("a3", "assistant"),
      ]);
    });
    expect(took).toBe(0);
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "a3"]);
  });

  it("still takes what comes after the last message it knows", () => {
    const { result } = mountTurns([msg("u1", "user"), msg("a1", "assistant"), msg("a3", "assistant")]);
    act(() => {
      result.current.adoptServerMessages([
        msg("u1", "user"),
        msg("a1", "assistant"),
        msg("a2", "assistant"),
        msg("a3", "assistant"),
        msg("a4", "assistant"),
      ]);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "a3", "a4"]);
  });

  it("never folds back a removal that was already SAVED", () => {
    // The assertion leaves the pending map the moment the save that carried it
    // lands — but the read that set off BEFORE that save answers after it, with
    // the removed turn still in it. Without the settled-removal memory the
    // reader's saved edit comes straight back.
    const { result } = mountTurns([...SEEDED, msg("u2", "user"), msg("a2", "assistant")]);
    act(() => {
      result.current.onEditAndResend("u2", "actually, never mind");
    });
    const peeked = result.current.peekRemovedMessageIds();
    expect(peeked.ids).toContain("a2");
    act(() => {
      // The save landed: the assertion is released.
      result.current.confirmRemovedMessageIds(peeked.saveToken);
    });
    expect(result.current.peekRemovedMessageIds().ids).not.toContain("a2");

    let took = -1;
    act(() => {
      took = result.current.adoptServerMessages([
        ...SEEDED,
        msg("u2", "user"),
        msg("a2", "assistant"),
      ]);
    });
    expect(took).toBe(0);
    expect(result.current.messages.map((m) => m.id)).not.toContain("a2");
  });
});
