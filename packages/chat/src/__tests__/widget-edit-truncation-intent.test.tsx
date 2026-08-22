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
  assistantId: string;
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

/** The ids half of a peek. `peekRemovedMessageIds` returns `{ ids, saveToken }`
 *  — the token is what a confirm is matched on, and the arm below that is about
 *  the token says so itself. */
const peekIds = (r: { current: { peekRemovedMessageIds: () => { ids: string[] } } }) =>
  r.current.peekRemovedMessageIds().ids;

/**
 * The assistant id of the Nth turn this column dispatched, read off the driver
 * request it was given.
 *
 * A turn whose drive REVEALED NOTHING is still nameable: the column keeps the
 * same registry `/chat` keeps (cinatra#2823 S9j), and its ledger holds an ended
 * turn until a COMMITTED transcript carries it. The stub driver in this file
 * reveals nothing by design, so every turn it runs sits in that ledger — and an
 * edit made afterwards names it, exactly as it should. The real driver appends
 * the assistant bubble when the turn STARTS, so in production the ledger is
 * empty by the time an edit can be made and this union contributes nothing.
 */
const turnId = (n: number) => driveAssistantChatTurn.mock.calls[n]![0]!.assistantId;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the conversation column's edit carries a truncation intent", () => {
  it("names every message the edit dropped, and NOT the one it rewrote", () => {
    const { result } = mountTurns();
    expect(peekIds(result)).toEqual([]);

    act(() => {
      result.current.onEditAndResend("u2", "actually, never mind");
    });

    // `a2` is gone. `u2` is NOT named: this column rewrites the edited message
    // IN PLACE, keeping its id, so the payload still carries it — asserting its
    // removal would be a lie about a message the save is keeping.
    expect(peekIds(result)).toEqual(["a2"]);
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
    // `turnId(0)` is the turn the FIRST edit dispatched to answer `u2`: it
    // revealed nothing, and the second edit removes the prompt it was answering.
    expect(peekIds(result)).toEqual(["a2", "u2", turnId(0)]);
  });

  it("keeps the intent until a save CONFIRMS it, because a widget save is silent", () => {
    // `saveThreadTranscript` is best-effort and swallows its failures. Draining
    // the ledger at build time would lose the assertion for good on a save that
    // never landed — and the NEXT save would then carry the truncated transcript
    // with nothing asserted, which is precisely the silent-truncation shape.
    const { result } = mountTurns();
    act(() => result.current.onEditAndResend("u2", "rewrite"));
    const save = result.current.peekRemovedMessageIds();
    expect(save.ids).toEqual(["a2"]);
    // Peeking twice does not consume it.
    expect(peekIds(result)).toEqual(["a2"]);
    act(() => result.current.confirmRemovedMessageIds(save.saveToken));
    expect(peekIds(result)).toEqual([]);
  });

  it("a confirm only clears what it carried — an edit during the save survives", async () => {
    const { result } = mountTurns();
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite");
    });
    const inFlight = result.current.peekRemovedMessageIds(); // ids: ["a2"]
    // The save is still open; the reader edits again.
    await act(async () => {
      result.current.onEditAndResend("a1", "rewrite again");
    });
    act(() => result.current.confirmRemovedMessageIds(inFlight.saveToken));
    // `u2` was truncated by the SECOND edit and no save has carried it yet —
    // and so was the unrevealed turn the first edit dispatched for it.
    expect(peekIds(result)).toEqual(["u2", turnId(0)]);
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
    expect(saveA.ids).toEqual(["a2"]);

    // The reader edits again while A is still open: `a2` is present, and this
    // edit removes it a second time. A different removal of the same id.
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite once more");
    });
    expect(peekIds(result)).toEqual(["a2", turnId(0)]);

    // A lands. It may only clear what it carried.
    act(() => result.current.confirmRemovedMessageIds(saveA.saveToken));
    expect(
      peekIds(result),
      "the confirm of an older save cleared an assertion made after it",
    ).toEqual(["a2", turnId(0)]);
  });

  it("confirms a save whose ids array was COPIED — the TOKEN is what a save is", async () => {
    // CODEX ROUND 3, FINDING 3. The confirm used to be keyed on the identity of
    // the ids ARRAY the peek returned, held in a WeakMap. Every host that does
    // anything ordinary with those ids between the peek and the confirm — posts
    // them as JSON, spreads them into a payload builder, hands back what the
    // response echoed — gives back a DIFFERENT array object, whose snapshot the
    // WeakMap has never seen, and the confirm cleared NOTHING while reporting
    // nothing wrong. A confirmed removal that never clears is re-asserted in
    // every later save forever and, at the cap, evicts newer assertions to make
    // room for itself. So the contract says it outright: the peek hands out a
    // SAVE TOKEN, and the token is plain data.
    const { result } = mountTurns();
    // The turn that follows the edit re-delivers `a2`, so the second half of
    // this arm has a message to remove a SECOND time.
    driveAssistantChatTurn.mockImplementationOnce(async (req) => {
      req?.ui.updateMessages((prev) => [...prev, msg("a2", "assistant")]);
    });
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite");
    });
    const peeked = result.current.peekRemovedMessageIds();

    // The whole peek goes through the most destructive thing a host can do to
    // it and still be carrying the same statement: a JSON round trip. Every
    // object identity here is now different from the one the hook handed out.
    const wire: typeof peeked = JSON.parse(JSON.stringify(peeked));
    expect(wire.ids).toEqual(["a2"]);
    expect(wire.saveToken).not.toBe(peeked.saveToken);

    act(() => result.current.confirmRemovedMessageIds(wire.saveToken));
    expect(
      peekIds(result),
      "a confirmed removal stayed pending — every later save re-asserts it",
    ).toEqual([]);

    // And the revision check the token exists to carry is untouched by the
    // round trip: `a2` is back in the list, a second edit removes it AGAIN, and
    // the token of the save that carried the FIRST assertion does not clear the
    // second one.
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    await act(async () => {
      result.current.onEditAndResend("u2", "rewrite once more");
    });
    expect(peekIds(result)).toEqual(["a2", turnId(0)]);
    act(() => result.current.confirmRemovedMessageIds(wire.saveToken));
    expect(peekIds(result), "a stale token cleared a newer assertion").toEqual([
      "a2",
      turnId(0),
    ]);
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

    const pending = peekIds(result);
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
    expect(peekIds(result)).toEqual([]);
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
