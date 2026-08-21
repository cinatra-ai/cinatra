/**
 * THE ZERO-SOURCE WINDOW (cinatra#2823 S9j).
 *
 * `editAndResend` names a removed turn from two sources: the render's `messages`
 * snapshot and the page's turn registry. Before `./turn-stream-registry` the
 * second source was the bare in-flight `Map`, and ending a stream deleted the
 * entry outright — while the reveal that puts the turn into `messages` is a
 * `setMessages` React has not committed yet. Between those two moments the turn
 * is in NEITHER source, so an edit dispatched from the still-mounted old render
 * cannot name it, the save asserts nothing about it, and its run-bound row folds
 * back in above the edited prompt on the next reload.
 *
 * Every arm below is written against the registry's OWN contract, so it states
 * the property rather than a scheduling accident: an id is nameable until a
 * COMMITTED transcript proves it landed.
 */
import { describe, it, expect } from "vitest";
import { createTurnStreamRegistry } from "../turn-stream-registry";

const controller = () => new AbortController();

describe("createTurnStreamRegistry", () => {
  it("names a turn that is in flight", () => {
    const streams = createTurnStreamRegistry();
    streams.begin("a3", controller());
    expect(streams.removableTurnIds()).toEqual(["a3"]);
    expect(streams.has("a3")).toBe(true);
  });

  it("STILL names a turn whose stream ended but whose reveal has not committed", () => {
    // THE REGRESSION ARM. This is the window: the drive's `finally` has run, so
    // the controller is gone, and React has not committed the reveal, so the
    // render's `messages` does not carry the turn either. On the old bare map
    // this returned [] and the turn went unnamed.
    const streams = createTurnStreamRegistry();
    streams.begin("a3", controller());
    streams.end("a3");
    expect(streams.has("a3")).toBe(false); // no longer STREAMING...
    expect(streams.removableTurnIds()).toEqual(["a3"]); // ...but still NAMEABLE
  });

  it("releases the id once a COMMITTED transcript carries it, and not before", () => {
    const streams = createTurnStreamRegistry();
    streams.begin("a3", controller());
    streams.end("a3");
    // A commit that does not carry it yet releases nothing — this is the same
    // stale snapshot the edit would have read.
    streams.noteCommittedTranscript([{ id: "u1" }, { id: "a1" }]);
    expect(streams.removableTurnIds()).toEqual(["a3"]);
    // The reveal commits. From here the transcript slice names the turn itself,
    // so the ledger has nothing left to add.
    streams.noteCommittedTranscript([{ id: "u1" }, { id: "a1" }, { id: "a3" }]);
    expect(streams.removableTurnIds()).toEqual([]);
  });

  it("keeps naming an ABORTED turn, which reveals nothing and is released by nothing", () => {
    // The same window held open forever: the stream is cut before it reveals, so
    // no transcript ever carries the turn — while its run-bound row, minted when
    // the run started, still holds foldable state. Under-naming it loses the
    // removal permanently; over-naming it costs an id in a payload, because the
    // tombstone intersects the intent with the rows the payload no longer
    // carries and an id matching no removed row does nothing.
    const streams = createTurnStreamRegistry();
    const aborted = controller();
    streams.begin("a9", aborted);
    streams.abortAll();
    streams.end("a9"); // the drive's finally, after the abort unwound it
    expect(aborted.signal.aborted).toBe(true);
    streams.noteCommittedTranscript([{ id: "u1" }, { id: "a1" }]);
    expect(streams.removableTurnIds()).toEqual(["a9"]);
  });

  it("names an in-flight turn ONCE even after a redundant end", () => {
    const streams = createTurnStreamRegistry();
    streams.begin("a3", controller());
    streams.end("a3");
    streams.begin("a3", controller()); // a retry reusing the id
    expect(streams.removableTurnIds()).toEqual(["a3"]);
  });

  it("reports whether the turn WAS in flight, so the page's count stays in step", () => {
    const streams = createTurnStreamRegistry();
    streams.begin("a3", controller());
    expect(streams.end("a3")).toBe(true);
    expect(streams.end("a3")).toBe(false); // idempotent — no second decrement
    expect(streams.size()).toBe(0);
  });

  it("DROPS the ledger on a thread switch — those ids belong to the thread left", () => {
    // Nothing in another thread's transcript would ever release them, and an
    // edit made over there must not assert removals about turns that streamed
    // somewhere else.
    const streams = createTurnStreamRegistry();
    const live = controller();
    streams.begin("a3", live);
    streams.end("a3");
    streams.begin("a4", controller());
    streams.reset();
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.size()).toBe(0);
  });

  it("abortAll aborts without forgetting — each drive's own finally still ends it", () => {
    const streams = createTurnStreamRegistry();
    const a = controller();
    streams.begin("a3", a);
    streams.abortAll();
    expect(a.signal.aborted).toBe(true);
    // Still in flight as far as the registry is concerned: the Stop button does
    // not end a turn, the drive unwinding does.
    expect(streams.size()).toBe(1);
  });
});
