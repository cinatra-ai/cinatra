import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { baseReviewTaskId, isDeclaredReviewTaskId } from "@/lib/artifacts/artifact-review-target";

/**
 * cinatra#4312 — a review gate's created time in microseconds since the epoch, as
 * decimal text. The store keeps `created_at` in microseconds; a JavaScript date
 * keeps milliseconds, so two gates in one millisecond read as equal there. The
 * stores that feed `laterDeclaredPause` select this beside `created_at`.
 */
export function createdAtMicrosSql(column: AnyColumn): SQL<string> {
  return sql<string>`(floor(extract(epoch from ${column}))::bigint * 1000000 + floor(extract(microseconds from ${column}))::bigint % 1000000)::text`;
}

type GateTime = { reviewTaskId: string; createdAt?: Date | null; createdAtMicros?: string | null };

const MICROS = /^\d{1,20}$/;

/** A gate's created time as 20-digit microsecond text, or null when it cannot be read. */
function timeKey(g: GateTime): string | null {
  if (g.createdAtMicros !== undefined && g.createdAtMicros !== null) {
    return typeof g.createdAtMicros === "string" && MICROS.test(g.createdAtMicros) ? g.createdAtMicros.padStart(20, "0") : null;
  }
  const ms = g.createdAt instanceof Date ? g.createdAt.getTime() : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? `${Math.trunc(ms)}000`.padStart(20, "0") : null;
}

/**
 * cinatra#4312 — has the run gone on to another pause after the declared review
 * that `reviewTaskId` belongs to? `gates` are the run's review gates, as the
 * caller read them.
 *
 * A gate of another declared review (a `wayflow-` task id with another base task
 * id) that is NOT OLDER than the newest gate of this review is read as a later
 * pause: a later created time, and an equal one too. An equal time cannot tell
 * the order of two pauses, so it is read as later. Times are compared in
 * microseconds when the caller gives `createdAtMicros` (both stores do,
 * `createdAtMicrosSql`), else as JavaScript dates, in milliseconds.
 *
 * The check fails closed: when the run has another declared review, a time it
 * cannot read (missing, null or an invalid date, or microseconds that are no
 * decimal text, on either side) and a missing gate of this review are read as a
 * later pause too, so the decision is closed without a send rather than sent
 * into a pause that may be later. The stored `created_at` is NOT NULL, so the
 * store gives no such row. A run with no other declared review has no later
 * pause: false.
 *
 * Read at two places: by the close that inserts a carrier
 * (`carryDeclaredReviewDecision`, under the run row lock), and by the resume
 * worker before it sends a declared review's decision. The second read sees a
 * later review whose gates were committed after the close read the run's gates;
 * neither sees a later review whose gates are committed after its own read.
 */
export function laterDeclaredPause(gates: readonly GateTime[], reviewTaskId: string): boolean {
  const base = baseReviewTaskId(reviewTaskId);
  const others = gates.filter((g) => isDeclaredReviewTaskId(g.reviewTaskId) && baseReviewTaskId(g.reviewTaskId) !== base);
  if (others.length === 0) return false;
  const own = gates.filter((g) => baseReviewTaskId(g.reviewTaskId) === base).map(timeKey);
  if (own.length === 0 || own.some((t) => t === null)) return true;
  const newest = (own as string[]).reduce((a, b) => (b > a ? b : a));
  return others.some((g) => {
    const t = timeKey(g);
    return t === null || t >= newest;
  });
}
