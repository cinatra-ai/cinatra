import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-dispatch-store (cinatra#2047 defect D-1, epic #2037 S2)
//
// The DELIVERY half of the repair loop — the step D-1 found missing in product.
//
// S2 (#2040) shipped `recordChangesRequested` (close the review attempt, open a
// durable repair, ROUTE it) and `submitRepairResponse` (the producer's typed
// response → successor gate + verification trigger). Between those two the plan
// specifies: "typed request … delivered per continuation mode — resume for
// checkpointed flows, a NEW DISPATCHED REPAIR RUN for completed ones". Nothing
// implemented that delivery: `markRepairDispatched` had zero production callers,
// so even a correctly-routed `producer_repair` sat at `status='requested'`
// forever and no producer was ever told to repair.
//
// This drain is that delivery:
//
//   • a `producer_repair` repair gets a DETERMINISTIC repair run
//     (`lifecycle-repair-run:<repairId>`) on the PRODUCING template, whose
//     `input_params` carry the typed `ChangesRequestedRequest` — that row IS the
//     delivered request; the producer reads it and answers through its own typed
//     entry point (for the blog pipeline: `repairBlogPostDraft`), which pins the
//     successor gate and fires the post-change verification;
//   • the repair is then CAS'd `requested` → `dispatched` (idempotent);
//   • a repair whose producing run/template cannot be resolved — i.e. there is no
//     producer to deliver to — is ESCALATED rather than left silently pending
//     ("nothing silently drops", S2 AC).
//
// No schema change: the run id is derived from the repair id (the same technique
// `orphanRepairRunId` already uses for the successor gate's run slot), and the
// escalation reason rides `change_summary` behind an explicit sentinel, mirroring
// `ORPHAN_RECOVERY_CHANGE_SUMMARY` in the recovery store.
//
// FENCED with the rest of the loop: the only production caller is the S1
// gate-maintenance drain, which is seeded only when
// `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` is on.
// ---------------------------------------------------------------------------

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { agentRuns, agentTemplates, lifecycleRepair } from "./schema";
import { markRepairDispatched } from "./lifecycle-repair-store";

import type { ChangesRequestedRequest, RepairFinding } from "@/lib/lifecycle/lifecycle-repair";

/** The prefix of the deterministic run a dispatched repair is delivered on. */
export const REPAIR_RUN_PREFIX = "lifecycle-repair-run:";

/** The deterministic repair-run id for a repair. Deterministic so a re-drain
 * re-derives the SAME run (insert-on-conflict-do-nothing ⇒ idempotent delivery). */
export function repairRunId(repairId: string): string {
  return `${REPAIR_RUN_PREFIX}${repairId}`;
}

/** The repair a repair-run id belongs to, or null when the id is not one. */
export function repairIdFromRunId(runId: string | null | undefined): string | null {
  if (!runId || !runId.startsWith(REPAIR_RUN_PREFIX)) return null;
  const id = runId.slice(REPAIR_RUN_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** The sentinel a repair escalated by the DISPATCH pass carries on
 * `change_summary` (there is no dedicated reason column, and inventing one would
 * need a migration; the recovery store sets the same precedent). */
export const DISPATCH_ESCALATION_PREFIX = "[escalated] ";

/** The typed repair request delivered on the repair run's `input_params`. */
export interface DeliveredRepairRequest {
  kind: "lifecycle_repair_request";
  repairId: string;
  gateId: string;
  lineageId: string;
  attempt: number;
  baseTarget: { artifactId: string; representationRevisionId: string };
  expectedBaseRevisionId: string;
  findings: RepairFinding[];
  continuationMode: string;
  continuationAddress: string | null;
}

export interface RepairDispatchSummary {
  scanned: number;
  dispatched: number;
  escalated: number;
  /** Rows a concurrent drain had already moved off `requested`. */
  raced: number;
  failed: number;
}

/**
 * Deliver every pending `producer_repair` repair to its producer.
 *
 * Idempotent + concurrency-safe: the run insert is `ON CONFLICT DO NOTHING` on the
 * deterministic id, and the status move is a CAS from `requested` (the loser of a
 * race counts as `raced` and writes nothing). Never throws — a per-row failure is
 * counted and the row stays `requested` for the next pass.
 */
export async function dispatchPendingProducerRepairs(opts?: {
  limit?: number;
}): Promise<RepairDispatchSummary> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const summary: RepairDispatchSummary = {
    scanned: 0,
    dispatched: 0,
    escalated: 0,
    raced: 0,
    failed: 0,
  };

  const pending = await db
    .select()
    .from(lifecycleRepair)
    .where(and(eq(lifecycleRepair.status, "requested"), eq(lifecycleRepair.route, "producer_repair")))
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(limit);

  for (const row of pending) {
    summary.scanned += 1;
    try {
      const producer = await resolveProducingTemplate(row.producerRunId);
      if (!producer) {
        // No producing run/template to deliver to. Escalate rather than leaving the
        // repair pending forever — the S2 AC's "nothing silently drops".
        const escalated = await escalateRepair(
          row.id,
          "no resolvable producing run/template to dispatch the repair to",
        );
        if (escalated) summary.escalated += 1;
        else summary.raced += 1;
        continue;
      }

      const request: DeliveredRepairRequest = {
        kind: "lifecycle_repair_request",
        repairId: row.id,
        gateId: row.gateId,
        lineageId: row.lineageId,
        attempt: row.attempt,
        baseTarget: {
          artifactId: row.baseArtifactId,
          representationRevisionId: row.baseRepresentationRevisionId,
        },
        expectedBaseRevisionId: row.expectedBaseRevisionId,
        findings: (row.findings as RepairFinding[]) ?? [],
        continuationMode: row.continuationMode,
        continuationAddress: row.continuationAddress ?? null,
      };

      await db
        .insert(agentRuns)
        .values({
          id: repairRunId(row.id),
          templateId: producer.templateId,
          orgId: row.orgId,
          status: "queued",
          inputParams: JSON.stringify({ lifecycleRepairRequest: request }),
          sourceType: "lifecycle_repair",
          parentRunId: row.producerRunId ?? null,
        })
        .onConflictDoNothing({ target: agentRuns.id });

      const moved = await markRepairDispatched(row.id);
      if (moved) summary.dispatched += 1;
      else summary.raced += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-repair-dispatch] repair ${row.id} dispatch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}

/** Resolve the producing run's template (the agent that must repair). */
async function resolveProducingTemplate(
  producerRunId: string | null,
): Promise<{ templateId: string; packageName: string | null } | null> {
  if (!producerRunId) return null;
  const [run] = await db
    .select({ templateId: agentRuns.templateId })
    .from(agentRuns)
    .where(eq(agentRuns.id, producerRunId))
    .limit(1);
  if (!run?.templateId) return null;
  const [tmpl] = await db
    .select({ id: agentTemplates.id, packageName: agentTemplates.packageName })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, run.templateId))
    .limit(1);
  if (!tmpl) return null;
  return { templateId: tmpl.id, packageName: tmpl.packageName ?? null };
}

/** CAS a `requested` repair to `escalated`, recording WHY on `change_summary`
 * behind the dispatch sentinel. Returns false when the row moved under us. */
async function escalateRepair(repairId: string, reason: string): Promise<boolean> {
  const rows = await db
    .update(lifecycleRepair)
    .set({
      status: "escalated",
      changeSummary: `${DISPATCH_ESCALATION_PREFIX}${reason}`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(lifecycleRepair.id, repairId), eq(lifecycleRepair.status, "requested")))
    .returning({ id: lifecycleRepair.id });
  return rows.length === 1;
}

/** The delivered request on a repair run, or null when the run is not a repair
 * run / carries no request. The producer reads this to learn what to repair. */
export async function readDeliveredRepairRequest(
  runId: string,
): Promise<DeliveredRepairRequest | null> {
  const repairId = repairIdFromRunId(runId);
  if (!repairId) return null;
  const [run] = await db
    .select({ inputParams: agentRuns.inputParams })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.inputParams) return null;
  try {
    const parsed = JSON.parse(run.inputParams) as { lifecycleRepairRequest?: DeliveredRepairRequest };
    const req = parsed?.lifecycleRepairRequest;
    return req && req.kind === "lifecycle_repair_request" ? req : null;
  } catch {
    return null;
  }
}

/** Re-build the S2 `ChangesRequestedRequest` shape from a delivered request —
 * the producer's typed view of what the reviewer asked for. */
export function toChangesRequestedRequest(
  delivered: DeliveredRepairRequest,
): Omit<ChangesRequestedRequest, "decisionId" | "idempotencyKey"> {
  return {
    gateId: delivered.gateId,
    baseTarget: delivered.baseTarget,
    expectedBaseRevisionId: delivered.expectedBaseRevisionId,
    findings: delivered.findings,
    continuationMode: delivered.continuationMode === "checkpointed" ? "checkpointed" : "async_effects_gated",
    continuationAddress: delivered.continuationAddress,
  };
}
