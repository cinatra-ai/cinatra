import "server-only";

import { isArtifactUnderOpenReview } from "@cinatra-ai/agents/artifact-open-review-read";

import type { ArtifactRendererReviewReading } from "@/lib/artifacts/artifact-renderer-props";

const PENDING: ArtifactRendererReviewReading = { reading: "pending", openLive: null };

/**
 * THE REVIEW READING OF THE ARTIFACT'S OWN PAGE (cinatra#3092). An open gate on
 * the artifact reads pending. No open gate hands no reading, which a display
 * reads as no review standing. A read that fails reads pending: a display treats
 * a snapshot with no reading as free to offer the live link, so "cannot tell"
 * must not look like "no review".
 *
 * The page calls this only after the row's own read authorization, so a reader
 * who may not read the row learns nothing about its reviews.
 */
export async function readArtifactPageReviewReading(args: {
  orgId: string;
  artifactId: string;
}): Promise<ArtifactRendererReviewReading | undefined> {
  try {
    return (await isArtifactUnderOpenReview(args)) ? PENDING : undefined;
  } catch (err) {
    console.warn(
      "[artifact-page] the open review read failed; drawing the pending reading:",
      err instanceof Error ? err.message : String(err),
    );
    return PENDING;
  }
}
