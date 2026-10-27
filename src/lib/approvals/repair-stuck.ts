// ---------------------------------------------------------------------------
// The repair data of a vendor application, read from unchecked JSON
// (cinatra#4296).
//
// The marketplace client only casts what the marketplace returns (its
// structured content is handed back `as` the declared output type), and the
// local identity store casts its persisted row the same way. A field declared
// `string | null` or `number` can therefore arrive missing, empty, malformed or
// of another type. These readers accept a well-formed value only; anything
// else means "not stuck" or "no count", never a guess.
//
//   stuck    = `repair_stuck_at` is a timestamp string: a calendar date first,
//              optionally a time, that Date.parse reads, and whose written
//              fields name a real date and time (Date.parse rolls 2026-02-30
//              over to March 2; that is not a timestamp). Missing, null, empty,
//              invalid, calendar-invalid or a non-string all mean NOT stuck.
//   attempts = `recovery_attempts` is a non-negative safe integer of type
//              number. A fraction, a string, NaN, an infinity or an unsafe
//              integer means no count; the flag still stands without one.
//
// "Stuck" is represented apart from the optional count, so a source that knows
// only the stamp (the instance's own application status) still draws the
// Failed pill. Pure, so the sources, the feed view model and the environment
// card share one reading.
// ---------------------------------------------------------------------------

/** The public repair field of an approval row. Present only when stuck. */
export type RepairStuck = {
  /** The attempt count, present only when it is a non-negative safe integer. */
  attempts?: number;
};

// A calendar date (year, month, day), then the end of the text, or a time part
// that starts with hours and minutes.
const DATE_FIRST = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ](\d{2}):\d{2})/;

/**
 * True when the written year, month and day name a real calendar day: built
 * back as a UTC date, they give the same three fields. 2026-02-30, 2025-02-29
 * and 2026-04-31 roll over to another day, so they are not calendar days.
 */
function isCalendarDay(year: number, month: number, day: number): boolean {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * True only for a timestamp string the stuck flag can mean. Date.parse itself
 * refuses a minute or a second of 60, but it reads hour 24 as midnight of the
 * next day, so an hour above 23 is refused here.
 */
export function isRepairStuckStamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_FIRST.exec(value);
  if (m === null || !Number.isFinite(Date.parse(value))) return false;
  if (m[4] !== undefined && Number(m[4]) > 23) return false;
  return isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** A worker-incremented counter: a non-negative safe integer of type number. */
export function repairAttemptCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** The public repair field from the stamp and the optional count. */
export function toRepairStuck(stamp: unknown, attempts?: unknown): RepairStuck | undefined {
  if (!isRepairStuckStamp(stamp)) return undefined;
  const count = repairAttemptCount(attempts);
  return count === undefined ? {} : { attempts: count };
}

/**
 * A copy of a row's public repair field for a view model: only a validated
 * count is copied, never another key. A value that is not an object is not a
 * repair field, so it means not stuck.
 */
export function copyRepairStuck(value: unknown): RepairStuck | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const count = repairAttemptCount((value as { attempts?: unknown }).attempts);
  return count === undefined ? {} : { attempts: count };
}

/** A text field a row draws: a non-empty string, else null. */
export function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
