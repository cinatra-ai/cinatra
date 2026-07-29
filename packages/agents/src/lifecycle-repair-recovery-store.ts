import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-recovery-store (cinatra#2065, epic #2037 S2 hardening)
//
// The LEGACY-STRAND recovery half of the repair loop. cinatra#2065 made the
// repair successor-gate emit + finalize ATOMIC (`submitRepairResponse` enlists the
// emit in the finalize transaction — Seam A), so a crash-window strand can no
// longer be MINTED. But rows left behind by the PRE-#2065 non-atomic code — a
// successor gate emitted, then the process crashed before the separate finalize
// committed — are durable and must be CONVERGED:
//
//   ORPHANED SUCCESSOR GATE — the deterministic successor gate (run, task) exists,
//   pinned to the target the crashed producer emitted, but the repair row is still
//   `requested` / `dispatched` (never finalized): `successor_gate_id` is null, and
//   the original producing event's held effect is still linked to the BASE gate
//   (the re-point never ran). The stranded pending gate ALSO blocks a fresh-target
//   producer retry (it occupies the deterministic slot → pin conflict), so the
//   strand cannot self-heal through the normal path.
//
// The recovery ADOPTS the orphan: the emitted gate IS the successor the producer
// chose (its pinned target is authoritative), so the recovery finalizes the repair
// AGAINST that existing gate — CAS the repair to `repaired` with the successor read
// from the gate's own pinned target, and re-point the held effect onto it — all in
// ONE transaction. What is lost to the crash (the response's per-finding outcomes /
// change summary) is annotation, not load-bearing for the hold/release; the effect
// is then released ONLY by a genuine review of the adopted successor gate. Adopting
// converges autonomously, WITHOUT the (lost) producer response, and clears the slot
// so the lineage proceeds.
//
// Idempotent + safe: an already-`repaired` repair is a no-op; the CAS guards
// concurrent recovery + producer retry; and because the atomic path can never mint
// this state, the recovery only ever adopts a GENUINE pre-fix strand (a live atomic
// submit commits the emit and the finalize together — its gate is never visible
// while its repair is unfinalized).
//
// SWITCHED with the rest of the repair loop: it runs by DEFAULT (the #2047
// ruling) and goes inert only when a deployment sets
// `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`.
// ---------------------------------------------------------------------------

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "./db";
import { lifecycleRepair, artifactReviewGates, artifactProducedOutbox } from "./schema";
import { orphanRepairRunId } from "./lifecycle-repair-store";
import { repairSuccessorReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

/** The change-summary sentinel an adopted successor carries — the per-finding
 * outcomes / summary the crashed response would have written are unrecoverable, so
 * the row records that it converged via recovery rather than a live finalize. */
export const ORPHAN_RECOVERY_CHANGE_SUMMARY =
  "[recovered] successor gate adopted by orphan-recovery (pre-#2065 crash-window strand)";

export type RepairSuccessorRecoveryResult =
  | { ok: true; status: "recovered"; repairId: string; successorGateId: string }
  | { ok: true; status: "already-repaired"; repairId: string; successorGateId: string | null }
  | { ok: true; status: "no-orphan"; repairId: string }
  | { ok: false; code: "not-found" | "concurrent" | "bad-orphan"; error: string };

/**
 * Converge a single repair's pre-#2065 orphaned successor gate, if it has one.
 *
 *   - repair not found                                → { not-found }.
 *   - already `repaired`                              → no-op (idempotent).
 *   - `requested` / `dispatched` with a DETERMINISTIC successor gate already
 *     emitted (the orphan)                            → ADOPT it (finalize + re-point).
 *   - `requested` / `dispatched` with NO successor gate → nothing stranded (the
 *     crash was before the emit, or no response was ever submitted) → { no-orphan }.
 *   - a terminal non-repaired status (`stale` / `escalated`) is never an orphan
 *     source (those states are reached before any emit)  → { no-orphan }.
 */
export async function recoverOrphanedRepairSuccessor(
  repairId: string,
): Promise<RepairSuccessorRecoveryResult> {
  const [repair] = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.id, repairId))
    .limit(1);
  if (!repair) return { ok: false, code: "not-found", error: `repair ${repairId} not found` };

  if (repair.status === "repaired") {
    return { ok: true, status: "already-repaired", repairId, successorGateId: repair.successorGateId };
  }
  if (repair.status !== "requested" && repair.status !== "dispatched") {
    // stale / escalated / any other non-emitting terminal — no orphan is possible.
    return { ok: true, status: "no-orphan", repairId };
  }

  // The deterministic (run, task) slot the crashed submit would have emitted into.
  const runId = repair.producerRunId ?? orphanRepairRunId(repair.id);
  const successorTaskId = repairSuccessorReviewTaskId(repair.id, repair.attempt);
  const [orphan] = await db
    .select()
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.runId, runId),
        eq(artifactReviewGates.reviewTaskId, successorTaskId),
      ),
    )
    .limit(1);
  if (!orphan) return { ok: true, status: "no-orphan", repairId };

  // The orphan's single pinned target IS the successor the producer chose.
  const pinned = (orphan.pinnedTargets as Array<{ artifactId: string; representationRevisionId: string }>) ?? [];
  const target = pinned[0];
  if (!target) {
    return { ok: false, code: "bad-orphan", error: `orphan gate ${orphan.id} has no pinned target` };
  }

  // ADOPT in one transaction: CAS the repair to `repaired` against its CURRENT
  // status (only one recovery/retry finalizes) and re-point the held effect.
  const adopted = await db.transaction(async (tx) => {
    const cas = await tx
      .update(lifecycleRepair)
      .set({
        status: "repaired",
        successorGateId: orphan.id,
        successorArtifactId: target.artifactId,
        successorRepresentationRevisionId: target.representationRevisionId,
        changeSummary: ORPHAN_RECOVERY_CHANGE_SUMMARY,
        updatedAt: sql`now()`,
      })
      .where(and(eq(lifecycleRepair.id, repair.id), eq(lifecycleRepair.status, repair.status)))
      .returning({ id: lifecycleRepair.id });
    if (cas.length !== 1) return false; // a concurrent recovery/response won.
    // Re-point the still-held base linkage onto the adopted successor gate. Keyed
    // on the LIVE linkage (== base gate), exactly as the live finalize is, so the
    // ORIGINAL producing event's effect follows the chain (a repair gate is
    // single-target ⇒ one outbox row; precise, never touches an unrelated event).
    await tx
      .update(artifactProducedOutbox)
      .set({ continuationAddress: orphan.id })
      .where(eq(artifactProducedOutbox.continuationAddress, repair.gateId));
    return true;
  });

  if (!adopted) {
    // A concurrent finalize won — converge to its result if it landed the successor.
    const [now] = await db
      .select({ status: lifecycleRepair.status, successorGateId: lifecycleRepair.successorGateId })
      .from(lifecycleRepair)
      .where(eq(lifecycleRepair.id, repair.id))
      .limit(1);
    if (now?.status === "repaired" && now.successorGateId) {
      return { ok: true, status: "already-repaired", repairId, successorGateId: now.successorGateId };
    }
    return { ok: false, code: "concurrent", error: "the repair was finalized concurrently during recovery" };
  }

  return { ok: true, status: "recovered", repairId, successorGateId: orphan.id };
}

export interface RepairSuccessorRecoverySweepSummary {
  scanned: number;
  recovered: number;
  results: RepairSuccessorRecoveryResult[];
}

/**
 * Autonomous recovery sweep: scan the OPEN repairs (`requested` / `dispatched`),
 * bounded, and converge any that carry a pre-#2065 orphaned successor gate. A
 * recovery worker calls this on a cadence (the durable-strand analogue of the
 * open-epoch drain). Idempotent — a repair with no orphan is a cheap no-op.
 */
export async function recoverOrphanedRepairSuccessors(
  limit = 100,
): Promise<RepairSuccessorRecoverySweepSummary> {
  const bounded = Math.max(1, Math.min(limit, 500));
  const open = await db
    .select({ id: lifecycleRepair.id })
    .from(lifecycleRepair)
    .where(inArray(lifecycleRepair.status, ["requested", "dispatched"]))
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(bounded);

  const results: RepairSuccessorRecoveryResult[] = [];
  let recovered = 0;
  for (const row of open) {
    const r = await recoverOrphanedRepairSuccessor(row.id);
    results.push(r);
    if (r.ok && r.status === "recovered") recovered += 1;
  }
  return { scanned: open.length, recovered, results };
}
