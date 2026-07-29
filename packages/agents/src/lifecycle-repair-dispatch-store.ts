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
//   • an ASYNC-EFFECTS-GATED `producer_repair` repair gets a DETERMINISTIC repair
//     run (`lifecycle-repair-run:<repairId>`) on the PRODUCING template, whose
//     `input_params` carry the typed `ChangesRequestedRequest` — that row IS the
//     delivered request; the producer reads it and answers through its own typed
//     entry point (for the blog pipeline: `repairBlogPostDraft`), which pins the
//     successor gate and fires the post-change verification;
//   • the repair is then CAS'd `requested` → `dispatched` (idempotent);
//   • a repair whose producing run/template cannot be resolved — i.e. there is no
//     producer to deliver to — is ESCALATED rather than left silently pending
//     ("nothing silently drops", S2 AC);
//   • a CHECKPOINTED repair is likewise ESCALATED, with its reason recorded. The
//     plan's checkpointed half is a RESUME of the parked producing run at its
//     continuation address, not a new run (S2: "resume for checkpointed flows, a
//     new dispatched repair run for completed ones"); that resume is not shipped
//     here, and delivering a checkpointed repair through the new-run mechanism
//     would be the WRONG mechanism silently applied. Fail-closed to a human
//     instead (Codex round, finding E).
//
// SCOPE, stated plainly: this drain DELIVERS the request and makes the hand-off
// durable + idempotent; EXECUTING the repair run is the producing agent runtime's
// job, exactly as executing any other agent run is. The `requested → dispatched`
// move is therefore "the producer has been told", not "the repair has run"; a
// producer that never answers leaves a `dispatched` repair and a PENDING base
// produced-event — both ops-visible, neither silently dropped.
//
// The repair run is minted through `createAgentRun` — the single OBO-ceiling
// primitive (#1035) — as a CHILD DISPATCH under the producing run, threading the
// producing run's PERSISTED ceiling chain as the compose operand. The child's own
// ceiling is server-derived inside the primitive; a provably-disjoint composition
// throws and the delivery fails closed with nothing written. The primitive mints
// the row `queued`; no execution job is enqueued HERE (see the scope note below).
//
// No schema change: the run id is derived from the repair id (the same technique
// `orphanRepairRunId` already uses for the successor gate's run slot), and the
// escalation reason rides `change_summary` behind an explicit sentinel, mirroring
// `ORPHAN_RECOVERY_CHANGE_SUMMARY` in the recovery store.
//
// SWITCHED with the rest of the loop: the only production caller is the S1
// gate-maintenance drain, which is seeded by DEFAULT (the #2047 ruling) and
// skipped only when `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`.
// ---------------------------------------------------------------------------

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "./db";
import { agentRuns, agentTemplates, lifecycleRepair } from "./schema";
import { createAgentRun } from "./store";
import { markRepairDispatched } from "./lifecycle-repair-store";

import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

import type { ChangesRequestedRequest, RepairFinding } from "@/lib/lifecycle/lifecycle-repair";
// cinatra#1940 P3 (Decision 2): the creation perimeter is now guarded — this
// repair-delivery drain has no session, so it mints the SYSTEM
// `agent-run-dispatch` authority (a caller the design's caller matrix did not
// enumerate; found while grounding P3 against live source).
import { mintLifecycleRepairDispatchAuthority } from "@/lib/org-write/agent-run-authority-mint";

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
 * need a migration; the recovery store sets the same precedent).
 *
 * The sentinel is NOT self-describing — read it only through
 * `dispatchEscalationReason`, which requires `status === 'escalated'` first, so a
 * genuine change summary that happens to start with the same characters can never
 * be misread as an escalation reason (Codex round, finding C). */
export const DISPATCH_ESCALATION_PREFIX = "[escalated] ";

/** The recorded escalation reason for a repair, or null. Discriminates on STATUS
 * first — never on the prefix alone. */
export function dispatchEscalationReason(repair: {
  status: string;
  changeSummary: string | null;
}): string | null {
  if (repair.status !== "escalated") return null;
  const summary = repair.changeSummary ?? "";
  return summary.startsWith(DISPATCH_ESCALATION_PREFIX)
    ? summary.slice(DISPATCH_ESCALATION_PREFIX.length)
    : null;
}

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

/** Known bound: the pass takes the OLDEST `limit` pending repairs. A row whose
 * delivery keeps throwing stays `requested` and re-occupies one of those slots on
 * every pass, so `limit` simultaneously-failing rows would starve newer ones.
 * Bounding retries durably needs an attempt column (a migration), so the bound is
 * recorded here rather than silently assumed away. */
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
      if (row.continuationMode === "checkpointed") {
        // The checkpointed half of the delivery contract is a RESUME, not a new
        // run. Escalate rather than apply the wrong mechanism.
        const escalated = await escalateRepair(
          row.id,
          "checkpointed repair delivery is a resume of the parked producing run, which this drain does not implement",
        );
        if (escalated) summary.escalated += 1;
        else summary.raced += 1;
        continue;
      }

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

      const runId = repairRunId(row.id);
      const [already] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (!already) {
        try {
          // cinatra#1940 P3 (Decision 2): the guarded creation perimeter needs
          // an authority — this drain has no session, so mint the system
          // dispatcher authority scoped to the repair's org.
          const dispatchAuthority = mintLifecycleRepairDispatchAuthority(row.orgId);
          await createAgentRun(
            {
              id: runId,
              templateId: producer.templateId,
              orgId: row.orgId,
              inputParams: { lifecycleRepairRequest: request },
              sourceType: "lifecycle_repair",
              // CHILD DISPATCH (#1035): the repair run runs under the producing
              // run. Its own ceiling is server-derived inside the primitive; the
              // parent's PERSISTED chain is the compose operand only, never copied.
              parentRunId: row.producerRunId ?? null,
              parentOboCeiling: producer.parentOboCeiling,
              // A re-drain re-derives the same key, so an at-least-once delivery
              // converges on the SAME repair run.
              idempotencyKey: `lifecycle-repair:${row.id}`,
            },
            dispatchAuthority,
          );
        } catch (err) {
          // A concurrent drain won the insert — the delivery is already durable.
          if ((err as { code?: string } | null)?.code !== "23505") throw err;
        }
      }

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
async function resolveProducingTemplate(producerRunId: string | null): Promise<{
  templateId: string;
  packageName: string | null;
  /** The producing run's PERSISTED OBO ceiling chain — the compose operand for
   * the child repair run (server-read, never caller input). */
  parentOboCeiling: OboCeilingChain | null;
} | null> {
  if (!producerRunId) return null;
  const [run] = await db
    .select({ templateId: agentRuns.templateId, oboCeiling: agentRuns.oboCeiling })
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
  let parentOboCeiling: OboCeilingChain | null = null;
  if (run.oboCeiling) {
    try {
      parentOboCeiling = JSON.parse(run.oboCeiling) as OboCeilingChain;
    } catch {
      parentOboCeiling = null;
    }
  }
  return { templateId: tmpl.id, packageName: tmpl.packageName ?? null, parentOboCeiling };
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
