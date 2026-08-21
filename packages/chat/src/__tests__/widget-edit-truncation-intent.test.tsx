// @vitest-environment jsdom
/**
 * THE WIDGET'S EDIT ASSERTS ITS TRUNCATION (cinatra#2823 S9j).
 *
 * The shared conversation column has a real edit-and-resend: `onEditAndResend`
 * rewrites a message and drops every successor, and the host saves the truncated
 * transcript when the turn that follows ends. That save asserted NOTHING.
 *
 * A truncating save that asserts nothing is the defect this whole leg exists to
 * remove. The server's reconcile DELETE takes the removed turns' mirror rows,
 * their run-bound rows — minted when each run started, and untouchable by that
 * DELETE — survive, and the reload folds them back in ABOVE the edited prompt.
 * The widget reader's edit came undone on every reload, permanently.
 *
 * These arms are on the hook itself, which is where the truncation happens, so
 * they state the column's own contract rather than one host's wiring of it.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const driveAssistantChatTurn = vi.fn(async () => undefined);

vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    driveAssistantChatTurn: (...a: unknown[]) => driveAssistantChatTurn(...(a as [])),
  };
});

import { useConversationColumnTurns } from "../conversation-column";
import { buildThreadWrite } from "../conversation-services";
import type { UiMessage } from "../types";

const msg = (id: string, role: "user" | "assistant"): UiMessage =>
  ({ id, role, content: id }) as UiMessage;

/** u1 / a1 / u2 / a2 — the reader edits `u2`. */
const SEEDED: UiMessage[] = [
  msg("u1", "user"),
  msg("a1", "assistant"),
  msg("u2", "user"),
  msg("a2", "assistant"),
];

function mountTurns(initialMessages: UiMessage[] = SEEDED) {
  return renderHook(() =>
    useConversationColumnTurns({ threadId: "t-widget", initialMessages }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the conversation column's edit carries a truncation intent", () => {
  it("names every message the edit dropped, and NOT the one it rewrote", () => {
    const { result } = mountTurns();
    expect(result.current.peekRemovedMessageIds()).toEqual([]);

    act(() => {
      result.current.onEditAndResend("u2", "actually, never mind");
    });

    // `a2` is gone. `u2` is NOT named: this column rewrites the edited message
    // IN PLACE, keeping its id, so the payload still carries it — asserting its
    // removal would be a lie about a message the save is keeping.
    expect(result.current.peekRemovedMessageIds()).toEqual(["a2"]);
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("ACCUMULATES across edits — the save comes turns after the truncation", async () => {
    // The edit and the save are separate events on this surface: the host saves
    // when a TURN ENDS, which is at least one turn after the edit. A second edit
    // before that save must not erase the first one's assertion. The turn is
    // awaited between them because the column refuses an edit during a stream.
    const { result } = mountTurns();
    await act(async () => {
      result.current.onEditAndResend("u2", "first rewrite");
    });
    await act(async () => {
      result.current.onEditAndResend("a1", "second rewrite");
    });
    expect(result.current.peekRemovedMessageIds()).toEqual(["a2", "u2"]);
  });

  it("keeps the intent until a save CONFIRMS it, because a widget save is silent", () => {
    // `saveThreadTranscript` is best-effort and swallows its failures. Draining
    // the ledger at build time would lose the assertion for good on a save that
    // never landed — and the NEXT save would then carry the truncated transcript
    // with nothing asserted, which is precisely the silent-truncation shape.
    const { result } = mountTurns();
    act(() => result.current.onEditAndResend("u2", "rewrite"));
    const pending = result.current.peekRemovedMessageIds();
    expect(pending).toEqual(["a2"]);
    // Peeking twice does not consume it.
    expect(result.current.peekRemovedMessageIds()).toEqual(["a2"]);
    act(() => result.current.confirmRemovedMessageIds(pending));
    expect(result.current.peekRemovedMessageIds()).toEqual([]);
  });

  it("a confirm only clears what it carried — an edit during the save survives", async () => {
    const { result } = mountTurns();
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite");
    });
    const inFlight = result.current.peekRemovedMessageIds(); // ["a2"]
    // The save is still open; the reader edits again.
    await act(async () => {
      result.current.onEditAndResend("a1", "rewrite again");
    });
    act(() => result.current.confirmRemovedMessageIds(inFlight));
    // `u2` was truncated by the SECOND edit and no save has carried it yet.
    expect(result.current.peekRemovedMessageIds()).toEqual(["u2"]);
  });

  it("an edit that removes nothing asserts nothing", () => {
    const { result } = mountTurns();
    act(() => result.current.onEditAndResend("a2", "edit the tail"));
    expect(result.current.peekRemovedMessageIds()).toEqual([]);
  });
});

describe("buildThreadWrite carries the intent onto the wire", () => {
  const base = { threadId: "t-widget", messages: SEEDED, createdAt: "2026-08-01T00:00:00.000Z" };

  it("includes the assertion when the column has one", () => {
    expect(buildThreadWrite({ ...base, removedMessageIds: ["a2"] }).removedMessageIds).toEqual([
      "a2",
    ]);
  });

  it("OMITS it when there is none — an ordinary save asserts nothing", () => {
    // The separation the tombstone rests on: every save posts the whole
    // transcript, so a save that simply never had a turn must not read as a
    // removal. Empty and absent are the same statement, and it is not made.
    expect(buildThreadWrite(base)).not.toHaveProperty("removedMessageIds");
    expect(buildThreadWrite({ ...base, removedMessageIds: [] })).not.toHaveProperty(
      "removedMessageIds",
    );
  });
});
