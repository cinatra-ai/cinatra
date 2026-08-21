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
 * Every in-flight turn is a successor of the edit point (a revealed turn appends
 * to the tail, and the tail is at or below `fromIndex` once the edit truncates),
 * so the whole in-flight set is named. Ids are de-duplicated and order is the
 * transcript's, then the streams' — the server treats the intent as a SET.
 */
export function buildTruncationIntent(
  messages: Message[],
  fromIndex: number,
  streamingAssistantIds: Iterable<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages.slice(fromIndex)) {
    if (typeof message.id !== "string" || message.id.length === 0) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    ids.push(message.id);
  }
  for (const id of streamingAssistantIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
