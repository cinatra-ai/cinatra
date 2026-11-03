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
    // The class of the error and a fixed text, never its message: a driver's
    // message carries the failed query and its parameters ("Failed query: ...
    // params: ..."), so the organization and the artifact would reach the log.
    console.warn(
      "[artifact-page] the open review read failed; drawing the pending reading:",
      errorClassOf(err),
    );
    return PENDING;
  }
}

/** A class name made only of identifier characters, or a fixed word. */
function errorClassOf(err: unknown): string {
  const name = err instanceof Error ? err.constructor?.name : undefined;
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}
