// ---------------------------------------------------------------------------
// The relative time a marketplace approval row draws on its meta line
// ("submitted 3 days ago"), read from unchecked JSON (cinatra#4296).
//
// The marketplace client only casts what the marketplace returns, so a row's
// time stamp can arrive missing, malformed or of another type. date-fns throws
// a RangeError on an invalid date, so such a stamp must never reach it: this
// reader gives no text, and the row draws its meta line without the time and
// still renders. Shared by the two extension-submission sources.
// ---------------------------------------------------------------------------
import { formatDistanceToNow } from "date-fns";

/** "<distance> ago" for a stamp string Date.parse reads, else null. */
export function relativeTimeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatDistanceToNow(new Date(time), { addSuffix: true }) : null;
}
