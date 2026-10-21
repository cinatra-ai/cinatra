import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-declared-review-gate (cinatra#4225, cinatra#4245)
//
// THE ONE ANSWER to "which review step that the run declared in its own
// template already reviews this produced revision?". Two readers ask it:
//
//   - the produced-event sweep (lifecycle-review-orchestration-store), which
//     links the event to that gate instead of opening an automatic one;
//   - the change-request composer (lifecycle-review-changes-requested-store),
//     which must know, for an event the sweep has not linked YET, which gate the
//     sweep WILL link it to.
//
// Both read through this function, so the gate a change request is filed
// against is exactly the gate the later link names. Read-only: the link itself
// stays the sweep's write.
// ---------------------------------------------------------------------------

import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { artifactReviewGates } from "./schema";

/** The review-task prefix of a template-declared review gate: `wayflow-<taskId>`,
 * and `wayflow-<taskId>#<n>` for its per-artifact legs (execution.ts). */
const DECLARED_REVIEW_TASK_PREFIX = "wayflow-";

/**
 * The template-declared review gate that already reviews this event's EXACT
 * revision, or null (cinatra#4225).
 *
 * A declared gate is minted by the run's own review step and pins the revisions
 * it reviews. Opening an automatic gate over a revision such a gate pins makes
 * the person review the same revision twice: one Approve resolves the declared
 * gate and the run then waits on the automatic one. So the produced path reuses
 * the declared gate instead. The match is strict: the SAME run and org, a
 * `wayflow-` task id, and a pin on the exact artifact AND representation
 * revision. A pending or a resolved declared gate both count — either way the
 * revision has its review. Anything else returns null and the automatic gate
 * opens exactly as before. The oldest matching gate wins.
 */
export async function findDeclaredGateForPair(row: {
  orgId: string;
  producerRunId: string | null;
  artifactId: string;
  representationRevisionId: string;
}): Promise<string | null> {
  if (!row.producerRunId) return null;
  const gates = await db
    .select({
      id: artifactReviewGates.id,
      orgId: artifactReviewGates.orgId,
      reviewTaskId: artifactReviewGates.reviewTaskId,
      pinnedTargets: artifactReviewGates.pinnedTargets,
    })
    .from(artifactReviewGates)
    .where(and(eq(artifactReviewGates.runId, row.producerRunId), eq(artifactReviewGates.orgId, row.orgId)))
    .orderBy(asc(artifactReviewGates.createdAt));
  for (const gate of gates) {
    if (gate.orgId !== row.orgId) continue;
    if (typeof gate.reviewTaskId !== "string" || !gate.reviewTaskId.startsWith(DECLARED_REVIEW_TASK_PREFIX)) continue;
    const pins: unknown[] = Array.isArray(gate.pinnedTargets) ? gate.pinnedTargets : [];
    const pinsPair = pins.some((t) => {
      if (typeof t !== "object" || t === null) return false;
      const pin = t as { artifactId?: unknown; representationRevisionId?: unknown };
      return pin.artifactId === row.artifactId && pin.representationRevisionId === row.representationRevisionId;
    });
    if (pinsPair) return gate.id;
  }
  return null;
}
