import "server-only";

import {
  isArtifactUnderOpenReview,
  readArtifactRevisionReview,
} from "@cinatra-ai/agents/artifact-open-review-read";

import type { ArtifactRendererReviewReading } from "@/lib/artifacts/artifact-renderer-props";
import {
  reviewSettledOutcomeFromDisposition,
  type ReviewSettledOutcome,
} from "@/lib/artifacts/review-surface-model";

const PENDING: ArtifactRendererReviewReading = { reading: "pending", openLive: null };

/** The whole warning of a failed read: a fixed text, and nothing of the error. */
const OPEN_REVIEW_READ_FAILED_WARNING =
  "[artifact-page] the open review read failed; drawing the pending reading";
const REVISION_REVIEW_READ_FAILED_WARNING =
  "[artifact-page] the revision review read failed; drawing no review marker";

/**
 * THE REVIEW READING OF THE ARTIFACT'S OWN PAGE (cinatra#3092). An open gate on
 * the artifact reads pending. No open gate hands no reading, which a display
 * reads as no review standing. A read that rejects reads pending, whatever it
 * rejects with: a display treats a snapshot with no reading as free to offer the
 * live link, so "cannot tell" must not look like "no review".
 *
 * The page calls this only after the row's own read authorization and the type's
 * own read gate, so a reader who may not read the row learns nothing about its
 * reviews.
 */
export async function readArtifactPageReviewReading(args: {
  orgId: string;
  artifactId: string;
}): Promise<ArtifactRendererReviewReading | undefined> {
  try {
    return (await isArtifactUnderOpenReview(args)) ? PENDING : undefined;
  } catch {
    // NOTHING OF THE ERROR IS READ OR LOGGED: not its message, which a driver
    // fills with the failed query and its parameters ("Failed query: ...
    // params: ..."), and not its class name, which the thrower controls (an own
    // `constructor` can carry any value, and a getter on it can throw). The
    // catch touches the error not at all, so it cannot itself throw on one.
    warnFixed(OPEN_REVIEW_READ_FAILED_WARNING);
    return PENDING;
  }
}

/**
 * THE REVIEW OF THE REVISION THE PAGE SHOWS (cinatra#3092, artifact-review §XI).
 * "On a review target every display draws the one revision the gate pinned … the
 * meta line names the revision with its pinned marker", and once the review is
 * decided the host draws "only Continued / Decided on the revision above.
 * beneath the whole display". Both are facts of the revision a gate pinned:
 *
 *   - `pinned`: a gate of this organization pins the revision shown, open or
 *     decided. Another revision of a reviewed artifact, and an artifact no gate
 *     ever pinned, are not pinned.
 *   - `open`: a gate on that revision is still pending.
 *   - `settled`: no gate on that revision is open and the latest one is decided,
 *     with an outcome this build can read. The marker is the same for every
 *     outcome (Lifecycle cards §XIII.1); `decidedAt` is set only where a person
 *     approved, the one decision the displays' own continued reading carries.
 *
 * A read that fails, whatever it fails with, draws neither: a marker that says
 * something about a review is never drawn on a guess.
 */
export type ArtifactPageRevisionReview = {
  readonly pinned: boolean;
  readonly open: boolean;
  readonly settled: { readonly outcome: ReviewSettledOutcome; readonly decidedAt: string | null } | null;
};

export const NOT_A_REVIEW_TARGET: ArtifactPageRevisionReview = { pinned: false, open: false, settled: null };

export async function readArtifactPageRevisionReview(args: {
  orgId: string;
  artifactId: string;
  revisionId: string | null;
}): Promise<ArtifactPageRevisionReview> {
  if (!args.revisionId) return NOT_A_REVIEW_TARGET;
  try {
    const review = await readArtifactRevisionReview({
      orgId: args.orgId,
      artifactId: args.artifactId,
      representationRevisionId: args.revisionId,
    });
    if (review.status === "open") return { pinned: true, open: true, settled: null };
    if (review.status !== "settled") return NOT_A_REVIEW_TARGET;
    const outcome = reviewSettledOutcomeFromDisposition(review.disposition);
    return { pinned: true, open: false, settled: outcome ? { outcome, decidedAt: review.decidedAt } : null };
  } catch {
    // As above: nothing of the error is read or logged.
    warnFixed(REVISION_REVIEW_READ_FAILED_WARNING);
    return NOT_A_REVIEW_TARGET;
  }
}

/**
 * THE READING THE REVISION READ ALONE GIVES A DISPLAY ON THIS PAGE. An open
 * review of the revision shown is pending, whatever the artifact-wide read said:
 * the two reads are separate, and a review that opens between them must never
 * leave the display with no reading, which it would read as free to offer the
 * live link. The continued reading comes only from a settled review a person
 * approved, with that decision's time, on the review card's own rule
 * (`artifact-review-preparation`). Anything else hands no reading.
 */
export function revisionReviewReading(
  revision: ArtifactPageRevisionReview,
  openLive: string | null,
): ArtifactRendererReviewReading | undefined {
  if (revision.open) return PENDING;
  const settled = revision.settled;
  if (!settled || settled.outcome !== "approved" || settled.decidedAt === null) return undefined;
  return { reading: "continued", openLive, decidedAt: settled.decidedAt };
}

/** The fixed warning. A log sink that throws never changes the reading. */
function warnFixed(message: string): void {
  try {
    console.warn(message);
  } catch {
    // The reading stays as decided; there is nothing safe left to report.
  }
}
