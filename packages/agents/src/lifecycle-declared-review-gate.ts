import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-declared-review-gate (cinatra#4225, cinatra#4245)
//
// The one answer to "which review step that the run declared in its own template
// already reviews this produced revision?". The produced-event sweep
// (lifecycle-review-orchestration-store) reads it to link the event to that gate
// instead of opening an automatic one.
//
// Who links is settled by the event row's lock: `lockProducedEventLink` reads the
// link of an event FOR UPDATE, in the caller's transaction. Today the sweep is the
// only caller (a later change of the #4245 split adds the change-request composer):
//   - its reuse of a declared gate writes the park, the link and the mark in that
//     same transaction;
//   - its automatic emit inserts the gate in that same transaction, and writes the
//     park, the link and the mark after the commit, the link only where none is
//     set yet (the retry-convergent seam of cinatra#2065).
// ---------------------------------------------------------------------------

import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { artifactProducedOutbox, artifactReviewGates } from "./schema";

/** The query handle a read runs through: the module `db`, or a caller's open
 * transaction, so that a read under a row lock sees that transaction's view. */
export type DeclaredGateExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The review-task prefix of a template-declared review gate: `wayflow-<taskId>`,
 * and `wayflow-<taskId>#<n>` for its per-artifact legs (execution.ts). */
const DECLARED_REVIEW_TASK_PREFIX = "wayflow-";

type ProducedPair = {
  orgId: string;
  producerRunId: string | null;
  artifactId: string;
  representationRevisionId: string;
};

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
 * revision. A pending or a resolved declared gate both count: either way the
 * revision has its review. Anything else returns null and the automatic gate
 * opens as before. The oldest matching gate wins.
 */
export async function findDeclaredGateForPair(row: ProducedPair, executor: DeclaredGateExecutor = db): Promise<string | null> {
  return (await gatesPinningPair(row, executor)).declared;
}

/** Every gate of the producing run that pins the event's exact revision: the
 * oldest declared one, or null, and whether any gate that is not declared pins it. */
async function gatesPinningPair(
  row: ProducedPair,
  executor: DeclaredGateExecutor,
): Promise<{ declared: string | null; otherPins: boolean }> {
  if (!row.producerRunId) return { declared: null, otherPins: false };
  const gates = await executor
    .select({
      id: artifactReviewGates.id,
      orgId: artifactReviewGates.orgId,
      reviewTaskId: artifactReviewGates.reviewTaskId,
      pinnedTargets: artifactReviewGates.pinnedTargets,
    })
    .from(artifactReviewGates)
    .where(and(eq(artifactReviewGates.runId, row.producerRunId), eq(artifactReviewGates.orgId, row.orgId)))
    .orderBy(asc(artifactReviewGates.createdAt));
  let declared: string | null = null;
  let otherPins = false;
  for (const gate of gates) {
    if (gate.orgId !== row.orgId) continue;
    const pins: unknown[] = Array.isArray(gate.pinnedTargets) ? gate.pinnedTargets : [];
    const pinsPair = pins.some((t) => {
      if (typeof t !== "object" || t === null) return false;
      const pin = t as { artifactId?: unknown; representationRevisionId?: unknown };
      return pin.artifactId === row.artifactId && pin.representationRevisionId === row.representationRevisionId;
    });
    if (!pinsPair) continue;
    const isDeclared = typeof gate.reviewTaskId === "string" && gate.reviewTaskId.startsWith(DECLARED_REVIEW_TASK_PREFIX);
    if (!isDeclared) otherPins = true;
    else if (declared === null) declared = gate.id;
  }
  return { declared, otherPins };
}

/** What a produced event's link is, read under its row lock. */
export type ProducedEventLinkState =
  /** No such event. */
  | { kind: "absent" }
  /** The event is already processed or already names a gate. */
  | { kind: "settled"; status: string; continuationAddress: string | null }
  /** Still pending with no gate: the holder of the lock decides the link. */
  | { kind: "unlinked"; declaredGateId: string | null; otherGatePinsRevision: boolean };

/**
 * Lock the produced event's row (FOR UPDATE, in the caller's transaction) and
 * read what its link is now. The caller decides inside the same transaction: the
 * reuse writes its link there, and the automatic emit writes its gate there, so a
 * later decider reads that gate's pin (`otherGatePinsRevision`). Two deciders
 * never both act on an unlinked event.
 */
export async function lockProducedEventLink(tx: DeclaredGateExecutor, eventId: string): Promise<ProducedEventLinkState> {
  const [ev] = await tx
    .select({
      orgId: artifactProducedOutbox.orgId,
      producerRunId: artifactProducedOutbox.producerRunId,
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
      status: artifactProducedOutbox.status,
      continuationAddress: artifactProducedOutbox.continuationAddress,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .for("update");
  if (!ev) return { kind: "absent" };
  if (ev.status !== "pending" || ev.continuationAddress !== null) {
    return { kind: "settled", status: ev.status, continuationAddress: ev.continuationAddress };
  }
  const pins = await gatesPinningPair(ev, tx);
  return { kind: "unlinked", declaredGateId: pins.declared, otherGatePinsRevision: pins.otherPins };
}
