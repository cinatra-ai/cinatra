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
//   stuck    = `repair_stuck_at` is a timestamp string: a calendar date,
//              optionally a time with its offset, that Date.parse reads as the
//              same written year, month, day, hour and minute (Date.parse rolls
//              2026-02-30 over to March 2, and reads 0001-01-01 00:00:00+00:00
//              as 2001; neither is a timestamp). Missing, null, empty, invalid,
//              calendar-invalid or a non-string all mean NOT stuck.
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

// The written stamp: a calendar date, then optionally a time (T or a space,
// hours and minutes, optional seconds and fraction) that must carry its offset
// (Z, +hh, +hhmm or +hh:mm, or the same with -). Nothing else may follow.
const STAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?))?$/;

/** The written offset in minutes east of UTC. */
function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const digits = offset.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0");
  return offset[0] === "-" ? -minutes : minutes;
}

/**
 * True only for a timestamp string the stuck flag can mean: it has the written
 * form above, Date.parse reads it, and the instant Date.parse reads, moved by
 * the written offset (a date alone is UTC midnight), gives back exactly the
 * written year, month, day, hour and minute. Date.parse rolls a day that does
 * not exist (2026-02-30) and hour 24 over to another day, and reads a year
 * 0000-0099 written before a space as a year of 1950-2049; none of these
 * round-trips, so none is a stamp.
 */
export function isRepairStuckStamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = STAMP.exec(value);
  if (m === null) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const [, year, month, day, hour = "00", minute = "00", offset = "Z"] = m;
  const read = new Date(time + offsetMinutes(offset) * 60_000);
  return (
    read.getUTCFullYear() === Number(year) &&
    read.getUTCMonth() + 1 === Number(month) &&
    read.getUTCDate() === Number(day) &&
    read.getUTCHours() === Number(hour) &&
    read.getUTCMinutes() === Number(minute)
  );
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
