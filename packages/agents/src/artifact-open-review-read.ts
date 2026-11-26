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

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { personApproved } from "./declared-review-pause";
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

/**
 * THE REVIEW OF ONE REVISION, AS THE ARTIFACT'S OWN PAGE DRAWS IT (cinatra#3092,
 * specs/app-artifact-review.html §XI): "On a review target every display draws
 * the one revision the gate pinned … the meta line names the revision with its
 * pinned marker", and once a decision is taken "the settled marker is drawn
 * below the whole card". Both belong to the revision a gate pinned, so this read
 * asks about the exact (artifact, revision) pair, never the artifact alone.
 *
 * `none`: no gate of this organization pins this revision. `open`: one does and
 * is still pending (an open review outranks an earlier settled one of the same
 * revision). `settled`: every gate that pins it is decided; the latest decision
 * names its disposition, and `decidedAt` only where a person approved it (the
 * publish gate's own rule, `personApproved`: a person's fingerprint AND a person
 * as decider of record), else null.
 *
 * A read that fails throws: only the caller knows what its surface draws when it
 * cannot tell.
 */
export type ArtifactRevisionReview =
  | { status: "none" }
  | { status: "open" }
  | { status: "settled"; disposition: string | null; decidedAt: string | null };

/** The most gates one revision is read across; a revision is pinned by a few. */
const REVISION_GATES_READ_MAX = 50;

export async function readArtifactRevisionReview(args: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<ArtifactRevisionReview> {
  const pinned = [{ artifactId: args.artifactId, representationRevisionId: args.representationRevisionId }];
  const rows = await db
    .select({
      status: artifactReviewGates.status,
      disposition: artifactReviewGates.disposition,
      fingerprint: artifactReviewGates.fingerprint,
      resolvedBy: artifactReviewGates.resolvedBy,
      resolvedAt: artifactReviewGates.resolvedAt,
    })
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.orgId, args.orgId),
        sql`${artifactReviewGates.pinnedTargets} @> ${JSON.stringify(pinned)}::jsonb`,
      ),
    )
    // A pending gate has no resolved time, and a descending order puts nulls
    // first, so an open gate is always inside the bound and the latest decision
    // follows the open ones.
    .orderBy(desc(artifactReviewGates.resolvedAt), desc(artifactReviewGates.createdAt))
    .limit(REVISION_GATES_READ_MAX);
  if (rows.some((row) => row.status === "pending")) return { status: "open" };
  const latest = rows.find((row) => row.status === "resolved");
  if (!latest) return { status: "none" };
  const time = latest.resolvedAt;
  const decidedAt =
    personApproved(latest) &&
    time instanceof Date &&
    Number.isFinite(time.getTime())
      ? time.toISOString()
      : null;
  return { status: "settled", disposition: latest.disposition, decidedAt };
}
