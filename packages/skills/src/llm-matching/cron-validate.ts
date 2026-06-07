/**
 * Defense-in-depth validation for the skill-match scheduler cron expression.
 *
 * Both the MCP handler (`skills_match_schedule_set`) and the `writeSchedule()`
 * store function must reject malformed scheduler strings before forwarding
 * them to BullMQ's `upsertJobScheduler()`. A malformed expression can survive
 * to disk; the next boot-time `registerSkillMatchScheduleAtBoot()` re-registers
 * the bad row, BullMQ rejects it again, and the system silently stays in
 * "scheduler scheduled but won't run" state — invisible until an admin notices
 * missing batch runs days later.
 *
 * This module hand-rolls a tight 5-or-6-field cron validator. Hand-rolled
 * rather than reaching for `cron-parser` because:
 *   - `cron-parser` is a workspace dep of `@cinatra-ai/agents`, not `@cinatra-ai/skills`.
 *   - Adding it as a `@cinatra-ai/skills` dependency expands the package's install
 *     graph for a 30-line guard.
 *   - BullMQ itself uses a similar internal validator; the goal here is to
 *     reject obviously-malformed input BEFORE it reaches BullMQ so callers
 *     get a clear error code instead of a generic library exception.
 *
 * The grammar matches POSIX cron + the common Quartz 6-field variant
 * (seconds-leading). Each field accepts:
 *   - `*`                  — any value
 *   - `N`                  — a single integer literal
 *   - `N-N`                — a range
 *   - `N,N(,N)*`           — a comma list
 *   - `*\/N`               — step from start
 *   - `N\/N`               — step from offset
 *   - `N-N\/N`             — step within range
 *
 * We deliberately do NOT validate the per-field integer bounds (minute 0-59
 * etc.); BullMQ's downstream cron parser handles that and this function is
 * called BEFORE the row is persisted, so a value that survives the regex
 * but BullMQ rejects still triggers the normal upsertJobScheduler error
 * path — but the obvious garbage cases (random punctuation, wrong field
 * count) are caught here, where we can return a friendlier error code.
 */

const CRON_FIELD_PATTERN =
  /^(?:\*|\d+(?:-\d+)?|\d+(?:,\d+)+|\*\/\d+|\d+\/\d+|\d+-\d+\/\d+)$/;

// Per-field integer bounds. 5-field POSIX: minute, hour, day-of-month, month,
// day-of-week. 6-field Quartz variant: seconds-leading.
// Shape-only regex validation accepts out-of-range expressions such as
// 99 99 * * * and 0 24 * * *. BullMQ rejects these post-persistence and the
// handler can swallow the registration error, leaving the row disabled until
// admin notices missing batch runs. Validate ranges BEFORE persistence.
const FIELD_BOUNDS_5 = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (0 and 7 both Sunday)
] as const;
const FIELD_BOUNDS_6 = [
  { min: 0, max: 59 }, // seconds
  ...FIELD_BOUNDS_5,
] as const;

function fieldNumbers(field: string): number[] {
  const out: number[] = [];
  for (const part of field.split(",")) {
    if (part === "*") continue;
    const [headRaw] = part.split("/");
    const head = headRaw ?? "";
    if (head === "*" || head === "") continue;
    if (head.includes("-")) {
      const [lo, hi] = head.split("-").map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [Number.NaN];
      out.push(lo, hi);
    } else {
      const n = Number.parseInt(head, 10);
      if (!Number.isFinite(n)) return [Number.NaN];
      out.push(n);
    }
  }
  return out;
}

/**
 * Hand-rolled cron-expression syntactic + semantic validator.
 *
 * @returns `true` if `expr` is a 5- or 6-field cron pattern with all numeric
 *          atoms in range for their field. `false` otherwise.
 */
export function isValidCronExpression(expr: unknown): expr is string {
  if (typeof expr !== "string") return false;
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;

  const bounds = fields.length === 6 ? FIELD_BOUNDS_6 : FIELD_BOUNDS_5;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!CRON_FIELD_PATTERN.test(field)) return false;
    const { min, max } = bounds[i];
    for (const n of fieldNumbers(field)) {
      if (!Number.isFinite(n) || n < min || n > max) return false;
    }
  }
  return true;
}
