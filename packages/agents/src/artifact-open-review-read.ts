import "server-only";

// ---------------------------------------------------------------------------
// artifact-open-review-read (cinatra#3092).
//
// The review gate store reads from a gate to its artifacts. The artifact's own
// page starts from the artifact, and it has to know whether a review of that
// artifact is still open: "A dashboard whose review is still pending was not
// continued and carries no live link."
//
// WHY A LEAF, and not one more function on `artifact-review-gate-store`. That
// store reaches the run and lifecycle modules, and the artifact page reaches
// none of them today. This read needs the one table and nothing else (the
// `lifecycle-verification-read-store` precedent).
//
// THE ANSWER IS PER ARTIFACT, NOT PER REVISION. A gate pins the revision it
// reviews and the page draws the head revision, but the live link belongs to the
// artifact, and a new revision does not settle the review that is open on it.
// ---------------------------------------------------------------------------

import { and, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { artifactReviewGates } from "./schema";

/**
 * Whether a gate of this organization is open with this artifact in its pinned
 * set. A read that fails throws: only the caller knows what its surface draws
 * when it cannot tell.
 */
export async function isArtifactUnderOpenReview(args: {
  orgId: string;
  artifactId: string;
}): Promise<boolean> {
  const rows = await db
    .select({ id: artifactReviewGates.id })
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.orgId, args.orgId),
        eq(artifactReviewGates.status, "pending"),
        sql`${artifactReviewGates.pinnedTargets} @> ${JSON.stringify([{ artifactId: args.artifactId }])}::jsonb`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
