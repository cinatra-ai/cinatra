/**
 * THE PAGE'S TURN REGISTRY — which turns are in flight, and which have ENDED but
 * are not provably in the transcript yet (cinatra#2823 S9j).
 *
 * It was a bare `Map<assistantId, AbortController>` in `chat-page.tsx`, read by
 * the truncation intent as "every turn this edit must also name". That read had
 * a hole, and the hole is why this is a module with a name.
 *
 * ── THE ZERO-SOURCE WINDOW ───────────────────────────────────────────────────
 *
 * `editAndResend` names a removed turn from TWO sources: the render's `messages`
 * snapshot, and the in-flight registry. Both can miss the same turn at once.
 *
 * A Slack turn is a whole-turn ATOMIC REVEAL — `driveAssistantChatTurn` appends
 * the assistant message when the turn COMPLETES — and the drive's cleanup runs in
 * a `finally`, synchronously after that append is QUEUED and before React has
 * committed it. So there is a window in which:
 *
 *   · the reveal's `setMessages` has not committed, so the still-mounted render
 *     the user is clicking in holds a `messages` snapshot WITHOUT the turn; and
 *   · the controller is already gone from the in-flight registry.
 *
 * An edit dispatched in that window sees the turn in NEITHER source. It goes
 * unnamed, the save asserts nothing about it, and its run-bound row — minted when
 * the run STARTED, and untouchable by the reconcile DELETE — folds back in above
 * the edited prompt on the next reload. The removal is undone, permanently: the
 * exact defect the truncation intent exists to prevent, arriving through the one
 * gap between its two sources.
 *
 * The same window, held open indefinitely, is an ABORTED stream: the drive is cut
 * before it reveals, so the turn never enters the transcript at all while its
 * run-bound row still holds foldable state.
 *
 * ── THE CLOSE: AN ID LEAVES ONLY WHEN THE TRANSCRIPT PROVABLY HAS IT ─────────
 *
 * Ending a stream no longer drops the turn from what the intent can name. It
 * moves the id to a ledger that `removableTurnIds()` unions in, and the ledger
 * releases an id on ONE event only: a committed transcript that contains it
 * (`noteCommittedTranscript`, driven from the page's `messages` effect, which by
 * definition runs after the commit). So the two states are exhaustive rather than
 * adjacent — a turn is in flight, or it is in the transcript, or it is named by
 * the ledger — and there is no instant at which it is in none of them.
 *
 * WHY OVER-NAMING IS THE SAFE DIRECTION HERE, and why the ledger may hold an id
 * that is never released (an aborted turn reveals nothing, so no transcript ever
 * carries it). The intent can only ever NARROW what the server removes: the
 * tombstone intersects the asserted ids with the rows the payload no longer
 * carries (`buildSupersedeRunBoundTurnsQuery`), so an id naming a message that is
 * still in the payload is excluded by the kept-id filter, and an id naming a turn
 * that never had a mirror row matches no removed row and does nothing. Under-
 * naming loses a turn's removal forever; over-naming costs an id in a payload.
 *
 * ── THE TWO EDGES OF THE LEDGER: THE THREAD, AND THE BOUND ───────────────────
 *
 * The ledger's ids belong to the THREAD they streamed in — nothing in another
 * thread's transcript would ever release them, and an edit made over there must
 * not assert removals about turns that streamed somewhere else. So the thread is
 * the ledger's boundary, and `resetForThread` is where it is drawn: the registry
 * holds the thread its ids belong to, and a different one drops everything. It is
 * NOT the stream count that decides this. An ended turn stays nameable until its
 * reveal commits, so the ledger OUTLIVES the last stream — a page that dropped it
 * only when something happened to be in flight carried it across every ordinary
 * switch (codex round 2, finding 2).
 *
 * The same reasoning binds a LATE `end`. `reset` aborts the in-flight streams,
 * but each drive unwinds on its own schedule and its `finally` calls `end`
 * afterwards, with an id belonging to the thread that was left. Every turn
 * therefore carries the GENERATION it began in, `reset` bumps that generation,
 * and an `end` from a stale one writes nothing (codex round 2, finding 1).
 *
 * And the ledger is CAPPED. Its natural size is a user's stop presses in one page
 * session, but "natural" is not a bound: an aborted turn is released by nothing,
 * so without a cap one long session grows every later edit's payload without
 * limit (codex round 2, finding 3). See `MAX_ENDED_UNCOMMITTED_TURN_IDS` and the
 * eviction site for what the bound costs.
 */

/**
 * The ledger's hard cap: how many ENDED-but-uncommitted turn ids one thread's
 * registry keeps at once. One entry is one turn that ended without a committed
 * transcript ever carrying it — in practice one stop press, or one turn cut by a
 * lost connection. 256 of those in a single thread, with no reload and not one of
 * them landing, is far past any real session; what the number buys is that the
 * ledger (and every edit payload that unions it in) is BOUNDED rather than
 * session-lifetime. The eviction site states what going over it costs.
 */
export const MAX_ENDED_UNCOMMITTED_TURN_IDS = 256;

/** The ids of the turns in one page's registry, in the two states it tracks. */
export type TurnStreamRegistry = {
  /** Register an in-flight turn. Call from inside the drive's `try`, so the
   *  matching `end` in its `finally` is guaranteed. */
  begin(assistantId: string, controller: AbortController): void;
  /** The turn's stream is over. Returns whether it WAS in flight, so the caller
   *  can keep its own count in step; idempotent otherwise. The id moves to the
   *  ledger — it is still nameable until the transcript proves it landed —
   *  UNLESS the turn began before a `reset`, in which case it belongs to a
   *  thread this registry has left and nothing is recorded. */
  end(assistantId: string): boolean;
  /** Is this turn streaming right now? (the message list's live indicator) */
  has(assistantId: string): boolean;
  /** How many turns are in flight. Deliberately NOT a proxy for "the registry is
   *  empty": the ledger outlives every stream in it. */
  size(): number;
  /** Abort every in-flight turn, leaving the registry populated — each drive's
   *  own `finally` calls `end`. The composer's Stop button. */
  abortAll(): void;
  /** Abort everything and forget it — including the ledger, whose ids belong to
   *  the thread being left. Prefer `resetForThread`, which draws that boundary
   *  where it belongs. */
  reset(): void;
  /** THE THREAD BOUNDARY. Reset iff this is a different thread from the one the
   *  registry is holding, and report whether it did (the page's streaming count
   *  follows). The FIRST thread observed is adopted rather than switched to. */
  resetForThread(threadId: string | null): boolean;
  /** A COMMITTED transcript landed: every turn it carries is now nameable from
   *  the transcript itself, so the ledger releases those ids. */
  noteCommittedTranscript(messages: ReadonlyArray<{ id?: unknown }>): void;
  /** Every turn an edit must name BESIDE the ones in its own transcript slice:
   *  the in-flight turns and the ended-but-uncommitted ones. */
  removableTurnIds(): string[];
};

export function createTurnStreamRegistry(): TurnStreamRegistry {
  /** assistantId → AbortController, for every turn currently streaming. */
  const inFlight = new Map<string, AbortController>();
  /** Ended, and not yet seen in a committed transcript. Insertion-ordered, which
   *  is what makes "evict the oldest" meaningful at the cap. */
  const endedUncommitted = new Set<string>();
  /** Bumped by every reset. A turn that BEGAN in an older generation belongs to
   *  a thread this registry has left. */
  let generation = 0;
  /** assistantId → the generation it began in, for exactly those turns whose
   *  `end` is still owed. Each entry is dropped by that `end`, so this holds one
   *  entry per unfinished drive and no history. */
  const beganIn = new Map<string, number>();
  /** The thread these ids belong to, once one has been observed. */
  let heldThreadId: string | null = null;
  let threadObserved = false;

  /** Record an ended turn under the ledger's cap. */
  function rememberEnded(assistantId: string): void {
    if (!endedUncommitted.has(assistantId) && endedUncommitted.size >= MAX_ENDED_UNCOMMITTED_TURN_IDS) {
      // THE EVICTION, AND WHAT IT COSTS — stated here, at the line that actually
      // drops a nameable removal, rather than left to the constant.
      //
      // The OLDEST id goes. An evicted id is re-assertable NEVER: no edit can
      // name it again, so its run-bound row can fold back in above a later
      // edited prompt — the same permanent undo this ledger exists to prevent,
      // for that one turn. That is the honest price of a bound, and it is taken
      // only past 256 turns that ended without a single one of them landing in a
      // committed transcript, in one thread, with no reload. The alternative is
      // not "no cost": an unbounded ledger puts every id a long session ever
      // aborted into every edit payload for the rest of that session. Oldest
      // first, because an edit made now is a statement about the turns nearest
      // it, and the oldest id is the one whose reveal has been outstanding
      // longest — the least likely to still be about the transcript on screen.
      const oldest = endedUncommitted.values().next().value;
      if (typeof oldest === "string") endedUncommitted.delete(oldest);
    }
    endedUncommitted.add(assistantId);
  }

  function resetAll(): void {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    endedUncommitted.clear();
    // Every turn still owing an `end` now owes it from a STALE generation: the
    // drives keep unwinding after this returns, and their `finally` must not
    // write the thread that was left into the ledger of the thread that
    // replaced it.
    generation += 1;
  }

  return {
    begin(assistantId, controller) {
      inFlight.set(assistantId, controller);
      beganIn.set(assistantId, generation);
    },
    end(assistantId) {
      const wasInFlight = inFlight.delete(assistantId);
      const startedIn = beganIn.get(assistantId);
      beganIn.delete(assistantId);
      // A LATE END FROM A THREAD THIS REGISTRY HAS LEFT. `reset` aborted the
      // stream, but the drive unwound afterwards and this is its `finally`.
      // Recording the id would repopulate the NEW thread's ledger with a
      // foreign one, and the next edit over here would ASSERT it: on a
      // collision the server tombstones a turn of this thread that nobody
      // removed, and without one it is stale in every payload until the next
      // switch. The turn it names is gone with its thread; nothing here can say
      // anything true about it.
      if (startedIn !== undefined && startedIn !== generation) return wasInFlight;
      // Otherwise unconditional, and deliberately not gated on `wasInFlight`: an
      // id can leave the map before its drive unwinds, and the turn whose reveal
      // never came is exactly the one the ledger has to keep.
      if (typeof assistantId === "string" && assistantId.length > 0) {
        rememberEnded(assistantId);
      }
      return wasInFlight;
    },
    has(assistantId) {
      return inFlight.has(assistantId);
    },
    size() {
      return inFlight.size;
    },
    abortAll() {
      // NOT a generation bump: the Stop button does not leave the thread. Each
      // aborted turn is ended by its own drive, into this same ledger, and
      // stays nameable — that is the whole point of stopping one.
      for (const controller of inFlight.values()) controller.abort();
    },
    reset() {
      resetAll();
    },
    resetForThread(threadId) {
      // The first observation ADOPTS: a fresh registry holds nothing, and its
      // page mounts on whatever thread the URL named. (It also keeps React's
      // double-invoked mount effect from aborting what the first run started.)
      const changed = threadObserved && heldThreadId !== threadId;
      threadObserved = true;
      heldThreadId = threadId;
      if (changed) resetAll();
      return changed;
    },
    noteCommittedTranscript(messages) {
      if (endedUncommitted.size === 0) return;
      for (const message of messages) {
        const id = message?.id;
        if (typeof id === "string") endedUncommitted.delete(id);
      }
    },
    removableTurnIds() {
      const ids: string[] = [];
      for (const id of inFlight.keys()) ids.push(id);
      for (const id of endedUncommitted) if (!inFlight.has(id)) ids.push(id);
      return ids;
    },
  };
}
