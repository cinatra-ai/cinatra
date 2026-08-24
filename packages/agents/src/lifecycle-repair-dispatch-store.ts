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
// durable + idempotent; the producing agent's own graph does the repairing work,
// exactly like any other agent run. The `requested → dispatched` move is
// therefore "the producer has been told AND set running", not merely "told"; a
// producer that never answers leaves a `dispatched` repair and a PENDING base
// produced-event — both ops-visible, neither silently dropped.
//
// The repair run is minted through `createAgentRun` — the single OBO-ceiling
// primitive (#1035) — as a CHILD DISPATCH under the producing run, threading the
// producing run's PERSISTED ceiling chain as the compose operand. The child's own
// ceiling is server-derived inside the primitive; a provably-disjoint composition
// throws and the delivery fails closed with nothing written.
//
// cinatra#2286 S10 PR2 — THE EXECUTION BRIDGE + THE PRINCIPAL FIX. Before this
// slice `createAgentRun` minted the row `queued` and NOTHING enqueued its BullMQ
// execution job — a delivered repair sat forever un-run (dead code path; no
// producer had ever declared `repairCapable`, so it was never reached in
// production). This slice:
//   • actually ENQUEUES the repair run (`enqueueAgentRun`, `jobId: runId` for
//     BullMQ-level dedup across a re-drain) so a `dispatched` repair genuinely
//     runs, dispatched exactly like any other agent run;
//   • projects an optional CMS-generic task/`inputParams` addition (see
//     `./lifecycle-repair-cms-production-bridge`) when the base target is a
//     captured CMS snapshot — a no-op for every other producer (e.g. blog);
//   • THE SECURITY FIX: the dispatched run's ActorContext is the ORIGINATING
//     producing run's own `runBy`, re-verified LIVE at dispatch time via
//     `resolveOrgRoleForUser` (never trusted from whatever the producing run
//     carried at produce time, and never deferred to the write). Without this,
//     `enqueueAgentRun`'s worker frame would carry NO actor for a runBy-less
//     producing run, and `buildActorContextFromRun` degrades a runBy-less run to
//     an `InternalWorker` principal with empty project grants — a
//     system-authority principal masquerading as a content-write actor. A
//     producing run with no human `runBy`, or whose `runBy` no longer resolves a
//     live org membership, is ESCALATED to human review instead — the SAME
//     `escalateRepair` path the checkpointed/no-producer guardrails already use,
//     never dispatched "and hoped".
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
import { launchAgentRun } from "./lifecycle-coordinator";
import { markRepairDispatched } from "./lifecycle-repair-store";

import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

import type { ChangesRequestedRequest, RepairFinding } from "@/lib/lifecycle/lifecycle-repair";
// cinatra#1940 P3 (Decision 2): the creation perimeter is now guarded — this
// repair-delivery drain has no session, so it mints the SYSTEM
// `agent-run-dispatch` authority (a caller the design's caller matrix did not
// enumerate; found while grounding P3 against live source).
import { mintLifecycleRepairDispatchAuthority } from "@/lib/org-write/agent-run-authority-mint";
// cinatra#2286 S10 PR2 — the execution bridge + the principal fix. The
// SYSTEM dispatch authority above only ever covers minting the run ROW
// (`run.execute`/`run.complete`); it structurally cannot authorize the
// content-write the dispatched repair run will attempt through its own tool
// call. That authorization must trace to an accountable HUMAN, never to a
// generic worker identity — so this drain now (a) re-verifies LIVE, at
// dispatch time, that the ORIGINATING producing run's `runBy` is still a real
// member of the repair's org, and (b) threads that verified human as the
// dispatched run's ActorContext, so `withActorContext` carries a real
// `HumanUser` principal through to the connector's own write-authority check
// — never the `InternalWorker`-with-empty-grants fallback
// `buildActorContextFromRun` degrades to for a runBy-less run.
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";

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
  /**
   * The ORIGINATING producing run's `runBy` (cinatra#2286 S10 PR2, the
   * principal fix) — the human this repair's authority traces to, re-verified
   * live at dispatch time (`resolveOrgRoleForUser`) and threaded as the
   * dispatched repair run's ActorContext. `null` only when the producing run
   * itself had no human runBy, in which case the repair is ESCALATED rather
   * than dispatched (see `dispatchPendingProducerRepairs`) — a `null` here on
   * an actually-dispatched request is therefore unreachable in practice, but
   * the field stays nullable so a pre-fix delivered row (read by
   * `readDeliveredRepairRequest` after a rolling deploy) still parses.
   */
  originatingRunBy: string | null;
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

      // cinatra#2286 S10 PR2 — THE PRINCIPAL FIX. The re-staged write a
      // dispatched repair run's own tool call makes must trace to an
      // accountable HUMAN, never to the system dispatch authority above (which
      // mints only `run.execute`/`run.complete`, never a content-write
      // capability) and never to `buildActorContextFromRun`'s runBy-less
      // `InternalWorker` fallback (empty project grants, but still a
      // principal a looser or future connector policy could honor). So:
      //   - no human runBy on the ORIGINATING producing run at all → refuse,
      //     escalate to human review;
      //   - a runBy that no longer resolves a LIVE org membership (revoked /
      //     removed since the run was produced) → refuse, escalate — re-verified
      //     NOW, never trusted from whatever the producing run carried at
      //     produce time.
      // Nothing here is dispatched "and hoped" — the gate runs BEFORE the
      // repair run is even minted.
      const originatingRunByCandidate = producer.originatingRunBy;
      if (!originatingRunByCandidate) {
        const escalated = await escalateRepair(
          row.id,
          "the originating producing run carries no human runBy — dispatching a repair with no verified principal is refused",
        );
        if (escalated) summary.escalated += 1;
        else summary.raced += 1;
        continue;
      }
      const originatingRole = await resolveOrgRoleForUser(row.orgId, originatingRunByCandidate);
      if (!originatingRole) {
        const escalated = await escalateRepair(
          row.id,
          "the originating producing run's runBy is no longer a verified member of this organization",
        );
        if (escalated) summary.escalated += 1;
        else summary.raced += 1;
        continue;
      }
      // Narrowed + stable for the rest of this iteration (never re-read off
      // `producer` again, so no ambiguity across the `await`s below).
      const originatingRunBy: string = originatingRunByCandidate;

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
        originatingRunBy,
      };

      const runId = repairRunId(row.id);

      // CMS-generic task-construction (cinatra#2286 S10 PR2 — the execution
      // bridge). Dynamically imported so a non-CMS repairing producer (e.g.
      // the blog pipeline) never pulls this module's DB reads into the common
      // dispatch path; it resolves to `{}` (no-op) whenever the base target is
      // not itself a captured CMS snapshot, so dispatch stays byte-identical
      // for every other producer.
      const { projectCmsRepairInputParams } = await import(
        "./lifecycle-repair-cms-production-bridge"
      );
      const cmsInputParams = await projectCmsRepairInputParams(request);

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
          // Routed through the coordinator (cinatra#2928). A repair run is
          // HEADLESS — the drain starts it, not a person — so no moment applies
          // at its start and the row is created `queued` exactly as before. The
          // enqueue stays here because it carries this drain's own derived job
          // id and actor context.
          await launchAgentRun({
            producer: "lifecycle_repair",
            frame: null,
            authority: dispatchAuthority,
            dispatch: {
              kind: "caller_dispatches",
              why: "the drain enqueues with its own colon-sanitized job id and the originating human's actor context",
            },
            create: {
              kind: "full",
              input: {
              id: runId,
              templateId: producer.templateId,
              orgId: row.orgId,
              inputParams: { lifecycleRepairRequest: request, ...cmsInputParams },
              sourceType: "lifecycle_repair",
              // Attribution: the repair run is the ORIGINATING human's, never
              // the system dispatcher's — mirrors the ActorContext threaded to
              // the enqueue below (cinatra#2286 S10 PR2, the principal fix).
              runBy: originatingRunBy,
              // CHILD DISPATCH (#1035): the repair run runs under the producing
              // run. Its own ceiling is server-derived inside the primitive; the
              // parent's PERSISTED chain is the compose operand only, never copied.
              parentRunId: row.producerRunId ?? null,
              parentOboCeiling: producer.parentOboCeiling,
              // A re-drain re-derives the same key, so an at-least-once delivery
              // converges on the SAME repair run.
              idempotencyKey: `lifecycle-repair:${row.id}`,
              },
            },
          });
        } catch (err) {
          // A concurrent drain won the insert — the delivery is already durable.
          if ((err as { code?: string } | null)?.code !== "23505") throw err;
        }
      }

      // cinatra#2286 S10 PR2 — actually EXECUTE the repair run. Before this,
      // `createAgentRun` above only minted the row `queued`; nothing enqueued
      // the BullMQ execution job, so a delivered repair sat forever un-run.
      // The ActorContext is the LIVE-VERIFIED originating human resolved above
      // — never the system dispatch authority, never left to
      // `buildActorContextFromRun`'s runBy-less fallback (this run always
      // carries a runBy, so that fallback is never reached for it). The
      // BullMQ-level dedup key is DERIVED from `runId` (so a re-drain — a
      // crash between mint and enqueue — is safe to re-call) but with its `:`
      // stripped: `runId` carries the `lifecycle-repair-run:` prefix, and
      // BullMQ's custom-jobId validation rejects any id containing exactly one
      // `:` ("Custom Id cannot contain :" — reserved for its own 3-part
      // repeatable-job ids). Same sanitization `skills-store.ts` already
      // applies to its own colon-bearing jobIds.
      const actorContext = await buildActorContextFromRun({
        id: runId,
        runBy: originatingRunBy,
        orgId: row.orgId,
      });
      await enqueueAgentRun(
        { runId },
        { jobId: runId.replace(/:/g, "_"), actorContext },
      );

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
  /**
   * The ORIGINATING producing run's `runBy` (cinatra#2286 S10 PR2, the
   * principal fix) — read off the SAME already-open run row (a one-line
   * addition, no second query). `null` when the producing run itself had no
   * human runBy (a system/A2A/scheduled write with no delegating human), in
   * which case the caller refuses to dispatch rather than falling through to
   * a system-authority principal.
   */
  originatingRunBy: string | null;
} | null> {
  if (!producerRunId) return null;
  const [run] = await db
    .select({
      templateId: agentRuns.templateId,
      oboCeiling: agentRuns.oboCeiling,
      runBy: agentRuns.runBy,
    })
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
  return {
    templateId: tmpl.id,
    packageName: tmpl.packageName ?? null,
    parentOboCeiling,
    originatingRunBy: run.runBy ?? null,
  };
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
