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
 * The ledger is therefore bounded by turns that ended without revealing — a
 * user's stop presses in one page session — and is dropped wholesale on a thread
 * switch, because its ids belong to the thread they streamed in and nothing in
 * another thread's transcript would ever release them.
 */

/** The ids of the turns in one page's registry, in the two states it tracks. */
export type TurnStreamRegistry = {
  /** Register an in-flight turn. Call from inside the drive's `try`, so the
   *  matching `end` in its `finally` is guaranteed. */
  begin(assistantId: string, controller: AbortController): void;
  /** The turn's stream is over. Returns whether it WAS in flight, so the caller
   *  can keep its own count in step; idempotent otherwise. The id moves to the
   *  ledger — it is still nameable until the transcript proves it landed. */
  end(assistantId: string): boolean;
  /** Is this turn streaming right now? (the message list's live indicator) */
  has(assistantId: string): boolean;
  /** How many turns are in flight. */
  size(): number;
  /** Abort every in-flight turn, leaving the registry populated — each drive's
   *  own `finally` calls `end`. The composer's Stop button. */
  abortAll(): void;
  /** Abort everything and forget it — including the ledger, whose ids belong to
   *  the thread being left. The thread switch. */
  reset(): void;
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
  /** Ended, and not yet seen in a committed transcript. */
  const endedUncommitted = new Set<string>();

  return {
    begin(assistantId, controller) {
      inFlight.set(assistantId, controller);
    },
    end(assistantId) {
      const wasInFlight = inFlight.delete(assistantId);
      // Unconditional, and deliberately not gated on `wasInFlight`: a turn
      // aborted through `reset()` has already left the map, and it is exactly
      // the turn whose reveal never came.
      if (typeof assistantId === "string" && assistantId.length > 0) {
        endedUncommitted.add(assistantId);
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
      for (const controller of inFlight.values()) controller.abort();
    },
    reset() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      endedUncommitted.clear();
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
