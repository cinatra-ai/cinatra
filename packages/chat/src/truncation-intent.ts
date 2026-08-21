/**
 * The TRUNCATION INTENT — pure, so the reach it promises is testable without the
 * page (`packages/chat/src/message-edit-flow.ts` is its one caller).
 */
import type { UiMessage as Message } from "./types";

/**
 * THE TRUNCATION INTENT: the message ids this edit ASSERTS it removed.
 *
 * It has to be CARRIED rather than inferred: every other save posts the whole
 * transcript too, and one from a tab whose transcript PREDATES a turn omits that
 * turn without ever having had it. "Absent from the payload" cannot tell those
 * apart; only the writer knows which it is, and only here is it a removal.
 *
 * IT MUST ALSO REACH A TURN THAT IS STILL STREAMING. In Slack mode the assistant
 * turn is a whole-turn ATOMIC REVEAL — `driveAssistantChatTurn` appends it to the
 * transcript only when the turn completes — and Slack mode is exactly the mode
 * that ALLOWS editing while a stream is in flight (concurrent streams are the
 * point). So the transcript this edit truncates does not yet contain the turn
 * that is about to land in it, and an intent built from the transcript alone
 * cannot NAME that turn.
 *
 * Naming it is what the tombstone needs. The in-flight turn's run-bound row is
 * already durable — the row is minted when the run STARTS — and the turn reveals
 * BELOW the edit point, into a transcript that has been truncated out from under
 * it. Unnamed, it is a turn the save removed but asserted nothing about, so the
 * reload folds it back in above the edited prompt: the removed turn returns,
 * permanently, which is the exact defect this leg exists to remove.
 *
 * AND IT MUST REACH A TURN WHOSE STREAM HAS JUST ENDED. The drive's cleanup runs
 * in a `finally`, synchronously after the reveal's `setMessages` is queued and
 * before React commits it — so a turn can be gone from the in-flight registry
 * while the render's `messages` snapshot still predates its reveal. Read from
 * those two sources alone it is in NEITHER, and it goes unnamed. `removableTurnIds`
 * is therefore the registry's OWN union of in-flight and ended-but-uncommitted
 * turns (`./turn-stream-registry`), which releases an id only once a committed
 * transcript carries it.
 *
 * Every such turn is a successor of the edit point (a revealed turn appends to
 * the tail, and the tail is at or below `fromIndex` once the edit truncates), so
 * the whole set is named. Ids are de-duplicated and order is the transcript's,
 * then the registry's — the server treats the intent as a SET. Over-naming is the
 * safe direction: the tombstone intersects the intent with the rows the payload
 * no longer carries, so an id it cannot match simply does nothing.
 */
export function buildTruncationIntent(
  messages: Message[],
  fromIndex: number,
  removableTurnIds: Iterable<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages.slice(fromIndex)) {
    if (typeof message.id !== "string" || message.id.length === 0) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    ids.push(message.id);
  }
  for (const id of removableTurnIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * THE STREAMING HALF OF THE SAME INTENT: the RUN IDS this edit asserts it
 * removed.
 *
 * NAMING A TURN IS NOT THE SAME AS THE SERVER BEING ABLE TO ACT ON THE NAME.
 * Every id above is minted in the page, and the server's link from such an id to
 * the run-bound row that survives a truncation runs THROUGH the turn's mirror
 * row — the row a whole-transcript save writes. A turn that never reached a saved
 * transcript never had one, which is precisely the turn shape `removableTurnIds`
 * exists to name: one still streaming, one whose reveal has not committed, one
 * aborted. For those the message id asserts a name the server has never seen, and
 * the removed turn folds back in above the edited prompt anyway.
 *
 * The identity those turns really do share with the server is the RUN ID, minted
 * by the turn route and delivered on the wire. So the registry keeps it beside
 * the id under the same release rule (`./turn-stream-registry`), and this is what
 * the save carries as `removedRunIds`.
 *
 * The transcript slice contributes NOTHING here on purpose: a turn the transcript
 * carries is removed through its mirror row, which is the narrower, payload-
 * intersected path. This assertion is only ever about the turns that have no such
 * row. Deduplicated; the server treats it as a SET.
 */
export function buildRemovedRunIntent(removableRunIds: Iterable<string>): string[] {
  const runIds: string[] = [];
  const seen = new Set<string>();
  for (const runId of removableRunIds) {
    if (typeof runId !== "string" || runId.length === 0) continue;
    if (seen.has(runId)) continue;
    seen.add(runId);
    runIds.push(runId);
  }
  return runIds;
}
