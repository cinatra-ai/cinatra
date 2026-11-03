import { baseReviewTaskId, isDeclaredReviewTaskId } from "@/lib/artifacts/artifact-review-target";

/**
 * cinatra#4312 — has the run gone on to another pause after the declared review
 * that `reviewTaskId` belongs to? `gates` are the run's review gates, as the
 * caller read them.
 *
 * A gate of another declared review (a `wayflow-` task id with another base task
 * id) that is NOT OLDER than the newest gate of this review is read as a later
 * pause: a later created time, and an equal one too. An equal time cannot tell
 * the order of two pauses, so it is read as later. Times are compared as
 * JavaScript dates, in milliseconds.
 *
 * The check fails closed: when the run has another declared review, a time it
 * cannot read (missing, null or an invalid date, on either side) and a missing
 * gate of this review are read as a later pause too, so the decision is closed
 * without a send rather than sent into a pause that may be later. The stored
 * `created_at` is NOT NULL, so the store gives no such row. A run with no other
 * declared review has no later pause: false.
 *
 * Read at two places: by the close that inserts a carrier
 * (`carryDeclaredReviewDecision`, under the run row lock), and by the resume
 * worker before it sends a declared review's decision. The second read sees a
 * later review whose gates were committed after the close read the run's gates;
 * neither sees a later review whose gates are committed after its own read.
 */
export function laterDeclaredPause(
  gates: readonly { reviewTaskId: string; createdAt?: Date | null }[],
  reviewTaskId: string,
): boolean {
  const base = baseReviewTaskId(reviewTaskId);
  const others = gates.filter((g) => isDeclaredReviewTaskId(g.reviewTaskId) && baseReviewTaskId(g.reviewTaskId) !== base);
  if (others.length === 0) return false;
  const time = (g: { createdAt?: Date | null }) => (g.createdAt instanceof Date ? g.createdAt.getTime() : Number.NaN);
  const own = gates.filter((g) => baseReviewTaskId(g.reviewTaskId) === base).map(time);
  if (own.length === 0 || !own.every(Number.isFinite)) return true;
  const newest = Math.max(...own);
  return others.some((g) => {
    const t = time(g);
    return !Number.isFinite(t) || t >= newest;
  });
}
