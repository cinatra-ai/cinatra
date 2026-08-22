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

  it("BOUNDS the ledger over the WIDER population the release split gives it", () => {
    // CODEX, ROUND 4, ON THE SPLIT. Before it, an entry left the ledger on its
    // reveal, so the cap only ever held ABORTED turns. Now a turn that revealed
    // and whose save has not landed is retained too — so the cap's population is
    // wider, and this arm drives it in exactly that shape: every turn reveals
    // (its ID half is released) and no save ever lands (its RUN half is not).
    // The bound still holds, the eviction is still oldest-first, and what it
    // costs is the same thing it always cost: that one turn's run is
    // unassertable forever.
    const streams = createTurnStreamRegistry();
    const overflow = 5;
    const total = MAX_ENDED_UNCOMMITTED_TURN_IDS + overflow;
    for (let i = 0; i < total; i += 1) {
      const token = streams.begin(`a${i}`, new AbortController(), `u${i}`);
      streams.noteRunId(token, `run-${i}`);
      streams.end(token);
      streams.noteCommittedTranscript([{ id: `a${i}` }]);
    }
    // Every id half is released, so the ledger adds NOTHING to a truncation
    // intent — the transcript names all of these turns itself.
    expect(streams.removableTurnIds()).toEqual([]);
    // The run halves are held, capped, and oldest-first.
    expect(streams.retainedIdCount()).toBe(MAX_ENDED_UNCOMMITTED_TURN_IDS);
    const everyAnchor = new Set(Array.from({ length: total }, (_, i) => `u${i}`));
    const runs = streams.removableRunIds(everyAnchor);
    expect(runs).toHaveLength(MAX_ENDED_UNCOMMITTED_TURN_IDS);
    expect(runs).not.toContain("run-0"); // evicted, and gone for good
    expect(runs[0]).toBe(`run-${overflow}`);
    expect(runs).toContain(`run-${total - 1}`);
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

describe("the run id — the identity the server shares with these turns", () => {
  // A bubble id is minted in the page, so a turn no saved transcript carries
  // leaves no server-side row holding any name this registry knows. The run id
  // does exist on both sides, so the registry keeps it beside the id under the
  // SAME release rule and offers it to the truncation intent — NARROWED to the
  // turns whose anchor prompt the edit actually removed, because a run id names
  // the run-bound row outright and over-naming is not free there.

  /** The edit's removed set, as the flow hands it over. */
  const removing = (...ids: string[]) => new Set(ids);

  it("offers the run of an IN-FLIGHT turn anchored to a removed prompt", () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u1");
    expect(streams.noteRunId(token, "run-1")).toBe(true);
    expect(streams.removableRunIds(removing("u1", "a1"))).toEqual(["run-1"]);
  });

  it("WITHHOLDS the run of a concurrent turn anchored to a KEPT prompt", () => {
    // Slack streams turns concurrently, so an uncommitted turn is NOT necessarily
    // below the edit point. Its bubble id may still be named — that reaches no row
    // — but its run must not be, or an edit tombstones a turn the user kept.
    const streams = createTurnStreamRegistry();
    const kept = streams.begin("a-for-u1", controller(), "u1");
    streams.noteRunId(kept, "run-for-u1");
    const removed = streams.begin("a-for-u2", controller(), "u2");
    streams.noteRunId(removed, "run-for-u2");
    expect(streams.removableTurnIds()).toEqual(["a-for-u1", "a-for-u2"]);
    expect(streams.removableRunIds(removing("u2", "a-for-u1", "a-for-u2"))).toEqual([
      "run-for-u2",
    ]);
  });

  it("WITHHOLDS the run of a turn with no anchor — fail-closed", () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller());
    streams.noteRunId(token, "run-1");
    expect(streams.removableTurnIds()).toEqual(["a1"]);
    expect(streams.removableRunIds(removing("u1", "a1"))).toEqual([]);
  });

  it("releases the ID half on a committed transcript and the RUN half only on a save that LANDED", () => {
    // CODEX ROUND 4, FINDING 1 — THE RULE THIS ARM REPLACES WAS WRONG. It read "a run
    // id leaves exactly when its turn's id does", so ONE event released both
    // halves. The two halves prove different things. A committed transcript
    // proves the render's own `messages` slice can NAME the turn, which is all
    // the bubble-id half is for. Only a save that LANDED proves the server has a
    // MIRROR ROW to read a key out of. Between those two events the turn is on
    // screen and has no row, so its RUN is the only identity an edit can assert
    // about it — and releasing the run there is what lost it (a Slack sibling
    // still streaming skips the save entirely; a lone turn's best-effort save
    // can simply fail).
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u1");
    streams.noteRunId(token, "run-1");
    streams.end(token);
    expect(streams.removableRunIds(removing("u1"))).toEqual(["run-1"]); // ended, still nameable

    // The reveal commits. The transcript slice names the bubble from here, so
    // the ledger has nothing left to add to the ID half...
    streams.noteCommittedTranscript([{ id: "a1" }]);
    expect(streams.removableTurnIds()).toEqual([]);
    // ...and the RUN half is still held, because no save has landed and the turn
    // therefore still has no mirror row.
    expect(streams.removableRunIds(removing("u1"))).toEqual(["run-1"]);

    // The save lands. The mirror row exists, the ordinary key takes over, and
    // the registry holds nothing for this turn at all — the release is real, not
    // a leak dressed as one.
    streams.noteSavedTranscript([{ id: "a1" }]);
    expect(streams.removableRunIds(removing("u1"))).toEqual([]);
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.retainedIdCount()).toBe(0);
  });

  it("a landed save that does NOT carry the turn releases nothing", () => {
    // The release is keyed on the transcript the save actually persisted, not on
    // "some save landed": a save issued for a slice this turn is not in proves
    // no mirror row for it.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u1");
    streams.noteRunId(token, "run-1");
    streams.end(token);
    streams.noteCommittedTranscript([{ id: "a1" }]);
    streams.noteSavedTranscript([{ id: "u1" }, { id: "a-other" }]);
    expect(streams.removableRunIds(removing("u1"))).toEqual(["run-1"]);
  });

  it("a turn whose run never arrived leaves the ledger on the transcript commit", () => {
    // There is no second half to hold. Keeping such an entry past the commit
    // would grow the registry's footprint for nothing, so the entry goes as it
    // always did — the split costs retention only where a run exists to retain.
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a1", controller(), "u1"));
    streams.noteCommittedTranscript([{ id: "a1" }]);
    expect(streams.removableTurnIds()).toEqual([]);
    expect(streams.retainedIdCount()).toBe(0);
  });

  it("a turn whose run never arrived contributes NO run — and is still named by its id", () => {
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a-aborted", controller(), "u1"));
    expect(streams.removableTurnIds()).toEqual(["a-aborted"]);
    expect(streams.removableRunIds(removing("u1"))).toEqual([]);
  });

  it("a SUPERSEDED token cannot stamp its run onto the turn wearing its id now", () => {
    // The instance gate, for the other identity. A late drive reporting its run
    // would otherwise hand the next edit a run belonging to a turn that is gone.
    const streams = createTurnStreamRegistry();
    const first = streams.begin("x", controller(), "u1");
    const second = streams.begin("x", controller(), "u1"); // same id, new instance
    expect(streams.noteRunId(first, "run-first")).toBe(false);
    expect(streams.removableRunIds(removing("u1"))).toEqual([]);
    expect(streams.noteRunId(second, "run-second")).toBe(true);
    expect(streams.removableRunIds(removing("u1"))).toEqual(["run-second"]);
  });

  it("the FIRST run observed for an instance is kept — the drive reports it on every fold", () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u1");
    expect(streams.noteRunId(token, "run-1")).toBe(true);
    expect(streams.noteRunId(token, "run-1")).toBe(false); // idempotent
    expect(streams.noteRunId(token, "run-2")).toBe(false); // and not overwritten
    expect(streams.removableRunIds(removing("u1"))).toEqual(["run-1"]);
  });

  it("an empty run id is not a run", () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u1");
    expect(streams.noteRunId(token, "")).toBe(false);
    expect(streams.removableRunIds(removing("u1"))).toEqual([]);
  });

  it("leaving the thread drops the runs with the ids they belong to", () => {
    const streams = createTurnStreamRegistry();
    expect(streams.resetForThread("t-a")).toBe(false);
    const token = streams.begin("a1", controller(), "u1");
    streams.noteRunId(token, "run-1");
    streams.end(token);
    expect(streams.resetForThread("t-b")).toBe(true);
    expect(streams.removableRunIds(removing("u1"))).toEqual([]);
    expect(streams.retainedIdCount()).toBe(0);
  });
});

describe("the pre-RUN_STARTED window: the edit HOLDS until the run is settled", () => {
  const removing = (...ids: string[]) => new Set(ids);

  // WHAT THE WINDOW IS. `/chat` registers a turn BEFORE it dispatches and learns
  // its run only at `RUN_STARTED`. Between those two moments the turn has no run
  // to offer, and an edit made in that window removes the turn's anchor prompt —
  // so the run that arrives a moment later can never be offered again, because
  // no later edit's removed set can carry a prompt the transcript no longer has.
  //
  // THIS USED TO BE PINNED AS THE FAILURE. It is CLOSED now, and the close is
  // the FIRST of the two the review offered: the edit DEFERS its intent until
  // every turn it would name by run has settled that identity — `RUN_STARTED`
  // arrived, or the stream terminated without one. `removableRunIds` is
  // unchanged and still refuses a run whose anchor is gone; what changed is that
  // the anchor is no longer gone by the time the run lands, because the edit
  // waited for it (`settleRunIdsForRemoval`, and `message-edit-flow.ts` for the
  // flow that awaits it).
  //
  // The close does NOT re-open the over-reach the anchor exists to prevent. A
  // held turn is by construction anchored to a prompt THIS edit removes, so it
  // is a turn below the edit point; nothing is condemned, no latch outlives the
  // edit, and a turn whose prompt the edit KEPT is never waited on and never
  // offered.

  it("holds until RUN_STARTED arrives — and then the run IS offered", async () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-slow-start", controller(), "u2");
    const removed = removing("u2", "a-slow-start");

    let settled = false;
    const held = streams.settleRunIdsForRemoval(removed).then(() => {
      settled = true;
    });
    // The edit is in the window: the turn is registered, its run is not known,
    // and its anchor is one of the prompts this edit removes.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, "the intent went out while the run was still unknown").toBe(false);
    expect(streams.removableRunIds(removed)).toEqual([]);

    // RUN_STARTED lands.
    expect(streams.noteRunId(token, "run-slow")).toBe(true);
    await held;
    expect(settled).toBe(true);
    // THE CLOSE. The anchor is still in this edit's removed set, because the
    // edit never left, so the run is assertable exactly when it becomes known.
    expect(
      streams.removableRunIds(removed),
      "the hold released but the run was still withheld — the pre-RUN_STARTED window is open again",
    ).toEqual(["run-slow"]);
  });

  it("releases when the stream terminates WITHOUT a run — the turn is provably runless", async () => {
    // The other settling event. An aborted-before-`RUN_STARTED` turn has no run
    // to wait for, and holding the edit for one that will never arrive would
    // hang the edit rather than close anything.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-cut", controller(), "u2");
    const removed = removing("u2", "a-cut");
    let settled = false;
    const held = streams.settleRunIdsForRemoval(removed).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(streams.end(token)).toBe(true);
    await held;
    expect(settled).toBe(true);
    // Still named by its id, and it contributes no run — the honest residual.
    expect(streams.removableTurnIds()).toEqual(["a-cut"]);
    expect(streams.removableRunIds(removed)).toEqual([]);
  });

  it("waits for nothing when there is nothing to wait for", async () => {
    const streams = createTurnStreamRegistry();
    // No turn at all.
    await streams.settleRunIdsForRemoval(removing("u2"));
    // A turn whose run is ALREADY known settles nothing further.
    const token = streams.begin("a1", controller(), "u2");
    streams.noteRunId(token, "run-1");
    await streams.settleRunIdsForRemoval(removing("u2"));
    expect(streams.removableRunIds(removing("u2"))).toEqual(["run-1"]);
  });

  it("does NOT wait on a turn whose prompt this edit KEPT", async () => {
    // The anchor filter, applied to the hold itself. Slack streams turns
    // concurrently: a turn dispatched for a prompt ABOVE the edit point is none
    // of this edit's business, and holding the edit for its handshake would make
    // every concurrent turn a latency tax on every edit.
    const streams = createTurnStreamRegistry();
    streams.begin("a-other", controller(), "u1"); // answers a KEPT prompt
    let settled = false;
    await streams.settleRunIdsForRemoval(removing("u2")).then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
    expect(streams.removableRunIds(removing("u2"))).toEqual([]);
  });

  it("does NOT wait on a turn with no anchor — it could never be offered anyway", async () => {
    const streams = createTurnStreamRegistry();
    streams.begin("a-anchorless", controller(), null);
    let settled = false;
    await streams.settleRunIdsForRemoval(removing("u2")).then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });

  it("is BOUNDED — a hung stream cannot hold the edit forever", async () => {
    // THE COST OF THE CLOSE, stated. A stream that neither reports a run nor
    // terminates would otherwise hold the user's edit open with nothing on the
    // screen changing. The hold is finite; past it the edit goes out with the
    // residual it always had for that one turn.
    const streams = createTurnStreamRegistry();
    streams.begin("a-hung", controller(), "u2");
    await streams.settleRunIdsForRemoval(removing("u2"), { timeoutMs: 0 });
    expect(streams.removableRunIds(removing("u2"))).toEqual([]);
  });

  it("a SUPERSEDED instance settles the hold that was waiting on it", async () => {
    // CODEX ROUND 5 SECOND PASS, FINDING 1. A second `begin` for the same id
    // replaces the registered instance, and the displaced one can never settle
    // again: `noteRunId` and `end` both gate on being the registered instance.
    // A held edit waiting on it would sit out its whole bound and learn nothing.
    const streams = createTurnStreamRegistry();
    streams.begin("x", controller(), "u2");
    let settled = false;
    const held = streams.settleRunIdsForRemoval(removing("u2")).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    // The same id, a new drive. The first instance is gone for good.
    const second = streams.begin("x", controller(), "u2");
    await held;
    expect(settled, "the edit was left waiting on an instance nothing can settle").toBe(true);
    // And the hold released on the DISPLACED instance only — the live one is
    // still free to report its own run, which a later edit reads normally.
    expect(streams.noteRunId(second, "run-second")).toBe(true);
    expect(streams.removableRunIds(removing("u2"))).toEqual(["run-second"]);
  });

  it("cannot be asked for an UNBOUNDED hold", async () => {
    // CODEX ROUND 5, FINDING 2. A bound that a caller can switch off is not a
    // bound: a non-finite or negative request would have left the waiter — and
    // the reader's edit — pending with no event that could ever release it. Such
    // a request takes the default instead.
    const streams = createTurnStreamRegistry();
    streams.begin("a-hung", controller(), "u2");
    let settled = false;
    const held = streams
      .settleRunIdsForRemoval(removing("u2"), { timeoutMs: Number.POSITIVE_INFINITY })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    // Still HELD — the default bound is generous, so this is not an instant
    // release dressed up as one. `timeoutMs` may only SHORTEN the hold, so a
    // caller cannot extend the bound either, and the population bound the module
    // states stays a property of the module.
    expect(settled).toBe(false);
    // ...and it is a real hold that a real event still ends.
    streams.end(streams.begin("a-hung", controller(), "u2"));
    streams.abortAll();
    streams.reset();
    await held;
    expect(settled).toBe(true);
  });

  it("leaving the thread releases the hold", async () => {
    // `resetForThread` aborts and drops everything; the drives unwind
    // afterwards, so nothing else would ever settle this waiter.
    const streams = createTurnStreamRegistry();
    expect(streams.resetForThread("t-a")).toBe(false);
    streams.begin("a1", controller(), "u2");
    let settled = false;
    const held = streams.settleRunIdsForRemoval(removing("u2")).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(streams.resetForThread("t-b")).toBe(true);
    await held;
    expect(settled).toBe(true);
  });

  it("holds for EVERY turn the edit caught in the window, not just the first", async () => {
    // Slack dispatches concurrently, so one edit can catch several turns mid-
    // handshake. The hold is over the whole set.
    const streams = createTurnStreamRegistry();
    const first = streams.begin("a-1", controller(), "u2");
    const second = streams.begin("a-2", controller(), "u2");
    const removed = removing("u2", "a-1", "a-2");
    let settled = false;
    const held = streams.settleRunIdsForRemoval(removed).then(() => {
      settled = true;
    });
    streams.noteRunId(first, "run-1");
    await Promise.resolve();
    expect(settled, "the edit went out while a second turn was still runless").toBe(false);
    streams.noteRunId(second, "run-2");
    await held;
    expect(streams.removableRunIds(removed)).toEqual(["run-1", "run-2"]);
  });

  it("the registry's footprint is unchanged by a hold that settled", async () => {
    // A waiter is transient state, not per-id state: `retainedIdCount` is still
    // the whole footprint, which is the invariant the cap arms rest on.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", controller(), "u2");
    const held = streams.settleRunIdsForRemoval(removing("u2"));
    streams.noteRunId(token, "run-1");
    await held;
    streams.end(token);
    streams.noteSavedTranscript([{ id: "a1" }]);
    expect(streams.retainedIdCount()).toBe(0);
  });
});
