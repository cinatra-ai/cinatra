import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-review-orchestration-store (cinatra#2039, epic #2037 S1)
//
// The PERSISTENCE + DRIVE half of automatic review. S0 (#2038) landed the pure
// lattice, the transactional produced-event outbox, the gate store, the
// continuation park, and every contract FENCED — with NO production consumers.
// This store is the consumer S1 ships: it turns a durable `ArtifactProduced`
// event into a policy-matched review gate with ZERO agent-side wiring, holds an
// external artifact's downstream effect until the review decision, resumes a
// checkpointed producing run when its gate resolves, and expires/dispositions a
// gate per policy.
//
//   sweepReviewOrchestration      — drain PENDING produced-outbox events: resolve
//                                   the injected context (artifact type, org
//                                   bound, compiled manifest) that the pure
//                                   `planReviewForEvent` needs, apply the plan
//                                   (create an idempotent auto-gate + link it back
//                                   onto the event + park a checkpointed run), and
//                                   mark the event processed. Effects are
//                                   idempotent (gate emit is idempotent on
//                                   (run,task), the park on (run,event,checkpoint),
//                                   mark-processed a CAS), so at-least-once
//                                   orchestration NEVER duplicates a gate.
//   isArtifactEffectHeld          — the effects-gating predicate. Resolves the
//                                   produced event + its linked gate status and
//                                   defers to the pure `evaluateEffectHold`: an
//                                   ungated / non-external artifact flows; an
//                                   external one is HELD while its gate is pending
//                                   (fail-closed before orchestration runs).
//   sweepLifecycleGateMaintenance — the disposition + TTL/expiry + park-release
//                                   drain: apply reject tombstones to the objects
//                                   store; expire due auto-gates (optional →
//                                   auto-resolve+release; required → keep blocking
//                                   + notify); release checkpointed parks whose
//                                   auto-gate resolved.
//
// Boot-loaded (route-graph ratchet): the background-job registry never imports
// this module; the boot system-loops phase registers `sweep*` into a globalThis
// runner slot behind the S1 activation fence. FENCED default-OFF at three seams
// (see lifecycle-activation.ts): the emitters write no event row, the boot phase
// seeds no loop, and every drain here short-circuits when the fence is off — so
// on `origin/main` the whole slice is INERT.
// ---------------------------------------------------------------------------

import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import { db, agentBuilderPool } from "./db";
import {
  artifactProducedOutbox,
  artifactReviewGates,
  artifactReviewDispositions,
  lifecycleContinuationPark,
  agentTemplates,
  agentRuns,
} from "./schema";
import {
  emitArtifactReviewGate,
  ArtifactReviewGateError,
} from "./artifact-review-gate-store";
import { markProducedEventProcessed } from "./lifecycle-produced-outbox-store";
import { dispatchAutoGateOpen } from "./run-wait-notifier";
import { resolveOrgPolicyRule } from "./lifecycle-policy-store";
import { maybeParkCheckpoint, sweepParks } from "./lifecycle-continuation-park-store";

import { isLifecycleReviewOrchestrationActive } from "@/lib/lifecycle/lifecycle-activation";
import {
  producedEventId,
  type ProducedEventKind,
} from "@/lib/lifecycle/lifecycle-produced-event";
import {
  autoReviewEventId,
  isAutoReviewTaskId,
  isBatchAutoReviewTaskId,
  batchPartitionReviewTaskId,
  evaluateEffectHold,
  planReviewForEvent,
  type ProducedEventAxes,
  type ReviewOrchestrationContext,
  type ReviewOrchestrationPlan,
  type EffectHoldVerdict,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { partitionBatchTargets } from "@/lib/lifecycle/lifecycle-batch";
import {
  sealBatchEpoch,
  closeBatchEpoch,
  resolveOpenBatchEpoch,
  listOpenBatchEpochs,
} from "./lifecycle-repair-store";
import type {
  CompiledManifestLifecycle,
  DestinationClass,
  LifecycleCheckpoint,
  LifecycleOriginKind,
} from "@/lib/lifecycle/lifecycle-policy";
import type { ContinuationMode } from "@/lib/lifecycle/lifecycle-produced-event";

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

/** The default lifetime an AUTO-created review gate carries. On expiry an
 * optional gate auto-resolves (releasing its held effect) and a required gate
 * keeps blocking + notifies (ops). Flow-authored gates set NO `expires_at`, so
 * the expiry drain never touches them (its predicate is `expires_at IS NOT
 * NULL`). Seven days: long enough that a human reviewer is the norm, bounded so a
 * forgotten optional gate cannot pin an effect forever. */
export const AUTO_REVIEW_GATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The synthetic run id an auto-gate carries when the produced event names no
 * producing run (a direct upload). A durable-local upload is `user_provided` /
 * non-external, so the lattice SKIPS its review (no gate) — this fallback is only
 * reached by an anomalous run-less agent_produced event, keeping the gate
 * durable + ops-visible rather than silently dropped. */
function orphanRunId(eventId: string): string {
  return `lifecycle-orphan:${eventId}`;
}

// ---------------------------------------------------------------------------
// A minimal read-only projection of `objects` — the artifact TYPE + tenancy +
// liveness the review context resolves. Defined LOCALLY (a second pgSchema
// instance over the SAME app schema) so this agents-package store reads
// `objects.type` without depending on the host objects-store drizzle table.
// ---------------------------------------------------------------------------

const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsRef = appSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  type: text("type").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Context resolution — the axes the pure lattice needs that DO NOT live on the
// event row: the artifact TYPE, the org bound, and the producing agent's
// compiled manifest lifecycle declarations.
// ---------------------------------------------------------------------------

type ResolveContextResult =
  | { ok: true; ctx: ReviewOrchestrationContext }
  | { ok: false; reason: string };

/** Parse the JSON-as-text `agent_templates.lifecycle_config` into the compiled
 * manifest lifecycle shape. Best-effort + fail-soft: a malformed / absent value
 * yields `undefined` (the lattice then uses core defaults), never a throw. */
function parseCompiledManifest(raw: string | null): CompiledManifestLifecycle | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const checkpoints: readonly LifecycleCheckpoint[] = ["recommendation", "review", "verification"];
    const requestedSkips = Array.isArray(parsed.requestedSkips)
      ? parsed.requestedSkips.filter((c): c is LifecycleCheckpoint =>
          typeof c === "string" && (checkpoints as readonly string[]).includes(c),
        )
      : undefined;
    const producedTypes = Array.isArray(parsed.producedTypes)
      ? parsed.producedTypes.filter((t): t is string => typeof t === "string")
      : undefined;
    const repairCapable = typeof parsed.repairCapable === "boolean" ? parsed.repairCapable : undefined;
    return { requestedSkips, producedTypes, repairCapable };
  } catch {
    return undefined;
  }
}

/** Resolve the producing agent's compiled manifest lifecycle from the event's
 * `producerRunId` → the run's template → `lifecycle_config`. Best-effort: any
 * missing link yields `undefined` (core-default lattice). */
async function resolveManifest(
  producerRunId: string | null,
): Promise<CompiledManifestLifecycle | undefined> {
  if (!producerRunId) return undefined;
  try {
    const [run] = await db
      .select({ templateId: agentRuns.templateId })
      .from(agentRuns)
      .where(eq(agentRuns.id, producerRunId))
      .limit(1);
    if (!run?.templateId) return undefined;
    const [tmpl] = await db
      .select({ lifecycleConfig: agentTemplates.lifecycleConfig })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, run.templateId))
      .limit(1);
    return parseCompiledManifest(tmpl?.lifecycleConfig ?? null);
  } catch {
    return undefined;
  }
}

/** Resolve the review-orchestration context for a produced event. Returns a
 * `not-classifiable` reason when the artifact's `objects` row is missing or
 * tombstoned (the artifact was deleted between production and orchestration) —
 * the caller then leaves the artifact ungated. */
async function resolveReviewContext(event: ProducedEventRow): Promise<ResolveContextResult> {
  const [obj] = await db
    .select({ type: objectsRef.type, deletedAt: objectsRef.deletedAt })
    .from(objectsRef)
    .where(and(eq(objectsRef.id, event.artifactId), eq(objectsRef.orgId, event.orgId)))
    .limit(1);
  if (!obj) return { ok: false, reason: "objects row not found — artifact ungated" };
  if (obj.deletedAt) return { ok: false, reason: "artifact tombstoned before orchestration — ungated" };

  const originKind = event.originKind as LifecycleOriginKind;
  const destinationClass = event.destinationClass as DestinationClass;
  const orgRule = await resolveOrgPolicyRule(event.orgId, {
    checkpoint: "review",
    artifactType: obj.type,
    destinationClass,
    originKind,
  });
  const manifest = await resolveManifest(event.producerRunId);

  return {
    ok: true,
    ctx: {
      artifactType: obj.type,
      // Review's core default does NOT branch on humanPresent (only
      // recommendation does), so this is inert for the REVIEW checkpoint; it is
      // passed to keep the pure input total.
      humanPresent: false,
      orgRule,
      manifest,
    },
  };
}

// ---------------------------------------------------------------------------
// Produced-event row read.
// ---------------------------------------------------------------------------

interface ProducedEventRow {
  eventId: string;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  emitter: string;
  producerRunId: string | null;
  producerAgentId: string | null;
  originKind: string;
  destinationClass: string;
  continuationMode: string;
  continuationAddress: string | null;
  status: string;
}

function toAxes(row: ProducedEventRow): ProducedEventAxes {
  return {
    eventId: row.eventId,
    artifactId: row.artifactId,
    representationRevisionId: row.representationRevisionId,
    originKind: row.originKind as LifecycleOriginKind,
    destinationClass: row.destinationClass as DestinationClass,
    continuationMode: row.continuationMode as ContinuationMode,
  };
}

/** The full produced-outbox projection every drain reads (single-sourced so the
 * sweep, the per-run membership fetch, and the expiry re-eval agree). */
const PRODUCED_OUTBOX_COLUMNS = {
  eventId: artifactProducedOutbox.eventId,
  orgId: artifactProducedOutbox.orgId,
  artifactId: artifactProducedOutbox.artifactId,
  representationRevisionId: artifactProducedOutbox.representationRevisionId,
  emitter: artifactProducedOutbox.emitter,
  producerRunId: artifactProducedOutbox.producerRunId,
  producerAgentId: artifactProducedOutbox.producerAgentId,
  originKind: artifactProducedOutbox.originKind,
  destinationClass: artifactProducedOutbox.destinationClass,
  continuationMode: artifactProducedOutbox.continuationMode,
  continuationAddress: artifactProducedOutbox.continuationAddress,
  status: artifactProducedOutbox.status,
} as const;

/** The COMPLETE pending membership of ONE production `(orgId, producerRunId)`,
 * oldest-first, bounded. Fetching a production's full pending set (rather than a
 * raw-event fetch window) is what makes the batch seal PROVABLE over the whole
 * production, independent of the per-pass production limit. `MAX_BATCH_MEMBERSHIP`
 * caps a pathological production; a larger one seals in successor sub-batches. */
async function fetchPendingByRun(
  orgId: string,
  producerRunId: string,
  cap: number,
): Promise<ProducedEventRow[]> {
  return db
    .select(PRODUCED_OUTBOX_COLUMNS)
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.status, "pending"),
        eq(artifactProducedOutbox.orgId, orgId),
        eq(artifactProducedOutbox.producerRunId, producerRunId),
      ),
    )
    .orderBy(asc(artifactProducedOutbox.createdAt))
    .limit(cap);
}

/** Sentinel returned when a production's drain was SKIPPED because another worker
 * holds its lock this pass. */
const PRODUCTION_CONTENDED = Symbol("production-contended");

/**
 * Run `fn` under a CLUSTER-WIDE postgres advisory lock keyed on the production
 * `(orgId, producerRunId)`, so two concurrent passes never seal DIVERGENT
 * memberships of a still-growing production into overlapping gates: whoever holds
 * the lock snapshots + seals the membership exclusively; the other pass SKIPS this
 * production (returns the contended sentinel) and retries next cycle, by when the
 * holder has marked its members processed (so only genuinely-new revisions remain,
 * a clean successor batch). The lock is held on a DEDICATED pooled client for the
 * drain; the drain's own writes go through the shared `db` pool — the advisory lock
 * is a pure mutex, not tied to the data path. Released in `finally`.
 */
async function withProductionLock<T>(
  orgId: string,
  producerRunId: string,
  fn: () => Promise<T>,
): Promise<T | typeof PRODUCTION_CONTENDED> {
  const lockKey = `lifecycle-review-production::${orgId}::${producerRunId}`;
  const client = await agentBuilderPool.connect();
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey],
    );
    if (!acquired.rows[0]?.locked) return PRODUCTION_CONTENDED;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    }
  } finally {
    client.release();
  }
}

/**
 * Finish an already-linked (but still pending) event: it was gated by a prior pass
 * (a crash between the gate emit/link and the mark). Before marking processed,
 * idempotently ensure a CHECKPOINTED run's park exists — a crash between LINK and
 * PARK must never let this settle-path mark the event done while the run never
 * parked (that would bypass the checkpoint). The park is keyed on the SAME gate id
 * the event is linked to. Best-effort re-plan: an unresolvable context / async run
 * has no park to ensure, so it just marks.
 */
async function settleAlreadyLinkedEvent(row: ProducedEventRow): Promise<void> {
  if (row.continuationAddress) {
    const context = await resolveReviewContext(row);
    if (context.ok) {
      const plan = planReviewForEvent(toAxes(row), context.ctx);
      if (plan.action === "create-gate" && plan.continuationMode === "checkpointed" && plan.park) {
        await maybeParkCheckpoint(plan.park, {
          runId: row.producerRunId ?? orphanRunId(row.eventId),
          eventId: row.eventId,
          policyDecisionId: row.continuationAddress,
        });
      }
    }
  }
  await markProducedEventProcessed(row.eventId);
}

// ---------------------------------------------------------------------------
// The per-event orchestration (idempotent).
// ---------------------------------------------------------------------------

export type OrchestrateOutcome =
  | "gate-created"
  | "no-gate"
  | "not-classifiable"
  | "already-processed";

/**
 * Orchestrate ONE produced event: resolve context, plan the REVIEW checkpoint,
 * apply the plan (idempotent gate + effect linkage + checkpointed park), and mark
 * the event processed. Total + idempotent — a replay re-derives the same gate key
 * and parks the same (run,event,checkpoint), so re-running never duplicates.
 */
export async function orchestrateProducedEvent(row: ProducedEventRow): Promise<OrchestrateOutcome> {
  if (row.status !== "pending") return "already-processed";
  // A still-pending event that ALREADY carries a gate linkage was orchestrated by
  // a prior pass (a gate emitted + linked, but a crash before the mark). It must
  // NOT be re-gated (which would orphan a second gate); finish it — ensuring a
  // checkpointed run's park (park-safe) before marking. Keeps the per-event and
  // batch paths idempotent against each other under a mid-pass crash + re-sweep.
  if (row.continuationAddress) {
    await settleAlreadyLinkedEvent(row);
    return "already-processed";
  }

  const context = await resolveReviewContext(row);
  if (!context.ok) {
    await markProducedEventProcessed(row.eventId);
    return "not-classifiable";
  }

  const plan = planReviewForEvent(toAxes(row), context.ctx);

  if (plan.action === "no-gate") {
    await markProducedEventProcessed(row.eventId);
    return "no-gate";
  }

  // create-gate. The producing run is the gate's run when known; a run-less
  // agent_produced event falls back to a synthetic, ops-visible id.
  const runId = row.producerRunId ?? orphanRunId(row.eventId);
  let gateId: string;
  try {
    const emitted = await emitArtifactReviewGate({
      runId,
      orgId: row.orgId,
      reviewTaskId: plan.reviewTaskId,
      targets: [{ artifactId: row.artifactId, representationRevisionId: row.representationRevisionId }],
      expiresAt: new Date(Date.now() + AUTO_REVIEW_GATE_TTL_MS),
    });
    gateId = emitted.gateId;
    // cinatra#2066 C2 — a NEW auto-gate just opened: fire the run-view
    // notification for its reviewer-resolvable audience. Only on a genuinely new
    // emit (`!idempotent`) so a replay / re-sweep never re-notifies, and only for
    // a REAL producing run (a synthetic orphan id resolves to no run, so the host
    // seam skips it — but gating here keeps the intent explicit). Best-effort by
    // construction: `dispatchAutoGateOpen` swallows every error so a notification
    // failure can never fail orchestration.
    if (!emitted.idempotent && row.producerRunId) {
      await dispatchAutoGateOpen({ runId, reviewTaskId: plan.reviewTaskId });
    }
  } catch (err) {
    // A pin-conflict means a DIFFERENT gate already occupies (run, task) — an
    // invariant violation for a deterministic auto-task id. Leave the event
    // pending (do NOT mark processed) so a later sweep / ops can reconcile.
    if (err instanceof ArtifactReviewGateError) {
      console.error(
        `[lifecycle-review-orchestration] gate emit conflict for event=${row.eventId} run=${runId}: ${err.message}`,
      );
      return "no-gate";
    }
    throw err;
  }

  // CHECKPOINTED mode: the producing run PARKS on the review decision. The park's
  // policy-decision id is the gate id (the maintenance drain releases the park once
  // the gate resolves). ASYNC mode never parks (`plan.park` is null). PARK BEFORE
  // LINK so `linked ⟹ parked`: a crash between link and park (with the artifact
  // then tombstoned, so a re-plan can no longer resolve context) must never let the
  // settle path mark a linked checkpointed event processed without a park.
  if (plan.continuationMode === "checkpointed" && plan.park) {
    await maybeParkCheckpoint(plan.park, {
      runId,
      eventId: row.eventId,
      policyDecisionId: gateId,
    });
  }

  // Link the gate onto the event (the effects-gating join). Only stamp when
  // unset so a replay never re-points a live linkage.
  //
  // RETRY-CONVERGENT SEAM (cinatra#2065 Seam B). The create-gate and this link are
  // two statements; an interruption between them leaves the event PENDING and
  // UNLINKED (the gate exists, `continuation_address` still null,
  // `markProducedEventProcessed` never ran). Unlike the repair successor seam
  // (Seam A), this does NOT need one transaction: the event stays pending, so the
  // next orchestration sweep RE-PLANS it → `emitArtifactReviewGate` re-emits
  // IDEMPOTENTLY onto the SAME deterministic (run, task) with the SAME single
  // target (returns the existing gate) → this link stamps (still null) → the event
  // is marked processed. The re-emit carries no caller-varying target (the target
  // is the event's own artifact/revision), so no pin conflict is reachable and no
  // gate is stranded — the strand self-heals on the very next sweep. Proven by the
  // orchestration integration suite's create→link crash-window case.
  await db
    .update(artifactProducedOutbox)
    .set({ continuationAddress: gateId })
    .where(and(eq(artifactProducedOutbox.eventId, row.eventId), isNull(artifactProducedOutbox.continuationAddress)));

  await markProducedEventProcessed(row.eventId);
  return "gate-created";
}

// ---------------------------------------------------------------------------
// The orchestration drain (recurring worker cycle).
// ---------------------------------------------------------------------------

export interface ReviewOrchestrationSweepSummary {
  scanned: number;
  gatesCreated: number;
  noGate: number;
  notClassifiable: number;
  failed: number;
  /** How many multi-artifact PRODUCTIONS were coalesced into a sealed batch this
   * pass (each may fan into several ≤50-target partition gates, counted in
   * `gatesCreated`). Zero when every pending event is a single-artifact production. */
  batchesCoalesced: number;
}

function tallyOutcome(outcome: OrchestrateOutcome, summary: ReviewOrchestrationSweepSummary): void {
  if (outcome === "gate-created") summary.gatesCreated += 1;
  else if (outcome === "no-gate" || outcome === "already-processed") summary.noGate += 1;
  else summary.notClassifiable += 1;
}

/** Cap on the pending events sealed into ONE production's batch per pass. A
 * production larger than this seals in successor sub-batches (each a valid sealed
 * batch); bounds the per-production membership fetch + the pinned-target loops. */
export const MAX_BATCH_MEMBERSHIP = 1000;

/**
 * Drain a batch of PENDING produced events into review gates. FENCED: a no-op
 * when the S1 activation fence is off (defence-in-depth — the emitters already
 * write no event row, so the pending set is empty, but a manually-enqueued tick
 * still short-circuits). Per-event failures are TALLIED (never rethrown) so one
 * bad row can never poison the drain; the event stays pending for the next cycle.
 *
 * COALESCING (S0 batch contract): pending events are grouped by their PRODUCTION —
 * `(orgId, producerRunId)`. A single-artifact production (a lone event, or a
 * run-less direct upload) orchestrates per-event, one gate per artifact — the
 * standard path. A MULTI-artifact production (the same run's several pending
 * revisions) COALESCES: its fired targets are sealed into one explicit membership,
 * partitioned into deterministic ≤50-target partitions, and each partition becomes
 * ONE gate whose terminal decision commits atomically across its targets (a single
 * aggregate commit). See `orchestrateProducedBatch`.
 */
export async function sweepReviewOrchestration(opts?: {
  limit?: number;
}): Promise<ReviewOrchestrationSweepSummary> {
  const summary: ReviewOrchestrationSweepSummary = {
    scanned: 0,
    gatesCreated: 0,
    noGate: 0,
    notClassifiable: 0,
    failed: 0,
    batchesCoalesced: 0,
  };
  if (!isLifecycleReviewOrchestrationActive()) return summary;

  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));

  // 1. Run-backed PRODUCTIONS with pending events (oldest production first, bounded
  //    by the pass budget). Grouping in SQL means the coalescing membership never
  //    depends on a raw-event fetch window.
  const productionKeys = await db
    .select({
      orgId: artifactProducedOutbox.orgId,
      producerRunId: artifactProducedOutbox.producerRunId,
    })
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.status, "pending"),
        isNotNull(artifactProducedOutbox.producerRunId),
      ),
    )
    .groupBy(artifactProducedOutbox.orgId, artifactProducedOutbox.producerRunId)
    .orderBy(asc(sql`min(${artifactProducedOutbox.createdAt})`))
    .limit(limit);

  for (const key of productionKeys) {
    if (!key.producerRunId) continue; // isNotNull-filtered; guards the type.
    const runId = key.producerRunId;
    try {
      // Snapshot + seal the production's COMPLETE membership under an exclusive
      // per-production lock, so a concurrent pass can never seal a divergent
      // membership of a still-growing production into overlapping gates.
      await withProductionLock(key.orgId, runId, async () => {
        const members = await fetchPendingByRun(key.orgId, runId, MAX_BATCH_MEMBERSHIP);
        if (members.length === 0) return; // raced to processed by a concurrent pass.
        summary.scanned += members.length;
        // Route through the DURABLE-epoch batch path when the production is a
        // multi-artifact one OR an OPEN epoch already exists — a SOLE remaining
        // frozen member (a crash left one unlinked) MUST resume via the frozen
        // membership, never via the single-event path (which would emit an
        // overlapping per-event gate instead of the frozen partition gate).
        const open = await resolveOpenBatchEpoch(key.orgId, runId);
        if (members.length > 1 || open) {
          await orchestrateProducedBatch(members, summary);
        } else {
          tallyOutcome(await orchestrateProducedEvent(members[0]), summary);
        }
      });
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-review-orchestration] production drain failed for run=${runId} — left pending:`,
        err,
      );
    }
  }

  // 2. Run-less pending events (a direct upload, no shared production, never
  //    coalesces), per-event, bounded by the same pass budget.
  const orphans = await db
    .select(PRODUCED_OUTBOX_COLUMNS)
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.status, "pending"),
        isNull(artifactProducedOutbox.producerRunId),
      ),
    )
    .orderBy(asc(artifactProducedOutbox.createdAt))
    .limit(limit);
  for (const row of orphans) {
    summary.scanned += 1;
    try {
      tallyOutcome(await orchestrateProducedEvent(row), summary);
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-review-orchestration] orchestrate failed for event=${row.eventId} — left pending:`,
        err,
      );
    }
  }

  // 3. Independent OPEN-EPOCH drain: close any sealed epoch whose members are ALL
  //    processed (a crash between the final member mark and `closeBatchEpoch` leaves
  //    the production with NO pending events, so the pending-keyed sweep above never
  //    revisits it — the stranded open epoch would otherwise block a successor epoch
  //    forever via the open-uniq index). Under the production lock so it never races
  //    a live seal/recovery.
  try {
    for (const epoch of await listOpenBatchEpochs(limit)) {
      await withProductionLock(epoch.orgId, epoch.producerRunId, async () => {
        // Re-read under the lock — a concurrent recovery may have just closed it.
        const stillOpen = await resolveOpenBatchEpoch(epoch.orgId, epoch.producerRunId);
        if (stillOpen && stillOpen.id === epoch.id && (await epochFullyProcessed(epoch.membership))) {
          await closeBatchEpoch(epoch.id);
        }
      });
    }
  } catch (err) {
    console.error(`[lifecycle-review-orchestration] open-epoch drain failed:`, err);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Batch coalescing (multi-artifact production → sealed membership → ≤50-target
// partition gates, per the S0 lifecycle-batch contract).
// ---------------------------------------------------------------------------

/** The local equality key joining a produced event / partition target back to its
 * fired plan. LENGTH-PREFIXES the artifact id (`<len>:<artifactId>:<revisionId>`)
 * so the join is INJECTIVE for arbitrary opaque ids — a bare separator would
 * collide `{a, "b:c"}` with `{"a:b", c}` and silently drop a member from
 * `firedByKey` while the gate still pins it (same guarantee the batch module's key
 * gives). */
function targetKey(t: { artifactId: string; representationRevisionId: string }): string {
  return `${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`;
}

type FiredCreateGate = { row: ProducedEventRow; plan: Extract<ReviewOrchestrationPlan, { action: "create-gate" }> };

/**
 * Coalesce ONE multi-artifact production (a run's several pending revisions) into
 * sealed, partitioned aggregate review gates, per the S0 batch contract:
 *
 *   1. Per event: resolve context + plan the REVIEW checkpoint. A `no-gate` /
 *      not-classifiable / already-linked event is SETTLED inline (marked processed);
 *      only FIRED events (`create-gate`) join the batch — a coalesced review scopes
 *      exactly the production's gated revisions.
 *   2. SEAL the fired membership as an EXPLICIT target list (`sealBatch`) — an
 *      explicit list seals immediately, so the seal is provable (the returned
 *      `sealed:true` is the proof the set is frozen; a later arrival is a SUCCESSOR
 *      batch, carry-forward is S2).
 *   3. PARTITION the sealed set into deterministic ≤50-target partitions
 *      (`partitionBatchTargets`) — each partition is one per-gate atomicity unit.
 *   4. Per partition: emit ONE gate pinning the partition's targets (idempotent on
 *      the deterministic partition task id); then, in ORDER: park every checkpointed
 *      member, ATOMICALLY link ALL members onto the gate (one UPDATE), and only THEN
 *      mark every member processed. The gate's terminal decision commits atomically
 *      across the partition (a single aggregate commit).
 *
 * CRASH-IDEMPOTENT by the phase order (park -> link-all -> mark-all): a member is
 * marked processed ONLY after every member of its partition is linked. So on a
 * re-sweep a not-yet-finished member is EITHER already linked (settled park-safe,
 * never re-gated) OR, if unlinked, NO member of its partition was marked -> the whole
 * partition is still pending -> it reseals to the SAME deterministic gate id (emit is
 * idempotent on the pinned set), never a duplicate/overlapping gate. `park` precedes
 * `link` so a linked member is always already parked. A per-partition emit conflict
 * leaves that partition's events pending for a reconciling sweep.
 *
 * DURABLE SEAL (cinatra#2040 S2): the sealed membership is now PERSISTED as a
 * `lifecycle_batch_epoch` row BEFORE any gate emit — this CLOSES S1's documented
 * crash-window. Under the exclusive `withProductionLock`, `sealBatchEpoch` either
 * finds an OPEN epoch (a prior pass sealed it, then crashed mid-partition) and
 * returns its FROZEN membership, or seals the current fired candidate. The
 * partition ids are derived from the FROZEN membership, so a re-sweep processes
 * EXACTLY the sealed set — never a grown pending snapshot. A NEW revision that
 * arrived after the seal is NOT in the frozen membership; it stays pending and
 * seals a SUCCESSOR epoch once this one CLOSES (`closeBatchEpoch`, after every
 * frozen member is gated+linked+marked). So the S1 residual (a crash between emit
 * and link + a new same-run revision → an overlapping gate) can no longer occur.
 */
async function orchestrateProducedBatch(
  group: ProducedEventRow[],
  summary: ReviewOrchestrationSweepSummary,
): Promise<void> {
  const orgId = group[0].orgId;
  const runId = group[0].producerRunId!;

  const fired: FiredCreateGate[] = [];
  for (const row of group) {
    // Already linked by a prior (crashed) pass — finish it PARK-SAFE, never re-gate.
    if (row.continuationAddress) {
      await settleAlreadyLinkedEvent(row);
      continue;
    }
    const context = await resolveReviewContext(row);
    if (!context.ok) {
      await markProducedEventProcessed(row.eventId);
      summary.notClassifiable += 1;
      continue;
    }
    const plan = planReviewForEvent(toAxes(row), context.ctx);
    if (plan.action === "no-gate") {
      await markProducedEventProcessed(row.eventId);
      summary.noGate += 1;
      continue;
    }
    fired.push({ row, plan });
  }
  if (fired.length === 0) {
    // No firing members this pass, but a prior epoch may be fully processed yet
    // still open (a crash between the last mark and the close) — close it so the
    // next new revision seals a successor. Cheap: at most one open epoch per run.
    await closeOpenEpochIfDrained(orgId, runId);
    return;
  }

  // DURABLE SEAL: persist (or recover) the sealed membership BEFORE any gate emit.
  const { epoch, reused } = await sealBatchEpoch({
    orgId,
    producerRunId: runId,
    candidateMembers: fired.map((f) => ({
      artifactId: f.row.artifactId,
      representationRevisionId: f.row.representationRevisionId,
    })),
  });
  const frozenMembership = epoch.membership;
  const partitions = partitionBatchTargets(frozenMembership);
  if (!reused) summary.batchesCoalesced += 1;

  // Map the FROZEN membership targets → their current fired plan (only the
  // still-pending members carry one; already-processed members on a crash-recovery
  // pass are absent → their partition gate re-emits idempotently but nothing to
  // park/link/mark). A NEW revision that fired but is NOT in the frozen membership
  // stays pending (it seals a successor epoch after this one closes).
  const firedByKey = new Map<string, FiredCreateGate>();
  for (const f of fired) firedByKey.set(targetKey(f.row), f);

  const expiresAt = new Date(Date.now() + AUTO_REVIEW_GATE_TTL_MS);
  let anyConflict = false;
  for (const partition of partitions) {
    const reviewTaskId = batchPartitionReviewTaskId(partition);
    let gateId: string;
    let gateIdempotent: boolean;
    try {
      const emitted = await emitArtifactReviewGate({
        runId,
        orgId,
        reviewTaskId,
        targets: partition,
        expiresAt,
      });
      gateId = emitted.gateId;
      gateIdempotent = emitted.idempotent;
    } catch (err) {
      if (err instanceof ArtifactReviewGateError) {
        anyConflict = true;
        console.error(
          `[lifecycle-review-orchestration] batch partition gate emit conflict for run=${runId} task=${reviewTaskId}: ${err.message} — partition left pending`,
        );
        continue; // leave this partition's events pending for a reconciling sweep.
      }
      throw err;
    }
    // Count a gate only on a FRESH emit (a re-sweep re-emitting the same frozen
    // partition is idempotent — never double-count).
    if (!gateIdempotent) summary.gatesCreated += 1;

    const members = partition
      .map((t) => firedByKey.get(targetKeyOf(t)))
      .filter((m): m is FiredCreateGate => m !== undefined);
    if (members.length === 0) continue; // all this partition's members already processed.

    // Phase 1: PARK every checkpointed member (idempotent on run,event,checkpoint)
    // BEFORE linking, so a linked member is always already parked.
    for (const m of members) {
      if (m.plan.continuationMode === "checkpointed" && m.plan.park) {
        await maybeParkCheckpoint(m.plan.park, {
          runId,
          eventId: m.row.eventId,
          policyDecisionId: gateId,
        });
      }
    }
    // Phase 2: ATOMICALLY link ALL members onto the gate in ONE update (guard
    // isNull so a concurrent pass that emitted the SAME deterministic gate never
    // re-points a live linkage).
    await db
      .update(artifactProducedOutbox)
      .set({ continuationAddress: gateId })
      .where(
        and(
          inArray(
            artifactProducedOutbox.eventId,
            members.map((m) => m.row.eventId),
          ),
          isNull(artifactProducedOutbox.continuationAddress),
        ),
      );
    // Phase 3: mark every member processed — ONLY now that ALL are linked.
    for (const m of members) {
      await markProducedEventProcessed(m.row.eventId);
    }
  }

  // CLOSE the epoch once every frozen member is processed (no partition conflict
  // left one pending). A conflict leaves the epoch OPEN so the next sweep retries
  // (idempotently, onto the same frozen membership).
  if (!anyConflict && (await epochFullyProcessed(frozenMembership))) {
    await closeBatchEpoch(epoch.id);
  }
}

/** Whether every target in a frozen membership has a NON-pending produced event
 * (all gated+linked+marked). Bounds the IN by MAX_BATCH_MEMBERSHIP. */
async function epochFullyProcessed(membership: Array<{ artifactId: string; representationRevisionId: string }>): Promise<boolean> {
  if (membership.length === 0) return true;
  const eventIds = membership.map((t) => producedEventId(t.artifactId, t.representationRevisionId, "artifact_produced"));
  const [row] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(artifactProducedOutbox)
    .where(
      and(
        inArray(artifactProducedOutbox.eventId, eventIds),
        eq(artifactProducedOutbox.status, "pending"),
      ),
    );
  return (row?.pending ?? 0) === 0;
}

/** Close a still-open epoch whose members are all processed (a crash between the
 * last mark and the close). No-op when there is no open epoch or it still has
 * pending members. */
async function closeOpenEpochIfDrained(orgId: string, producerRunId: string): Promise<void> {
  const open = await resolveOpenBatchEpoch(orgId, producerRunId);
  if (!open) return;
  if (await epochFullyProcessed(open.membership)) {
    await closeBatchEpoch(open.id);
  }
}

/** The canonical INJECTIVE target key (length-prefixed) for a batch target — the
 * same construction as the module-private `targetKey`, over a plain target. */
function targetKeyOf(t: { artifactId: string; representationRevisionId: string }): string {
  return `${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`;
}

// ---------------------------------------------------------------------------
// Effects-gating predicate (the store half of `isArtifactEffectHeld`).
// ---------------------------------------------------------------------------

/**
 * Decide whether an artifact revision's downstream EXTERNAL effect is held by a
 * pending review. The external-effect paths (publish / visibility promotion /
 * pipeline hand-off) call this BEFORE acting: an ungated / non-external artifact
 * flows immediately; an external one is HELD fail-closed until its review gate
 * resolves. Pure verdict via `evaluateEffectHold`; this half resolves the facts
 * (the produced-event row + its linked gate status).
 */
export async function isArtifactEffectHeld(input: {
  artifactId: string;
  representationRevisionId: string;
  eventKind?: ProducedEventKind;
}): Promise<EffectHoldVerdict> {
  const eventId = producedEventId(
    input.artifactId,
    input.representationRevisionId,
    input.eventKind ?? "artifact_produced",
  );
  const [event] = await db
    .select({
      destinationClass: artifactProducedOutbox.destinationClass,
      status: artifactProducedOutbox.status,
      continuationAddress: artifactProducedOutbox.continuationAddress,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);

  if (!event) return evaluateEffectHold({ event: null, gateStatus: null });

  let gateStatus: "pending" | "resolved" | null = null;
  let gateDisposition: "approve" | "reject" | "changes_requested" | null = null;
  if (event.continuationAddress) {
    const [gate] = await db
      .select({ status: artifactReviewGates.status, disposition: artifactReviewGates.disposition })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, event.continuationAddress))
      .limit(1);
    gateStatus = gate ? (gate.status === "resolved" ? "resolved" : "pending") : null;
    // S2 (cinatra#2040): a gate resolved as `changes_requested` keeps HOLDING the
    // effect (a repair is in flight) — thread the terminal disposition so the pure
    // verdict can distinguish it from an approve/reject resolution.
    gateDisposition = (gate?.disposition as "approve" | "reject" | "changes_requested" | null) ?? null;
  }

  return evaluateEffectHold({
    event: {
      destinationClass: event.destinationClass as DestinationClass,
      status: event.status,
      continuationAddress: event.continuationAddress,
    },
    gateStatus,
    gateDisposition,
  });
}

/** The disposition-aware verdict of a captured external effect (cinatra#2043 S5
 * — the connector CMS-review seam's apply gate). A plain held/not-held cannot
 * tell `approve` from `reject` (both are "not held", but a rejected effect must
 * NEVER be applied), so this widens `isArtifactEffectHeld` into the five states
 * the connector's `resolveDisposition` seam consumes:
 *   - `held`     — the review gate is pending (or a repair is in flight); HOLD.
 *   - `approved` — the gate resolved `approve`; the effect is released → APPLY.
 *   - `rejected` — the gate resolved `reject`; the effect is tombstoned → REFUSE.
 *   - `ungated`  — the org lattice permitted the effect without a gate → APPLY.
 *   - `unknown`  — no capture / an incoherent resolved state → fail-closed REFUSE. */
export type ArtifactEffectDisposition = "held" | "approved" | "rejected" | "ungated" | "unknown";

/**
 * Resolve the disposition of an artifact revision's downstream EXTERNAL effect —
 * the disposition-aware companion of `isArtifactEffectHeld`. Reads the SAME facts
 * (the produced-event outbox row + its linked review gate) and reuses the pure
 * `evaluateEffectHold` verdict for the hold decision, then distinguishes an
 * approved release from a rejected tombstone via the gate's terminal disposition.
 * The connector's `@cinatra-ai/host:cms-review` `resolveDisposition` seam binds
 * this: the effect is held while the gate is pending, applied only on an
 * `approve`, and refused (fail-closed) on a `reject` / an indeterminate state.
 */
export async function resolveArtifactEffectDisposition(input: {
  artifactId: string;
  representationRevisionId: string;
  eventKind?: ProducedEventKind;
}): Promise<{ disposition: ArtifactEffectDisposition; gate: { gateId: string; runId: string } | null }> {
  const eventId = producedEventId(
    input.artifactId,
    input.representationRevisionId,
    input.eventKind ?? "artifact_produced",
  );
  const [event] = await db
    .select({
      destinationClass: artifactProducedOutbox.destinationClass,
      status: artifactProducedOutbox.status,
      continuationAddress: artifactProducedOutbox.continuationAddress,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);

  // No produced event for this revision — nothing was captured. Fail-closed:
  // the connector treats `unknown` as REFUSE (never a silent apply on a phantom).
  if (!event) return { disposition: "unknown", gate: null };

  let gateStatus: "pending" | "resolved" | null = null;
  let gateDisposition: "approve" | "reject" | "changes_requested" | null = null;
  let gateRef: { gateId: string; runId: string } | null = null;
  if (event.continuationAddress) {
    const [gate] = await db
      .select({
        id: artifactReviewGates.id,
        runId: artifactReviewGates.runId,
        status: artifactReviewGates.status,
        disposition: artifactReviewGates.disposition,
      })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, event.continuationAddress))
      .limit(1);
    if (gate) {
      gateRef = { gateId: gate.id, runId: gate.runId };
      gateStatus = gate.status === "resolved" ? "resolved" : "pending";
      gateDisposition = (gate.disposition as "approve" | "reject" | "changes_requested" | null) ?? null;
    }
  }

  const verdict = evaluateEffectHold({
    event: {
      destinationClass: event.destinationClass as DestinationClass,
      status: event.status,
      continuationAddress: event.continuationAddress,
    },
    gateStatus,
    gateDisposition,
  });

  // HELD: the gate is pending (or a repair is in flight, `changes_requested`), or
  // an external effect awaits orchestration (fail-closed) — the connector holds.
  if (verdict.held) return { disposition: "held", gate: gateRef };

  // NOT held. An event with no continuation address is either non-external or
  // org-`forbidden` (the lattice permitted the effect without a gate) → ungated.
  if (!event.continuationAddress) return { disposition: "ungated", gate: null };

  // A continuation address that no longer resolves to a gate row is incoherent —
  // never apply on a vanished gate.
  if (!gateRef) return { disposition: "unknown", gate: null };

  // A resolved gate: approve releases (apply), reject tombstones (refuse).
  if (gateDisposition === "approve") return { disposition: "approved", gate: gateRef };
  if (gateDisposition === "reject") return { disposition: "rejected", gate: gateRef };

  // Resolved-but-no-terminal-disposition (or a value the effect-hold verdict did
  // not classify as still-held) is indeterminate → fail-closed.
  return { disposition: "unknown", gate: gateRef };
}

// ---------------------------------------------------------------------------
// The disposition + TTL/expiry + park-release maintenance drain.
// ---------------------------------------------------------------------------

export interface GateMaintenanceSummary {
  tombstonesApplied: number;
  tombstoneFailures: number;
  optionalExpired: number;
  requiredExpiredBlocked: number;
  parksReleased: number;
}

/**
 * The maintenance drain (one pass). FENCED (no-op when the S1 fence is off).
 * Three idempotent sub-drains:
 *
 *   1. REJECT TOMBSTONES — apply each pending `artifact_review_dispositions` row
 *      (a review reject) to the objects store via the canonical soft-delete, then
 *      stamp `applied_at`. Per-row isolated; one failure never blocks the rest.
 *   2. EXPIRY — resolve due auto-gates (`expires_at <= now()`, still pending). An
 *      OPTIONAL gate auto-resolves (releasing its held effect); a REQUIRED gate is
 *      LEFT pending (its effect stays blocked) and re-NOTIFIED (a required review
 *      that expired unactioned is a genuine ops alert).
 *   3. PARK RELEASE — release checkpointed review parks whose auto-gate has
 *      RESOLVED (human decision or optional-expiry auto-resolve), so the parked
 *      producing run continues.
 */
export async function sweepLifecycleGateMaintenance(opts?: {
  limit?: number;
}): Promise<GateMaintenanceSummary> {
  const summary: GateMaintenanceSummary = {
    tombstonesApplied: 0,
    tombstoneFailures: 0,
    optionalExpired: 0,
    requiredExpiredBlocked: 0,
    parksReleased: 0,
  };
  if (!isLifecycleReviewOrchestrationActive()) return summary;
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));

  // 1. Reject-tombstone application.
  await applyPendingTombstones(limit, summary);
  // 2. Expiry resolution (may auto-resolve optional gates → releases their parks
  //    in step 3 this same pass).
  await resolveExpiredAutoGates(limit, summary);
  // 3. Park release for resolved auto-gates.
  await releaseResolvedAutoGateParks(limit, summary);

  return summary;
}

async function applyPendingTombstones(limit: number, summary: GateMaintenanceSummary): Promise<void> {
  const pending = await db
    .select({
      id: artifactReviewDispositions.id,
      orgId: artifactReviewDispositions.orgId,
      artifactId: artifactReviewDispositions.artifactId,
      kind: artifactReviewDispositions.kind,
    })
    .from(artifactReviewDispositions)
    .where(isNull(artifactReviewDispositions.appliedAt))
    .orderBy(asc(artifactReviewDispositions.createdAt))
    .limit(limit);
  if (pending.length === 0) return;

  // The canonical soft-delete builder (objects tombstone + graphiti delete outbox
  // + change_set + object_change_event, one atomic CTE). Dynamic import keeps the
  // host objects-store graph off this module's synchronous load. In a worker there
  // is no actor frame, so its cross-tenant write-scope guard is inert (it enforces
  // only against a present non-admin actor).
  const { buildSoftDeleteObjectQuery } = await import("@/lib/objects-store");

  for (const disp of pending) {
    // The disposition op union admits ONLY 'tombstone' (a review can never hard
    // delete); ignore any other kind defensively.
    if (disp.kind !== "tombstone") continue;
    try {
      const { query } = buildSoftDeleteObjectQuery({
        id: disp.artifactId,
        orgId: disp.orgId,
        actorKind: "system",
      });
      // Run the tombstone then stamp applied_at. Not a single tx: the soft-delete
      // is idempotent (its UPDATE guards `deleted_at IS NULL`), and the applied_at
      // stamp guards `applied_at IS NULL`, so a crash between them re-drives a
      // no-op tombstone next pass and still stamps.
      await agentBuilderPool.query(query.text, query.values);
      const marked = await db
        .update(artifactReviewDispositions)
        .set({ appliedAt: sql`now()` })
        .where(
          and(
            eq(artifactReviewDispositions.id, disp.id),
            isNull(artifactReviewDispositions.appliedAt),
          ),
        )
        .returning({ id: artifactReviewDispositions.id });
      if (marked.length === 1) summary.tombstonesApplied += 1;
    } catch (err) {
      summary.tombstoneFailures += 1;
      console.error(
        `[lifecycle-gate-maintenance] tombstone application failed for disposition=${disp.id} artifact=${disp.artifactId} — left pending:`,
        err,
      );
    }
  }
}

async function resolveExpiredAutoGates(limit: number, summary: GateMaintenanceSummary): Promise<void> {
  const due = await db
    .select({
      id: artifactReviewGates.id,
      runId: artifactReviewGates.runId,
      reviewTaskId: artifactReviewGates.reviewTaskId,
    })
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.status, "pending"),
        sql`${artifactReviewGates.expiresAt} IS NOT NULL`,
        lte(artifactReviewGates.expiresAt, sql`now()`),
      ),
    )
    .limit(limit);

  for (const gate of due) {
    // Only AUTO gates carry an expiry; a flow-authored gate never does. Skip a
    // non-auto reviewTaskId defensively (it would have no re-evaluable event).
    if (!isAutoReviewTaskId(gate.reviewTaskId)) continue;
    const required = await isExpiredGateRequired(gate.reviewTaskId, gate.id);
    if (required) {
      // BLOCK + NOTIFY: keep the gate pending so its external effect stays held;
      // surface the unactioned required review to ops each cycle.
      summary.requiredExpiredBlocked += 1;
      console.warn(
        `[lifecycle-gate-maintenance] required review gate ${gate.id} (task=${gate.reviewTaskId}) EXPIRED unactioned — effect remains blocked pending a human decision`,
      );
      continue;
    }
    // OPTIONAL: auto-resolve (CAS pending→resolved), releasing the held effect.
    // The gate's disposition CHECK admits only the terminal 'approve'/'reject';
    // an expired optional review LAPSES into a release (the effect is permitted to
    // flow), so it resolves as 'approve'. The synthetic `expiry:<gateId>`
    // fingerprint is the auditable marker distinguishing an auto-expiry resolution
    // from a real human decision (whose fingerprint is a content hash) and keeps
    // the resolved-gate CHECK (disposition + fingerprint + resolved_at) satisfied.
    const resolved = await db
      .update(artifactReviewGates)
      .set({
        status: "resolved",
        disposition: "approve",
        fingerprint: `expiry:${gate.id}`,
        resolvedAt: sql`now()`,
      })
      .where(and(eq(artifactReviewGates.id, gate.id), eq(artifactReviewGates.status, "pending")))
      .returning({ id: artifactReviewGates.id });
    if (resolved.length === 1) summary.optionalExpired += 1;
  }
}

/** Re-derive whether an expired auto-gate's REVIEW is org-REQUIRED, by re-running
 * the pure lattice over the gate's original produced event(s). Fail-CLOSED: if the
 * event or its context cannot be resolved, treat the gate as required (keep
 * blocking) rather than risk auto-releasing a required gate.
 *
 * A BATCH partition gate (`lifecycle-review:batch:`) encodes no single event id, so
 * it is re-derived from its PINNED target set: the batch is required iff ANY of its
 * targets' reviews is org-required (fail-closed — any unresolvable target keeps the
 * whole partition blocking), matching the single-gate posture per target. */
async function isExpiredGateRequired(reviewTaskId: string, gateId?: string): Promise<boolean> {
  if (isBatchAutoReviewTaskId(reviewTaskId)) {
    if (!gateId) return true; // fail-closed: cannot resolve the batch's targets.
    return isExpiredBatchGateRequired(gateId);
  }
  const eventId = autoReviewEventId(reviewTaskId);
  if (!eventId) return true; // not an auto-gate → fail-closed (should be unreachable).
  const [row] = await db
    .select({
      eventId: artifactProducedOutbox.eventId,
      orgId: artifactProducedOutbox.orgId,
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
      emitter: artifactProducedOutbox.emitter,
      producerRunId: artifactProducedOutbox.producerRunId,
      producerAgentId: artifactProducedOutbox.producerAgentId,
      originKind: artifactProducedOutbox.originKind,
      destinationClass: artifactProducedOutbox.destinationClass,
      continuationMode: artifactProducedOutbox.continuationMode,
      continuationAddress: artifactProducedOutbox.continuationAddress,
      status: artifactProducedOutbox.status,
    })
    .from(artifactProducedOutbox)
    .where(eq(artifactProducedOutbox.eventId, eventId))
    .limit(1);
  if (!row) return true; // fail-closed: unknown provenance → keep blocking.
  const context = await resolveReviewContext(row);
  if (!context.ok) return true; // fail-closed.
  const plan = planReviewForEvent(toAxes(row), context.ctx);
  return plan.action === "create-gate" && plan.outcome === "required";
}

/** Re-derive an expired BATCH partition gate's requiredness from its PINNED target
 * set: required iff ANY target's review is org-required. Fail-CLOSED per target (a
 * missing event, an unresolvable context, or an un-firing re-eval all keep the
 * whole partition blocking) — an all-optional expired batch lapses into a release,
 * exactly like a single optional gate. */
async function isExpiredBatchGateRequired(gateId: string): Promise<boolean> {
  const [gate] = await db
    .select({ pinnedTargets: artifactReviewGates.pinnedTargets })
    .from(artifactReviewGates)
    .where(eq(artifactReviewGates.id, gateId))
    .limit(1);
  const targets = (gate?.pinnedTargets ?? []) as Array<{
    artifactId: string;
    representationRevisionId: string;
  }>;
  if (targets.length === 0) return true; // fail-closed: no re-evaluable membership.

  for (const target of targets) {
    const eventId = producedEventId(target.artifactId, target.representationRevisionId, "artifact_produced");
    const [row] = await db
      .select({
        eventId: artifactProducedOutbox.eventId,
        orgId: artifactProducedOutbox.orgId,
        artifactId: artifactProducedOutbox.artifactId,
        representationRevisionId: artifactProducedOutbox.representationRevisionId,
        emitter: artifactProducedOutbox.emitter,
        producerRunId: artifactProducedOutbox.producerRunId,
        producerAgentId: artifactProducedOutbox.producerAgentId,
        originKind: artifactProducedOutbox.originKind,
        destinationClass: artifactProducedOutbox.destinationClass,
        continuationMode: artifactProducedOutbox.continuationMode,
        continuationAddress: artifactProducedOutbox.continuationAddress,
        status: artifactProducedOutbox.status,
      })
      .from(artifactProducedOutbox)
      .where(eq(artifactProducedOutbox.eventId, eventId))
      .limit(1);
    if (!row) return true; // fail-closed: a pinned target with no re-derivable event.
    const context = await resolveReviewContext(row);
    if (!context.ok) return true; // fail-closed.
    const plan = planReviewForEvent(toAxes(row), context.ctx);
    if (plan.action === "create-gate" && plan.outcome === "required") return true;
  }
  return false; // all targets resolved + none required → auto-resolvable.
}

async function releaseResolvedAutoGateParks(limit: number, summary: GateMaintenanceSummary): Promise<void> {
  const parks = await db
    .select({
      id: lifecycleContinuationPark.id,
      policyDecisionId: lifecycleContinuationPark.policyDecisionId,
    })
    .from(lifecycleContinuationPark)
    .where(
      and(
        eq(lifecycleContinuationPark.status, "parked"),
        eq(lifecycleContinuationPark.checkpoint, "review"),
      ),
    )
    .limit(limit);
  if (parks.length === 0) return;

  // Join each park to its gate by the EXPLICIT stored linkage `policyDecisionId =
  // gate.id` (stamped at orchestration time), a single-hop lookup on the gate PK —
  // rather than reconstructing the gate's task id. A resolved gate (approve OR
  // reject — both are terminal DECISIONS) releases the park; a still-pending gate
  // leaves it parked (guarded here), so a park is never released early.
  const releaseIds: string[] = [];
  for (const park of parks) {
    if (!park.policyDecisionId) continue; // a checkpointed auto-gate park always has one.
    const [gate] = await db
      .select({ status: artifactReviewGates.status })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, park.policyDecisionId))
      .limit(1);
    if (gate && gate.status === "resolved") releaseIds.push(park.id);
  }
  if (releaseIds.length === 0) return;
  const result = await sweepParks({ releasedParkIds: releaseIds, limit });
  summary.parksReleased += result.released;
}
