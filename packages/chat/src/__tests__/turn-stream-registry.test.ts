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
import {
  createTurnStreamRegistry,
  MAX_ENDED_UNCOMMITTED_TURN_IDS,
  type TurnStreamToken,
} from "../turn-stream-registry";

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
    streams.end(streams.begin("a3", controller()));
    expect(streams.has("a3")).toBe(false); // no longer STREAMING...
    expect(streams.removableTurnIds()).toEqual(["a3"]); // ...but still NAMEABLE
  });

  it("releases the id once a COMMITTED transcript carries it, and not before", () => {
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a3", controller()));
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
    const token = streams.begin("a9", aborted);
    streams.abortAll();
    streams.end(token); // the drive's finally, after the abort unwound it
    expect(aborted.signal.aborted).toBe(true);
    streams.noteCommittedTranscript([{ id: "u1" }, { id: "a1" }]);
    expect(streams.removableTurnIds()).toEqual(["a9"]);
  });

  it("names an in-flight turn ONCE even after a redundant end", () => {
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a3", controller()));
    streams.begin("a3", controller()); // a retry reusing the id
    expect(streams.removableTurnIds()).toEqual(["a3"]);
  });

  it("reports whether the turn WAS in flight, so the page's count stays in step", () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a3", controller());
    expect(streams.end(token)).toBe(true);
    expect(streams.end(token)).toBe(false); // idempotent — no second decrement
    expect(streams.size()).toBe(0);
  });

  it("DROPS the ledger on a thread switch — those ids belong to the thread left", () => {
    // Nothing in another thread's transcript would ever release them, and an
    // edit made over there must not assert removals about turns that streamed
    // somewhere else.
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a3", controller()));
    streams.begin("a4", controller());
    streams.reset();
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.size()).toBe(0);
  });

  it("a LATE end from the thread that was left cannot repopulate the ledger", () => {
    // CODEX ROUND 2, FINDING 1. `reset()` aborts the in-flight stream and
    // unregisters it — but the drive unwinds on its OWN schedule, and its
    // `finally` runs afterwards, ending a turn that belongs to the thread left.
    // An unconditional `end` wrote that id into the NEW thread's ledger, where
    // the next edit would assert it as removed: a collision tombstones a turn of
    // the new thread that nobody removed, and a miss is a stale id forever.
    const streams = createTurnStreamRegistry();
    const live = new AbortController();
    const old = streams.begin("a-old", live);

    streams.reset(); // the thread switch

    streams.end(old); // ...and only now does the old drive's finally run
    expect(live.signal.aborted).toBe(true);
    expect(streams.removableTurnIds()).toEqual([]);
    // The new thread's own turns are unaffected — the registry moved past that
    // instance, it did not stop registering turns.
    streams.end(streams.begin("a-new", new AbortController()));
    expect(streams.removableTurnIds()).toEqual(["a-new"]);
  });

  it("drops the ledger when the THREAD changes, with no stream left in flight", () => {
    // CODEX ROUND 2, FINDING 2. The ledger outlives the last stream: an ended
    // turn stays nameable until a committed transcript carries it, so "nothing
    // is in flight" says nothing about whether the ledger is empty. The boundary
    // is the THREAD, not the stream count, and it is the registry that knows
    // which thread its ids belong to.
    const streams = createTurnStreamRegistry();
    expect(streams.resetForThread("t-a")).toBe(false); // adoption, not a change
    streams.end(streams.begin("a3", new AbortController()));
    expect(streams.size()).toBe(0); // nothing in flight...
    expect(streams.removableTurnIds()).toEqual(["a3"]); // ...and still nameable

    expect(streams.resetForThread("t-a")).toBe(false); // the same thread twice
    expect(streams.removableTurnIds()).toEqual(["a3"]);

    expect(streams.resetForThread("t-b")).toBe(true); // an ACTUAL switch
    expect(streams.removableTurnIds()).toEqual([]);
  });

  it("BOUNDS the ledger, evicting the oldest id — the stated cost of a bound", () => {
    // CODEX ROUND 2, FINDING 3. An aborted turn is released by nothing, so an
    // unbounded ledger grows for the whole page session and every later edit
    // carries all of it. The bound is a cap with oldest-first eviction; what an
    // eviction costs is stated at the eviction site.
    const streams = createTurnStreamRegistry();
    const overflow = 5;
    for (let i = 0; i < MAX_ENDED_UNCOMMITTED_TURN_IDS + overflow; i += 1) {
      streams.end(streams.begin(`a${i}`, new AbortController()));
    }
    const nameable = streams.removableTurnIds();
    expect(nameable).toHaveLength(MAX_ENDED_UNCOMMITTED_TURN_IDS);
    // The OLDEST went, and the newest — the ones an edit made now is most likely
    // to be about — are all still there.
    expect(nameable).not.toContain("a0");
    expect(nameable[0]).toBe(`a${overflow}`);
    expect(nameable).toContain(`a${MAX_ENDED_UNCOMMITTED_TURN_IDS + overflow - 1}`);
  });

  it("a REUSED id cannot let a dead drive's end touch the live drive's turn", () => {
    // CODEX ROUND 3, FINDING 1. An assistant id is REUSABLE, so `end` keyed on
    // one reaches whichever turn is wearing it by the time the call arrives:
    //
    //   begin("x") · reset() · begin("x") · end("x")  ← the FIRST drive, late
    //
    // That last call deleted the SECOND drive's controller — its live turn
    // stopped being nameable as in-flight and the page's streaming count went
    // out of step — and recorded "x" into a ledger the first drive's thread has
    // no business writing to. `begin` mints an INSTANCE TOKEN, `end` acts only
    // for the instance still registered, and no lookup by the id survives.
    const streams = createTurnStreamRegistry();
    const dead = streams.begin("x", new AbortController());
    streams.reset(); // the thread switch, or a reset for any other reason
    const live = streams.begin("x", new AbortController()); // the id comes round again

    // THE OLD DRIVE'S `finally`. Under the contract this replaced it had only
    // the id to end with — and a bare id is not an instance, so there is
    // nothing here for it to reach.
    expect(streams.end("x" as unknown as TurnStreamToken)).toBe(false);
    expect(streams.has("x"), "an end by id deleted the LIVE drive's turn").toBe(true);
    // The token the old drive actually closes over is just as inert: it names an
    // instance this registry has moved past.
    expect(streams.end(dead)).toBe(false);
    expect(streams.has("x")).toBe(true);
    // ...and none of it reached the ledger. "x" is nameable as an IN-FLIGHT
    // turn, which is what it is.
    expect(streams.removableTurnIds()).toEqual(["x"]);
    expect(streams.size()).toBe(1);

    // Only the live instance's own token ends it, and only then is it a ledger
    // entry.
    expect(streams.end(live)).toBe(true);
    expect(streams.has("x")).toBe(false);
    expect(streams.removableTurnIds()).toEqual(["x"]);
  });

  it("a drive that never ends leaves NO per-id bookkeeping behind, across every switch", () => {
    // CODEX ROUND 3, FINDING 2. The generation check this replaced needed a map
    // from id to the generation it began in, and only the matching `end` dropped
    // an entry — so a drive that never reached its `finally` (a hung fetch, a
    // torn-down tab, a socket that never closed) left its entry there for the
    // life of the page, across every thread switch. An instance token carries
    // what `end` needs, so there is no such map: the registry's whole footprint
    // is the in-flight instances plus the capped ledger, and a switch drops both.
    const streams = createTurnStreamRegistry();
    streams.resetForThread("t-0");
    const hung: TurnStreamToken[] = [];
    for (let i = 0; i < 200; i += 1) {
      hung.push(streams.begin(`hung-${i}`, new AbortController()));
      expect(streams.resetForThread(`t-${i + 1}`)).toBe(true);
    }
    expect(
      streams.retainedIdCount(),
      "the registry retains per-id state for turns whose thread it has left",
    ).toBe(0);

    // ...and when those drives finally do unwind, every one of them is inert —
    // no ledger entry, no count, nothing to clean up.
    for (const token of hung) expect(streams.end(token)).toBe(false);
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.retainedIdCount()).toBe(0);

    // WHAT THE RETAINED ENTRY DID, when there was one: 200 threads later the
    // current thread mints a turn with an id the hung drive still had an entry
    // for, and that entry made the dead drive's `end` look current. It ended
    // the LIVE turn and wrote the id into THIS thread's ledger.
    const live = new AbortController();
    streams.begin("hung-0", live);
    expect(streams.end(hung[0]), "a 200-switch-old drive ended the live turn").toBe(false);
    expect(streams.has("hung-0")).toBe(true);
    expect(streams.removableTurnIds()).toEqual(["hung-0"]);
  });

  it("ADOPTS the first thread only when the registry is EMPTY", () => {
    // CODEX ROUND 3, FINDING 4. Adoption exists for one situation — a fresh
    // registry holds nothing, so mounting on whatever thread the URL named
    // cannot be wrong about anything. State present at the FIRST observation is
    // a different situation: those ids streamed before anything here named a
    // thread, so nothing can say they belong to this one, and adopting them lets
    // an edit on this thread assert removals about turns that ran elsewhere.
    const streams = createTurnStreamRegistry();
    const live = new AbortController();
    streams.begin("a-live", live); // in flight, with no thread named yet...
    streams.end(streams.begin("a-before", new AbortController())); // ...and a ledger entry
    expect(streams.has("a-live")).toBe(true);

    expect(
      streams.resetForThread("t-a"),
      "a registry holding turns of no named thread was ADOPTED into the first one",
    ).toBe(true);
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.retainedIdCount()).toBe(0);
    expect(live.signal.aborted).toBe(true);
  });

  it("a SECOND observation of the same thread never resets — React mounts effects twice", () => {
    // The other half of finding 4, and the reason adoption exists at all. The
    // dirty-registry check is on the FIRST observation only: once the thread is
    // held, seeing it again is React's double-invoked mount effect, and
    // resetting there would abort the turn the first run started.
    const streams = createTurnStreamRegistry();
    expect(streams.resetForThread("t-a")).toBe(false); // empty: adopted
    const live = new AbortController();
    streams.begin("a1", live);
    streams.end(streams.begin("a2", new AbortController()));

    expect(streams.resetForThread("t-a")).toBe(false); // the effect runs again
    expect(live.signal.aborted).toBe(false);
    expect(streams.has("a1")).toBe(true);
    expect(streams.removableTurnIds()).toEqual(["a1", "a2"]);
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
