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
 * ── THE INSTANCE TOKEN: A TURN ID IS NOT AN IDENTITY ─────────────────────────
 *
 * An assistant id is REUSABLE. The page mints a fresh one per dispatch, but a
 * retry, a replayed dispatch or a restored transcript can put the same id in
 * flight twice, and the two are different turns with different drives. Keying
 * `end` on the id made the second one collateral of the first:
 *
 *   `begin("x")` · `reset()` · `begin("x")` · `end("x")` ← the FIRST drive's
 *   `finally`, arriving late
 *
 * — that `end` deleted the SECOND drive's controller (its turn silently stopped
 * being nameable as in-flight, and the page's streaming count went out of step)
 * and recorded "x" into a ledger the first drive has no business writing to
 * (codex round 3, finding 1).
 *
 * So `begin` mints an INSTANCE TOKEN and returns it, and `end` takes that token.
 * The drive's `finally` closes over its OWN token and never over the id. `end`
 * acts only while that exact instance is still the registered one — a reference
 * comparison, no lookup by the reusable id anywhere — and is otherwise a total
 * no-op: it moves no controller, records nothing and reports `false`.
 *
 * ── THE RUN ID: THE ONLY IDENTITY THE SERVER SHARES WITH THESE TURNS ─────────
 *
 * Naming a turn is not the same as the server being able to ACT on the name. An
 * assistant id is minted HERE, in the page, and a turn that never entered a saved
 * transcript left no row anywhere carrying it — so an edit that asserts the
 * removal of such a turn asserts a name the server has never seen, and the
 * run-bound row the reload folds back in is untouched by it. That is the residual
 * the ledger alone cannot close.
 *
 * The identity both sides genuinely hold is the RUN ID: minted by the turn route,
 * delivered to this page on the wire (`RUN_STARTED`), and the run-bound row's own
 * column. So the registry records it per turn instance (`noteRunId`) and offers
 * it beside the ids (`removableRunIds`), under exactly the release discipline the
 * ids get — a run id leaves when its turn's id does, i.e. when a committed
 * transcript proves the turn landed and the ordinary mirror-row key takes over.
 * `noteRunId` is gated on the INSTANCE TOKEN for the same reason `end` is: a late
 * drive must never stamp its run onto the turn that is wearing its id now.
 *
 * A turn whose run id never arrived (aborted before `RUN_STARTED`, or a wire that
 * carried none) simply contributes no run id. It is still named by its id, and
 * the server still has nothing to key on for it — the honest residual, and a
 * strictly smaller one than before.
 *
 * ── WHY THE RUN IDS ARE ANCHORED, AND THE IDS ARE NOT ────────────────────────
 *
 * "Over-naming is the safe direction" is the argument the ID union rests on, and
 * it is TRUE THERE for one reason only: a bubble id the server cannot link to a
 * row does nothing. A RUN ID is different — it names the run-bound row outright
 * — so the same union offered as run ids would not be safe, and this is not a
 * hypothetical. Slack mode runs turns CONCURRENTLY: a turn dispatched for an
 * EARLIER prompt can still be streaming while the user edits a LATER one, and
 * the ledger holds it for the same reason it holds any uncommitted turn. Named
 * as a run, that turn — whose prompt the user KEPT — would be tombstoned
 * permanently by an edit that had nothing to do with it.
 *
 * So a run is offered only when the turn's ANCHOR — the prompt it was dispatched
 * to answer, recorded at `begin` — is itself among the messages the edit removed.
 * That is the property "this turn is below the edit point" stated as something
 * the registry can actually check, instead of assumed. A turn with NO anchor is
 * not offered either: for run ids the fail-closed direction is under-naming,
 * because a missed removal costs a turn that folds back in and a wrong one costs
 * a kept turn its card forever.
 *
 * ── THE INSTANCE TOKEN, CONTINUED ────────────────────────────────────────────
 *
 * THE INSTANCE *IS* THE GENERATION, which is why there is no generation counter
 * here any more. Every `begin` mints a fresh object, so "the same id, one drive
 * later" and "the same id, one thread later" are both simply a different token
 * than the registered one, and so is a token from another registry entirely.
 * That subsumes the generation check exactly, and it costs no per-id bookkeeping
 * to maintain: the previous round carried a `beganIn` map so a late `end` could
 * look up the generation its id started in, and a drive that never reached its
 * `finally` left that entry behind forever, across every thread switch (codex
 * round 3, finding 2). A token needs no such map. The registry's WHOLE footprint
 * is now the in-flight map plus the capped ledger — see `retainedIdCount`.
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

/**
 * THE HANDLE ON ONE REGISTERED TURN INSTANCE, minted by `begin` and consumed by
 * `end`. Opaque on purpose: the only thing a caller may do with it is hand it
 * back. Its IDENTITY is the whole mechanism — two `begin` calls with the same
 * assistant id mint two different tokens, and `end` acts only for the one that
 * is still registered — so a drive must close over its own token and must never
 * reconstruct one from an id.
 */
export type TurnStreamToken = {
  /** The turn this instance streams. Exposed for logging only: `end` never
   *  looks anything up by it. */
  readonly assistantId: string;
};

/** The ids of the turns in one page's registry, in the two states it tracks. */
export type TurnStreamRegistry = {
  /** Register an in-flight turn and return its INSTANCE TOKEN. Call from inside
   *  the drive's `try`, so the matching `end` in its `finally` is guaranteed,
   *  and let that `finally` close over the returned token — not over the id.
   *  `anchorMessageId` is the PROMPT this turn was dispatched to answer (the
   *  last message of its dispatch context); it is what lets `removableRunIds`
   *  tell a turn below an edit point from one above it. `null` when the caller
   *  has none, which withholds this turn's run from every intent. */
  begin(
    assistantId: string,
    controller: AbortController,
    anchorMessageId?: string | null,
  ): TurnStreamToken;
  /** This turn instance's stream is over. Acts only while `token` is still the
   *  registered instance for its id, and returns whether it was, so the caller
   *  can keep its own count in step. The id then moves to the ledger — it is
   *  still nameable until the transcript proves it landed. A token that has
   *  been superseded by a later `begin`, dropped by a `reset`, already ended,
   *  or minted by another registry does NOTHING and reports `false`. */
  end(token: TurnStreamToken): boolean;
  /** THE SERVER'S OWN NAME FOR THIS TURN, learned from the wire. Acts only while
   *  `token` is still the registered instance for its id — a late drive must not
   *  stamp its run onto whatever turn is wearing that id now — and returns
   *  whether it did. Recording the same run id twice is a no-op; the FIRST run
   *  observed for an instance is kept, because a resumed drive re-reports the run
   *  it is resuming and a retry that mints a second run is a second instance. */
  noteRunId(token: TurnStreamToken, runId: string): boolean;
  /** Is this turn streaming right now? (the message list's live indicator) */
  has(assistantId: string): boolean;
  /** How many turns are in flight. Deliberately NOT a proxy for "the registry is
   *  empty": the ledger outlives every stream in it. */
  size(): number;
  /** THE REGISTRY'S WHOLE FOOTPRINT: how many distinct ids it holds anything for
   *  at all — in-flight instances plus ledger entries, and by construction
   *  nothing else. This is the invariant that says the registry cannot grow
   *  without limit: the ledger is capped, the in-flight map holds one entry per
   *  live drive, and `reset`/`resetForThread` drop both. Read by the arms that
   *  pin it; there is no other per-id state for them to miss. */
  retainedIdCount(): number;
  /** Abort every in-flight turn, leaving the registry populated — each drive's
   *  own `finally` calls `end`. The composer's Stop button. */
  abortAll(): void;
  /** Abort everything and forget it — including the ledger, whose ids belong to
   *  the thread being left. Prefer `resetForThread`, which draws that boundary
   *  where it belongs. */
  reset(): void;
  /** THE THREAD BOUNDARY. Reset iff this is a different thread from the one the
   *  registry is holding, and report whether it did (the page's streaming count
   *  follows). The FIRST thread observed is adopted rather than switched to —
   *  but only if the registry is EMPTY at that moment. */
  resetForThread(threadId: string | null): boolean;
  /** A COMMITTED transcript landed: every turn it carries is now nameable from
   *  the transcript itself, so the ledger releases those ids. */
  noteCommittedTranscript(messages: ReadonlyArray<{ id?: unknown }>): void;
  /** Every turn an edit must name BESIDE the ones in its own transcript slice:
   *  the in-flight turns and the ended-but-uncommitted ones. */
  removableTurnIds(): string[];
  /** The RUN IDS the edit may act on — the identity the server can use for a turn
   *  no saved transcript ever carried. NARROWER than `removableTurnIds` on
   *  purpose: only a turn whose ANCHOR PROMPT is among `removedMessageIds` is
   *  offered, because a run id names the run-bound row outright and a turn
   *  dispatched for a prompt the edit KEPT must never be tombstoned. A turn with
   *  no anchor, or whose run id never arrived, contributes nothing. Deduplicated;
   *  the caller treats it as a SET. */
  removableRunIds(removedMessageIds: Iterable<string>): string[];
};

/** The registered instance: the token a caller holds, plus what the registry
 *  needs while that instance is live. */
type RegisteredTurn = {
  token: TurnStreamToken;
  controller: AbortController;
  /** The server's run for THIS instance, once the wire named one. */
  runId: string | null;
  /** The prompt this turn answers — its position claim, in the only currency
   *  the intent can check it against. */
  anchorId: string | null;
};

export function createTurnStreamRegistry(): TurnStreamRegistry {
  /** assistantId → the ONE registered instance for it, for every turn currently
   *  streaming. A second `begin` for the same id supersedes the first: the map
   *  holds one instance per id, and only that instance's token can end it. */
  const inFlight = new Map<string, RegisteredTurn>();
  /** Ended, and not yet seen in a committed transcript: assistantId → the run the
   *  turn streamed under and the prompt it answered (either may be null when the
   *  wire or the caller never named one). Insertion-ordered, which is what makes
   *  "evict the oldest" meaningful at the cap. */
  const endedUncommitted = new Map<string, { runId: string | null; anchorId: string | null }>();
  /** The thread these ids belong to, once one has been observed. */
  let heldThreadId: string | null = null;
  let threadObserved = false;

  /** Record an ended turn — and the run it streamed under — under the ledger's
   *  cap. */
  function rememberEnded(assistantId: string, runId: string | null, anchorId: string | null): void {
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
      const oldest = endedUncommitted.keys().next().value;
      if (typeof oldest === "string") endedUncommitted.delete(oldest);
    }
    endedUncommitted.set(assistantId, { runId, anchorId });
  }

  /** Is the registry holding anything at all? The two sets ARE its state — see
   *  `retainedIdCount` for why there is no third one to consult. */
  function isEmpty(): boolean {
    return inFlight.size === 0 && endedUncommitted.size === 0;
  }

  function resetAll(): void {
    for (const registered of inFlight.values()) registered.controller.abort();
    // Every token minted so far is now unregistered, so every late `end` that
    // follows is inert without anything having to be remembered about it. The
    // drives keep unwinding after this returns, and their `finally` must not
    // write the thread that was left into the ledger of the thread that
    // replaced it.
    inFlight.clear();
    endedUncommitted.clear();
  }

  return {
    begin(assistantId, controller, anchorMessageId) {
      const token: TurnStreamToken = { assistantId };
      const anchorId =
        typeof anchorMessageId === "string" && anchorMessageId.length > 0 ? anchorMessageId : null;
      inFlight.set(assistantId, { token, controller, runId: null, anchorId });
      return token;
    },
    noteRunId(token, runId) {
      // THE SAME ONE GATE `end` uses, and for the same reason: a drive whose
      // instance has been superseded, reset or already ended names a turn this
      // registry has moved past, and stamping its run onto the id's CURRENT
      // occupant would hand a later edit a run that belongs to another turn.
      const registered = token ? inFlight.get(token.assistantId) : undefined;
      if (!registered || registered.token !== token) return false;
      if (typeof runId !== "string" || runId.length === 0) return false;
      // FIRST RUN WINS. The drive reports the reduced state after every folded
      // event, so this is called many times per turn with the same value; a
      // resumed drive re-reports the run it resumed. Keeping the first observed
      // run makes those idempotent without the caller having to be careful.
      if (registered.runId !== null) return false;
      registered.runId = runId;
      return true;
    },
    end(token) {
      // THE ONE GATE, and it is reference identity. Not the id — an id is
      // reusable, and a late `end` looked up by one reaches whatever turn
      // happens to be wearing it now. A token that is not the registered
      // instance names a turn this registry has already moved past: it was
      // superseded by a later `begin` for the same id, or dropped by a `reset`
      // (its thread was left), or it already ended. In every one of those cases
      // the turn it names is gone and nothing here can say anything true about
      // it — so nothing is aborted, nothing is recorded and nothing is counted.
      const registered = token ? inFlight.get(token.assistantId) : undefined;
      if (!registered || registered.token !== token) return false;
      inFlight.delete(token.assistantId);
      // Unconditional from here: this instance really was the live one, and the
      // turn whose reveal never came is exactly the one the ledger has to keep.
      if (token.assistantId.length > 0)
        rememberEnded(token.assistantId, registered.runId, registered.anchorId);
      return true;
    },
    has(assistantId) {
      return inFlight.has(assistantId);
    },
    size() {
      return inFlight.size;
    },
    retainedIdCount() {
      let retained = inFlight.size;
      for (const id of endedUncommitted.keys()) if (!inFlight.has(id)) retained += 1;
      return retained;
    },
    abortAll() {
      // NOT a reset: the Stop button does not leave the thread, so the tokens
      // stay registered. Each aborted turn is ended by its own drive, into this
      // same ledger, and stays nameable — that is the whole point of stopping
      // one.
      for (const registered of inFlight.values()) registered.controller.abort();
    },
    reset() {
      resetAll();
    },
    resetForThread(threadId) {
      const firstObservation = !threadObserved;
      const switched = threadObserved && heldThreadId !== threadId;
      // THE FIRST OBSERVATION ADOPTS ONLY AN EMPTY REGISTRY. Adoption exists for
      // one situation — a fresh registry whose page mounts on whatever thread
      // the URL named holds nothing, so there is nothing to be wrong about — and
      // it is also what keeps React's double-invoked mount effect from aborting
      // what the first run started. State present at the FIRST observation is a
      // different situation entirely: those ids streamed before anything here
      // named a thread, so nothing can say they belong to this one, and adopting
      // them lets an edit on this thread assert removals about turns that ran
      // somewhere else (codex round 3, finding 4). Reset instead — the same
      // answer a switch gets, for the same reason.
      //
      // The double-mount protection is untouched by this: it is a SECOND
      // observation of the same thread, `threadObserved` is already true, and
      // that path still never resets however much is in flight.
      const dirtyFirstObservation = firstObservation && !isEmpty();
      threadObserved = true;
      heldThreadId = threadId;
      if (!switched && !dirtyFirstObservation) return false;
      resetAll();
      return true;
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
      for (const id of endedUncommitted.keys()) if (!inFlight.has(id)) ids.push(id);
      return ids;
    },
    removableRunIds(removedMessageIds) {
      // The turns `removableTurnIds` names, read for the other identity AND
      // FILTERED to the ones whose prompt this edit actually removed. The
      // in-flight instance's own record wins over a ledger entry under the same
      // id, for the same reason `removableTurnIds` skips the ledger entry there:
      // the live instance is the turn that id currently means.
      const removed = removedMessageIds instanceof Set ? removedMessageIds : new Set(removedMessageIds);
      const runIds: string[] = [];
      const seen = new Set<string>();
      const offer = (runId: string | null, anchorId: string | null) => {
        // NO ANCHOR IS NO CLAIM. A run whose turn cannot show it sits below the
        // edit point is withheld: for run ids the expensive mistake is naming a
        // turn the user kept, not missing one they removed.
        if (typeof anchorId !== "string" || anchorId.length === 0) return;
        if (!removed.has(anchorId)) return;
        if (typeof runId !== "string" || runId.length === 0 || seen.has(runId)) return;
        seen.add(runId);
        runIds.push(runId);
      };
      for (const registered of inFlight.values()) offer(registered.runId, registered.anchorId);
      for (const [id, rec] of endedUncommitted) if (!inFlight.has(id)) offer(rec.runId, rec.anchorId);
      return runIds;
    },
  };
}
