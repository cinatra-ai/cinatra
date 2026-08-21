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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/** The one field of the turn request these arms drive: the list writer the real
 *  driver folds a turn's messages back in through. */
type DriveRequest = {
  ui: { updateMessages: (updater: (prev: UiMessage[]) => UiMessage[]) => void };
};
const driveAssistantChatTurn = vi.fn<(req?: DriveRequest) => Promise<void>>(async () => undefined);

vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    driveAssistantChatTurn: (...a: unknown[]) => driveAssistantChatTurn(...(a as [])),
  };
});

import {
  MAX_PENDING_REMOVED_MESSAGE_IDS,
  useConversationColumnTurns,
} from "../conversation-column";
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

  it("a confirm cannot clear an assertion its save never carried", async () => {
    // CODEX ROUND 2, FINDING 4. `confirm` subtracted its ids from the CURRENT
    // set, so it could not tell two assertions of the SAME id apart. Save A
    // carries `a2`; while A is still open the turn that follows the edit folds
    // `a2` back into the list, and a second edit removes it AGAIN; A then lands
    // and its confirm cleared the assertion made after it — the removal the
    // second edit performed was never asserted by anything, which is the
    // silent-truncation shape this whole leg exists to remove.
    const { result } = mountTurns();
    // The turn that follows the edit re-delivers `a2` — the list regains it.
    driveAssistantChatTurn.mockImplementationOnce(async (req) => {
      req?.ui.updateMessages((prev) => [...prev, msg("a2", "assistant")]);
    });
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite");
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);

    // SAVE A goes on the wire carrying the FIRST assertion of `a2`.
    const saveA = result.current.peekRemovedMessageIds();
    expect(saveA).toEqual(["a2"]);

    // The reader edits again while A is still open: `a2` is present, and this
    // edit removes it a second time. A different removal of the same id.
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite once more");
    });
    expect(result.current.peekRemovedMessageIds()).toEqual(["a2"]);

    // A lands. It may only clear what it carried.
    act(() => result.current.confirmRemovedMessageIds(saveA));
    expect(
      result.current.peekRemovedMessageIds(),
      "the confirm of an older save cleared an assertion made after it",
    ).toEqual(["a2"]);
  });

  it("BOUNDS the pending removals, evicting the oldest — the stated cost of a bound", () => {
    // CODEX ROUND 2, FINDING 3. Every save that fails preserves its removals, so
    // an unbounded ledger keeps every id a session ever truncated. The bound is
    // a cap with oldest-first eviction; what an eviction costs is stated at the
    // eviction site.
    const overflow = 5;
    const long: UiMessage[] = [msg("u1", "user")];
    for (let i = 0; i < MAX_PENDING_REMOVED_MESSAGE_IDS + overflow; i += 1) {
      long.push(msg(`m${i}`, "assistant"));
    }
    const { result } = mountTurns(long);
    act(() => result.current.onEditAndResend("u1", "rewrite"));

    const pending = result.current.peekRemovedMessageIds();
    expect(pending).toHaveLength(MAX_PENDING_REMOVED_MESSAGE_IDS);
    // The OLDEST went, and the newest — the removals a save made now is most
    // likely to be about — are all still there.
    expect(pending).not.toContain("m0");
    expect(pending[0]).toBe(`m${overflow}`);
    expect(pending).toContain(`m${MAX_PENDING_REMOVED_MESSAGE_IDS + overflow - 1}`);
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
