import { baseReviewTaskId, isDeclaredReviewTaskId } from "@/lib/artifacts/artifact-review-target";

/**
 * cinatra#4312 — has the run gone on to another pause after the declared review
 * that `reviewTaskId` belongs to? `gates` are the run's review gates.
 *
 * A gate of another declared review (a `wayflow-` task id with another base task
 * id) that is NOT OLDER than the newest gate of this review is read as a later
 * pause: a later created time, and an equal one too. An equal time cannot tell
 * the order of two pauses, so it is read as later, and the earlier decision is
 * not carried or sent into a pause that may be later.
 *
 * Read at two places: by the close that inserts a carrier
 * (`carryDeclaredReviewDecision`, under the run row lock), and by the resume
 * worker before it sends a declared review's decision. The second read covers a
 * later review whose gates were committed after the close read the run's gates.
 *
 * A gate whose time cannot be read is not compared (the stored `created_at` is
 * NOT NULL). With no gate of this review, there is nothing to compare: false.
 */
export function laterDeclaredPause(
  gates: readonly { reviewTaskId: string; createdAt?: Date | null }[],
  reviewTaskId: string,
): boolean {
  const base = baseReviewTaskId(reviewTaskId);
  const time = (g: { createdAt?: Date | null }) => (g.createdAt instanceof Date ? g.createdAt.getTime() : Number.NaN);
  const own = gates.filter((g) => baseReviewTaskId(g.reviewTaskId) === base).map(time).filter(Number.isFinite);
  if (own.length === 0) return false;
  const newest = Math.max(...own);
  return gates.some((g) =>
    isDeclaredReviewTaskId(g.reviewTaskId) && baseReviewTaskId(g.reviewTaskId) !== base && time(g) >= newest);
}
