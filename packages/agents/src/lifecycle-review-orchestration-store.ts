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

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
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
  evaluateEffectHold,
  planReviewForEvent,
  type ProducedEventAxes,
  type ReviewOrchestrationContext,
  type EffectHoldVerdict,
} from "@/lib/lifecycle/lifecycle-orchestration";
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

  // Link the gate onto the event (the effects-gating join). Only stamp when
  // unset so a replay never re-points a live linkage.
  await db
    .update(artifactProducedOutbox)
    .set({ continuationAddress: gateId })
    .where(and(eq(artifactProducedOutbox.eventId, row.eventId), isNull(artifactProducedOutbox.continuationAddress)));

  // CHECKPOINTED mode: the producing run PARKS on the review decision. The park's
  // policy-decision id is the gate id (the maintenance drain releases the park
  // once the gate resolves). ASYNC mode never parks (`plan.park` is null).
  if (plan.continuationMode === "checkpointed" && plan.park) {
    await maybeParkCheckpoint(plan.park, {
      runId,
      eventId: row.eventId,
      policyDecisionId: gateId,
    });
  }

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
}

/**
 * Drain a batch of PENDING produced events into review gates. FENCED: a no-op
 * when the S1 activation fence is off (defence-in-depth — the emitters already
 * write no event row, so the pending set is empty, but a manually-enqueued tick
 * still short-circuits). Per-event failures are TALLIED (never rethrown) so one
 * bad row can never poison the drain; the event stays pending for the next cycle.
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
  };
  if (!isLifecycleReviewOrchestrationActive()) return summary;

  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  const rows = await db
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
    .where(eq(artifactProducedOutbox.status, "pending"))
    .orderBy(asc(artifactProducedOutbox.createdAt))
    .limit(limit);

  for (const row of rows) {
    summary.scanned += 1;
    try {
      const outcome = await orchestrateProducedEvent(row);
      if (outcome === "gate-created") summary.gatesCreated += 1;
      else if (outcome === "no-gate" || outcome === "already-processed") summary.noGate += 1;
      else summary.notClassifiable += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-review-orchestration] orchestrate failed for event=${row.eventId} — left pending:`,
        err,
      );
    }
  }
  return summary;
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
  if (event.continuationAddress) {
    const [gate] = await db
      .select({ status: artifactReviewGates.status })
      .from(artifactReviewGates)
      .where(eq(artifactReviewGates.id, event.continuationAddress))
      .limit(1);
    gateStatus = gate ? (gate.status === "resolved" ? "resolved" : "pending") : null;
  }

  return evaluateEffectHold({
    event: {
      destinationClass: event.destinationClass as DestinationClass,
      status: event.status,
      continuationAddress: event.continuationAddress,
    },
    gateStatus,
  });
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
    const required = await isExpiredGateRequired(gate.reviewTaskId);
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
 * the pure lattice over the gate's original produced event. Fail-CLOSED: if the
 * event or its context cannot be resolved, treat the gate as required (keep
 * blocking) rather than risk auto-releasing a required gate. */
async function isExpiredGateRequired(reviewTaskId: string): Promise<boolean> {
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
