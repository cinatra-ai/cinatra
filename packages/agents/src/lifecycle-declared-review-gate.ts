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
// Both read through this function. WHO LINKS is settled by the event row's
// lock (cinatra#4245): the sweep and the change-request composer each decide
// the link of a still-unlinked event only while they hold that row FOR UPDATE,
// inside the transaction that writes their outcome — the sweep its automatic
// gate, the composer the link to the declared gate plus the change request. So
// a committed change request on a declared gate always means the event names
// that gate, and an event the sweep gated automatically never takes a change
// request on a declared gate.
//
// It also holds the one rule that a change request ENDS a pause (see
// `pauseHasChangeRequest`), read by the resume worker and by the direct resume.
// ---------------------------------------------------------------------------

import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { agentRuns, artifactProducedOutbox, artifactReviewGates } from "./schema";
import { listReviewGatesForRun } from "./artifact-review-gate-store";

import { baseReviewTaskId } from "@/lib/artifacts/artifact-review-target";

/** The query handle a read runs through: the module `db`, or a caller's open
 * transaction (so a read under a row lock sees that transaction's view). */
export type DeclaredGateExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
}, executor: DeclaredGateExecutor = db): Promise<string | null> {
  return (await gatesPinningPair(row, executor)).declared;
}

/** Every gate of the producing run that pins the event's exact revision: the
 * oldest DECLARED one (or null) and whether any OTHER gate pins it too. */
async function gatesPinningPair(row: {
  orgId: string;
  producerRunId: string | null;
  artifactId: string;
  representationRevisionId: string;
}, executor: DeclaredGateExecutor): Promise<{ declared: string | null; otherPins: boolean }> {
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
    if (isDeclared && declared === null) declared = gate.id;
    else if (!isDeclared) otherPins = true;
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
 * LOCK the produced event's row (FOR UPDATE, in the caller's transaction) and
 * read what its link is now. The caller decides and writes the link inside the
 * same transaction, so two deciders never both act on an unlinked event.
 */
export async function lockProducedEventLink(
  tx: DeclaredGateExecutor,
  eventId: string,
): Promise<ProducedEventLinkState> {
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

/**
 * THE ONE RULE that a change request ends a pause (cinatra#4245): a reviewer who
 * asked for changes on any gate of one WayFlow pause resolved that gate
 * `changes_requested`; nothing may resume the run past that pause any more (the
 * repair drain stops it). `reviewTaskId` names the pause, or one of its legs.
 */
export function pauseHasChangeRequest(
  gates: ReadonlyArray<{ reviewTaskId: string; disposition: string | null }>,
  reviewTaskId: string,
): boolean {
  const base = baseReviewTaskId(reviewTaskId);
  return gates.some((leg) => baseReviewTaskId(leg.reviewTaskId) === base && leg.disposition === "changes_requested");
}

/**
 * May this paused run still be resumed at the pause it waits at? Re-reads the
 * run's status and task and its gates now. False when the run no longer waits at
 * `expectedTaskId` (moved on, stopped) or when a gate of that pause has a change
 * request. Used by the direct resume right before its first write and again
 * right before it sends.
 */
export async function resumeStillAllowed(run: {
  id: string;
  orgId: string;
  expectedTaskId: string;
}): Promise<boolean> {
  const [now] = await db
    .select({ status: agentRuns.status, a2aTaskId: agentRuns.a2aTaskId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.orgId, run.orgId)))
    .limit(1);
  if (!now || now.status !== "pending_approval" || now.a2aTaskId !== run.expectedTaskId) return false;
  const gates = await listReviewGatesForRun(run.id);
  return !pauseHasChangeRequest(gates, `${DECLARED_REVIEW_TASK_PREFIX}${run.expectedTaskId}`);
}
