import "server-only";

import { isArtifactUnderOpenReview } from "@cinatra-ai/agents/artifact-open-review-read";

import type { ArtifactRendererReviewReading } from "@/lib/artifacts/artifact-renderer-props";

const PENDING: ArtifactRendererReviewReading = { reading: "pending", openLive: null };

/** The whole warning of a failed read: a fixed text, and nothing of the error. */
const OPEN_REVIEW_READ_FAILED_WARNING =
  "[artifact-page] the open review read failed; drawing the pending reading";

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
    warnOpenReviewReadFailed();
    return PENDING;
  }
}

/** The fixed warning. A log sink that throws never changes the reading. */
function warnOpenReviewReadFailed(): void {
  try {
    console.warn(OPEN_REVIEW_READ_FAILED_WARNING);
  } catch {
    // The reading stays pending; there is nothing safe left to report.
  }
}
