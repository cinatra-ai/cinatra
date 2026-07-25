import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-store (cinatra#2040, epic #2037 S2)
//
// The PERSISTENCE + DRIVE half of the REPAIR LOOP. S0 (#2038) decided the
// `changes_requested` + repair-protocol contracts FENCED; S1 (#2039) shipped
// automatic review (auto-gates, effects-gating, delivery/disposition workers,
// production-side batch coalescing with an IN-MEMORY seal). This store is S2's
// consumer: it UNFENCES `changes_requested` and ships the first complete
// request → repair → re-review round-trip, plus the two routed schema additions
// (the durable batch-membership epoch that replaces S1's in-memory seal, and the
// durable rejected-recommendation efficacy row).
//
//   recordChangesRequested   — a reviewer says "make these changes": CLOSE the
//                              immutable review attempt (CAS the base gate
//                              pending → resolved, disposition 'changes_requested')
//                              and OPEN a durable repair (structured findings, the
//                              base-revision CAS witness, the cycle-guard attempt
//                              counter, the route). Fail-closed on a stale/tombstoned
//                              base; escalates (never dispatches) past the cycle bound.
//   submitRepairResponse     — the producer's typed response: validate lineage +
//                              base-revision CAS + live re-authorization, then PIN
//                              the successor revision in a NEW gate (never repin under
//                              the reviewer) and re-point the artifact's held effect
//                              onto the successor.
//   sealBatchEpoch / resolveOpenBatchEpoch / closeBatchEpoch — the DURABLE
//                              sealed-membership epoch: the frozen membership is
//                              persisted BEFORE any gate emit, so a re-sweep after a
//                              crash recovers the FROZEN set instead of re-snapshotting
//                              a grown pending set (closing S1's documented crash-window).
//   recordBatchDisposition   — the durable per-epoch aggregate disposition
//                              (approved / changes_requested / rejected / partially_approved).
//   writeRunRejectedRecommendations — the routed AC-6 rejected-recommendation row.
//
// FENCED: nothing here runs until an operator flips the S1 activation fence
// (`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION`) — the repair drains short-circuit
// exactly as the S1 drains do, and no production caller reaches this store on
// `origin/main` (the emitters write no event row).
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "./db";
import {
  artifactReviewGates,
  artifactReviewAudit,
  artifactProducedOutbox,
  lifecycleRepair,
  lifecycleBatchEpoch,
  lifecycleBatchDisposition,
} from "./schema";
import { emitArtifactReviewGate, ArtifactReviewGateError } from "./artifact-review-gate-store";

import {
  validateChangesRequested,
  validateRepairLineage,
  evaluateRepairCycle,
  routeChangesRequested,
  MAX_REPAIR_CYCLES,
  type ChangesRequestedRequest,
  type RepairResponse,
  type RepairFinding,
  type RepairFindingOutcome,
  type ChangesRequestedRoute,
} from "@/lib/lifecycle/lifecycle-repair";
import {
  aggregateBatchDisposition,
  sealBatch,
  batchMembershipHash,
  type BatchTarget,
  type PerTargetOutcome,
  type BatchDisposition,
} from "@/lib/lifecycle/lifecycle-batch";
import { repairSuccessorReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

// ---------------------------------------------------------------------------
// changes_requested — close the review attempt, open the repair.
// ---------------------------------------------------------------------------

/** The synthetic run id a successor gate carries when the repair names no
 * producing run (mirrors the orchestration store's orphan fallback). */
function orphanRepairRunId(repairId: string): string {
  return `lifecycle-repair-orphan:${repairId}`;
}

/** The changes_requested resolution fingerprint the base gate carries — a stable
 * hash over the gate + the idempotency KEY + the sorted finding ids. Keyed on the
 * stable `idempotencyKey` (NOT the per-attempt `decisionId`), so a response-lost
 * retry with the same key re-derives the SAME fingerprint → the gate CAS re-read is
 * idempotent. */
function changesRequestedFingerprint(req: ChangesRequestedRequest): string {
  const material = JSON.stringify({
    gateId: req.gateId,
    idempotencyKey: req.idempotencyKey,
    disposition: "changes_requested",
    findingIds: req.findings.map((f) => f.id).sort(),
  });
  return `changes_requested:${createHash("sha256").update(material).digest("hex")}`;
}

/** Sorted finding-id fingerprint — the payload guard for an idempotency-key reuse
 * (the same key MUST carry the same findings). */
function findingIdSignature(findings: ReadonlyArray<{ id: string }>): string {
  return findings.map((f) => f.id).sort().join("");
}

export interface RecordChangesRequestedInput {
  /** The base gate that received the decision. */
  runId: string;
  reviewTaskId: string;
  orgId: string;
  request: ChangesRequestedRequest;
  /** Whether the producing agent declares the `repairs` capability. */
  repairCapable: boolean;
  /** An org-designated repair route for a non-repairing producer (else escalate). */
  orgRepairRoute?: string | null;
  producerRunId?: string | null;
  producerAgentId?: string | null;
  /** The LIVE current revision of the base artifact (the store's caller resolves
   * it — host-specific). null ⇒ the base was tombstoned/removed. */
  currentBaseRevisionId: string | null;
  /** The lineage id for a reopen chain; defaults to the base gate id (a fresh
   * lineage). A successor gate that itself receives changes_requested passes the
   * ORIGINAL lineage id so the cycle guard counts the whole chain. */
  lineageId?: string;
  /** The cycle bound (test override); defaults to `MAX_REPAIR_CYCLES`. */
  maxCycles?: number;
}

export type RecordChangesRequestedResult =
  | {
      ok: true;
      repairId: string;
      route: ChangesRequestedRoute;
      attempt: number;
      /** 'requested' — a producer repair is pending; 'escalated' — routed to a
       * human / org route or the cycle bound tripped (never dispatch a repair). */
      status: "requested" | "escalated";
      idempotent: boolean;
    }
  | { ok: false; code: string; error: string };

/**
 * Record a `changes_requested` decision. Validates the request shape + the base
 * revision CAS (the base must still be the revision the reviewer saw; a
 * tombstoned/moved base is rejected), CLOSES the immutable review attempt (CAS the
 * base gate pending → resolved, disposition 'changes_requested', so the effect
 * stays HELD — see the disposition-aware `evaluateEffectHold`), and OPENS a durable
 * repair carrying the cycle-guard attempt counter + the route. Past the cycle bound
 * the lineage ESCALATES (never dispatches another repair). Idempotent on the gate
 * (one repair per gate); a re-drive with the same idempotency key returns the
 * existing repair.
 */
export async function recordChangesRequested(
  input: RecordChangesRequestedInput,
): Promise<RecordChangesRequestedResult> {
  const { request } = input;

  const shape = validateChangesRequested(request);
  if (!shape.ok) return { ok: false, code: "invalid-request", error: shape.error };

  // 1. IDEMPOTENCY FIRST (BEFORE the base-revision CAS): a response-lost retry must
  //    still succeed even if the base has since moved — the repair was already
  //    recorded against the revision the reviewer saw. Reconcile an existing repair;
  //    only a genuinely-NEW record runs the base CAS.
  const existing = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.gateId, request.gateId))
    .limit(1);
  if (existing[0]) return reconcileExistingRepair(existing[0], request);

  // 2. Base-revision CAS at FIRST-record time (the same TOCTOU the decision core
  //    guards): the base must still be the revision the reviewer saw.
  if (input.currentBaseRevisionId === null) {
    return { ok: false, code: "tombstoned-base", error: "base target tombstoned/absent — changes_requested rejected" };
  }
  if (input.currentBaseRevisionId !== request.expectedBaseRevisionId) {
    return { ok: false, code: "stale-base", error: "base revision moved since the review (CAS witness mismatch) — stale changes_requested rejected" };
  }

  const lineageId = input.lineageId ?? request.gateId;
  // Count prior repair attempts on this lineage (the cycle-guard counter).
  const priorRows = await db
    .select({ attempt: lifecycleRepair.attempt })
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.lineageId, lineageId));
  const priorAttempts = priorRows.reduce((m, r) => Math.max(m, r.attempt), 0);
  const cycle = evaluateRepairCycle(priorAttempts, input.maxCycles ?? MAX_REPAIR_CYCLES);
  const route = routeChangesRequested({
    repairCapable: input.repairCapable,
    continuationMode: request.continuationMode,
    orgRepairRoute: input.orgRepairRoute ?? null,
  });

  // Escalate (never dispatch) when the cycle bound tripped OR the producer cannot
  // repair (routed to a human / org route). Only a repair-capable producer within
  // the bound gets a live 'requested' repair.
  const escalated = cycle.escalate || route.kind !== "producer_repair";
  const status: "requested" | "escalated" = escalated ? "escalated" : "requested";
  const repairId = randomUUID();
  const fingerprint = changesRequestedFingerprint(request);

  const persisted = await db.transaction(async (tx) => {
    // CLOSE the review attempt: CAS the base gate pending → resolved with the
    // 'changes_requested' terminal disposition. A gate already resolved by THIS
    // decision (matching fingerprint) is idempotent; a different terminal state is
    // a conflict (thrown → the whole record rolls back).
    const cas = await tx
      .update(artifactReviewGates)
      .set({
        status: "resolved",
        disposition: "changes_requested",
        fingerprint,
        resolvedAt: sql`now()`,
      })
      .where(
        and(
          eq(artifactReviewGates.id, request.gateId),
          eq(artifactReviewGates.status, "pending"),
        ),
      )
      .returning({ id: artifactReviewGates.id, orgId: artifactReviewGates.orgId });
    if (cas.length !== 1) {
      const [gate] = await tx
        .select({ status: artifactReviewGates.status, disposition: artifactReviewGates.disposition, fingerprint: artifactReviewGates.fingerprint })
        .from(artifactReviewGates)
        .where(eq(artifactReviewGates.id, request.gateId))
        .limit(1);
      if (!(gate && gate.status === "resolved" && gate.disposition === "changes_requested" && gate.fingerprint === fingerprint)) {
        throw new Error("changes_requested gate CAS conflict — the gate is not pending");
      }
    }

    // Immutable audit rows for the changes_requested decision (one per finding-less
    // whole-target row — the base target carries the decision; the findings live on
    // the repair record). Idempotent on (gate, fingerprint, artifact, revision).
    await tx
      .insert(artifactReviewAudit)
      .values({
        id: randomUUID(),
        gateId: request.gateId,
        runId: input.runId,
        reviewTaskId: input.reviewTaskId,
        decisionFingerprint: fingerprint,
        artifactId: request.baseTarget.artifactId,
        representationRevisionId: request.baseTarget.representationRevisionId,
        disposition: "changes_requested",
        rendererKind: "floor",
        rendererPackage: null,
        rendererDigest: null,
      })
      .onConflictDoNothing({
        target: [
          artifactReviewAudit.gateId,
          artifactReviewAudit.decisionFingerprint,
          artifactReviewAudit.artifactId,
          artifactReviewAudit.representationRevisionId,
        ],
      });

    const ins = await tx
      .insert(lifecycleRepair)
      .values({
        id: repairId,
        lineageId,
        gateId: request.gateId,
        orgId: input.orgId,
        producerRunId: input.producerRunId ?? null,
        producerAgentId: input.producerAgentId ?? null,
        baseArtifactId: request.baseTarget.artifactId,
        baseRepresentationRevisionId: request.baseTarget.representationRevisionId,
        expectedBaseRevisionId: request.expectedBaseRevisionId,
        findings: request.findings as unknown,
        continuationMode: request.continuationMode,
        continuationAddress: request.continuationAddress ?? null,
        attempt: cycle.attempt,
        route: route.kind,
        status,
        idempotencyKey: request.idempotencyKey,
      })
      .onConflictDoNothing({ target: [lifecycleRepair.gateId] })
      .returning();
    if (ins[0]) return { row: ins[0], fresh: true as const };
    // A CONCURRENT identical call won the (gate) UNIQUE — read the durable winner
    // so we never return a repairId that was never persisted.
    const [won] = await tx
      .select()
      .from(lifecycleRepair)
      .where(eq(lifecycleRepair.gateId, request.gateId))
      .limit(1);
    return { row: won ?? null, fresh: false as const };
  });

  if (!persisted.row) throw new Error("lifecycle_repair row vanished after insert-conflict");
  if (!persisted.fresh) return reconcileExistingRepair(persisted.row, request);
  return { ok: true, repairId: persisted.row.id, route, attempt: cycle.attempt, status, idempotent: false };
}

/** Reconcile a re-drive against an EXISTING repair for the same gate. The same
 * idempotency key MUST carry the same base + findings (else it was reused for a
 * different decision — a conflict); a DIFFERENT key on the same gate is a genuine
 * gate-conflict (a second changes_requested on an already-repairing gate). The
 * route is reconstructed FROM the durable row (continuation mode included), never
 * fabricated. */
function reconcileExistingRepair(
  row: typeof lifecycleRepair.$inferSelect,
  request: ChangesRequestedRequest,
): RecordChangesRequestedResult {
  if (row.idempotencyKey !== request.idempotencyKey) {
    return { ok: false, code: "gate-conflict", error: "a different changes_requested decision already opened a repair on this gate" };
  }
  const sameBase =
    row.baseArtifactId === request.baseTarget.artifactId &&
    row.baseRepresentationRevisionId === request.baseTarget.representationRevisionId &&
    row.expectedBaseRevisionId === request.expectedBaseRevisionId;
  const sameFindings = findingIdSignature((row.findings as RepairFinding[]) ?? []) === findingIdSignature(request.findings);
  if (!sameBase || !sameFindings) {
    return { ok: false, code: "idempotency-key-reuse", error: "the idempotency key was reused with a different base or findings" };
  }
  return {
    ok: true,
    repairId: row.id,
    route: routeFromRow(row.route, row.continuationMode),
    attempt: row.attempt,
    status: row.status === "escalated" ? "escalated" : "requested",
    idempotent: true,
  };
}

/** Reconstruct the route from the durable row — continuation mode from the stored
 * `continuation_mode` (never fabricated). The org-route STRING is not round-tripped
 * on the row (only the kind is durable); org_repair_route reconstructs to a stable
 * marker — the KIND, the datum a dispatch decision keys on, is authoritative. */
function routeFromRow(route: string, continuationMode: string): ChangesRequestedRoute {
  if (route === "producer_repair") {
    return { kind: "producer_repair", continuationMode: continuationMode === "checkpointed" ? "checkpointed" : "async_effects_gated" };
  }
  if (route === "org_repair_route") return { kind: "org_repair_route", route: "org-designated" };
  return { kind: "human_escalation", reason: "escalated" };
}

// ---------------------------------------------------------------------------
// Repair response — pin the successor in a NEW gate.
// ---------------------------------------------------------------------------

export interface SubmitRepairResponseInput {
  repairId: string;
  response: RepairResponse;
  /** The LIVE current revision of the base artifact at repair time (CAS re-check).
   * null ⇒ tombstoned. */
  currentBaseRevisionId: string | null;
  /** Live re-authorization at repair dispatch (actor, org-binding, connector use).
   * The captured request context is provenance-only; the caller performs the live
   * re-auth and passes the verdict. false ⇒ the repair is rejected. */
  reauthorized: boolean;
  /** Gate TTL for the successor gate (optional). */
  expiresAt?: Date | null;
}

export type SubmitRepairResponseResult =
  | { ok: true; successorGateId: string; successorTaskId: string }
  | { ok: false; code: string; error: string };

/**
 * Submit a producer's repair RESPONSE. Validates the lineage + base-revision CAS
 * (a moved/tombstoned base ⇒ the repair is STALE) + live re-authorization, then
 * pins the successor revision in a NEW gate (never repin under the reviewer) and
 * re-points the artifact's held effect onto the successor. Idempotent: a re-drive
 * of an already-repaired repair returns its successor gate.
 */
export async function submitRepairResponse(
  input: SubmitRepairResponseInput,
): Promise<SubmitRepairResponseResult> {
  const [repair] = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.id, input.repairId))
    .limit(1);
  if (!repair) return { ok: false, code: "not-found", error: "repair not found" };

  // Idempotent success: already repaired → return the pinned successor gate. RE-RUN
  // the (fully idempotent) verification trigger here too (cinatra#2042): if a crash
  // landed the successor but the verification record/reopen never wrote — or wrote
  // the record but not the reopen gate — a retry of the repair response now heals it
  // (the record insert is onConflictDoNothing and the reopen emit is idempotent on
  // run+task). Best-effort: it never fails the (already-committed) repair.
  if (repair.status === "repaired" && repair.successorGateId) {
    try {
      const { triggerVerificationForLandedRepair } = await import("./lifecycle-verification-store");
      await triggerVerificationForLandedRepair({ repairId: repair.id, orgId: repair.orgId });
    } catch {
      /* swallowed — verification is an annotation, never a repair-blocking dependency. */
    }
    return {
      ok: true,
      successorGateId: repair.successorGateId,
      successorTaskId: repairSuccessorReviewTaskId(repair.id, repair.attempt),
    };
  }
  if (repair.status !== "requested" && repair.status !== "dispatched") {
    return { ok: false, code: "wrong-status", error: `repair is ${repair.status} — cannot accept a response` };
  }

  // Reconstruct the request the repair was opened against.
  const request: ChangesRequestedRequest = {
    gateId: repair.gateId,
    decisionId: repair.id,
    idempotencyKey: repair.idempotencyKey,
    baseTarget: { artifactId: repair.baseArtifactId, representationRevisionId: repair.baseRepresentationRevisionId },
    expectedBaseRevisionId: repair.expectedBaseRevisionId,
    findings: (repair.findings as RepairFinding[]) ?? [],
    continuationMode: repair.continuationMode as "checkpointed" | "async_effects_gated",
    continuationAddress: repair.continuationAddress,
  };

  const lineage = validateRepairLineage({
    request,
    response: input.response,
    currentBaseRevisionId: input.currentBaseRevisionId,
  });
  if (!lineage.ok) {
    // A stale/tombstoned base marks the repair STALE (a moved target the review no
    // longer applies to); a producer-shape error leaves the repair open to retry.
    if (lineage.code === "stale-base" || lineage.code === "tombstoned-base") {
      await db
        .update(lifecycleRepair)
        .set({ status: "stale", updatedAt: sql`now()` })
        .where(and(eq(lifecycleRepair.id, repair.id), eq(lifecycleRepair.status, repair.status)));
    }
    return { ok: false, code: lineage.code, error: lineage.error };
  }

  if (!input.reauthorized) {
    return { ok: false, code: "not-authorized", error: "live re-authorization at repair dispatch failed" };
  }

  // Pin the successor in a NEW gate (never repin under the reviewer). Deterministic
  // task id ⇒ a re-drive is idempotent on (run, task).
  const runId = repair.producerRunId ?? orphanRepairRunId(repair.id);
  const successorTaskId = repairSuccessorReviewTaskId(repair.id, repair.attempt);
  let successorGateId: string;
  try {
    const emitted = await emitArtifactReviewGate({
      runId,
      orgId: repair.orgId,
      reviewTaskId: successorTaskId,
      targets: [
        {
          artifactId: input.response.successorTarget.artifactId,
          representationRevisionId: input.response.successorTarget.representationRevisionId,
        },
      ],
      expiresAt: input.expiresAt ?? null,
    });
    successorGateId = emitted.gateId;
  } catch (err) {
    if (err instanceof ArtifactReviewGateError) {
      return { ok: false, code: "successor-pin-conflict", error: err.message };
    }
    throw err;
  }

  // Finalize + re-point ATOMICALLY, CAS-guarded on the repair status so only the
  // FIRST response finalizes (a concurrent second response re-emits the SAME
  // deterministic successor gate — idempotent — but its finalize CAS matches 0
  // rows, so it never overwrites the first's outcomes; it returns idempotently
  // below). The held effect re-points onto the successor gate so the
  // disposition-aware effect-hold stays HELD until the successor APPROVES.
  //
  // The re-point matches the outbox row by its LIVE gate LINKAGE
  // (`continuation_address == repair.gateId`), NOT by the current repair's base
  // event id. This is load-bearing for a MULTI-CYCLE repair chain (cinatra#2063):
  // the effect that a repair gate holds is always the ORIGINAL producing event
  // (e.g. an external-publish artifact), which the round-1 re-point already moved
  // onto this gate — a round-2+ base is the round-1 SUCCESSOR artifact, whose
  // event id is NOT the one linked to this gate, so keying on the base event id
  // would match zero rows and strand the original effect on the resolved gate
  // FOREVER. A repair gate is single-target, so exactly one outbox row is ever
  // linked to it; keying on the linkage is precise (never re-points an unrelated
  // event).
  const finalized = await db.transaction(async (tx) => {
    const cas = await tx
      .update(lifecycleRepair)
      .set({
        status: "repaired",
        successorGateId,
        successorArtifactId: input.response.successorTarget.artifactId,
        successorRepresentationRevisionId: input.response.successorTarget.representationRevisionId,
        findingOutcomes: input.response.findingOutcomes as unknown,
        changeSummary: input.response.changeSummary,
        updatedAt: sql`now()`,
      })
      .where(and(eq(lifecycleRepair.id, repair.id), eq(lifecycleRepair.status, repair.status)))
      .returning({ id: lifecycleRepair.id });
    if (cas.length !== 1) return false; // a concurrent response finalized first.
    // Re-point the held-effect linkage still pointing at the base gate onto the
    // successor gate (idempotent; follows the chain across multi-cycle repairs).
    await tx
      .update(artifactProducedOutbox)
      .set({ continuationAddress: successorGateId })
      .where(eq(artifactProducedOutbox.continuationAddress, repair.gateId));
    return true;
  });
  if (!finalized) {
    // A concurrent response won; return its (the same, deterministic) successor gate.
    const winner = await readRepair(repair.id);
    if (winner?.status === "repaired" && winner.successorGateId) {
      return { ok: true, successorGateId: winner.successorGateId, successorTaskId };
    }
    return { ok: false, code: "concurrent-finalize", error: "the repair was finalized concurrently" };
  }

  // S4 (cinatra#2042): a landed repair TRIGGERS post-change verification — the
  // before/after "Core analysis" record the run rail opens, and (on a failed
  // verdict, within the cycle bound) exactly one reopened bounded gate on the same
  // run. BEST-EFFORT: a verification error never fails the (already-committed)
  // repair; the successor gate stands regardless.
  try {
    const { triggerVerificationForLandedRepair } = await import("./lifecycle-verification-store");
    await triggerVerificationForLandedRepair({ repairId: repair.id, orgId: repair.orgId });
  } catch {
    // swallowed — verification is an annotation, never a repair-blocking dependency.
  }

  return { ok: true, successorGateId, successorTaskId };
}

/** Mark a repair DISPATCHED (a completed flow's new repair run was dispatched).
 * Idempotent; only from 'requested'. */
export async function markRepairDispatched(repairId: string): Promise<boolean> {
  const rows = await db
    .update(lifecycleRepair)
    .set({ status: "dispatched", updatedAt: sql`now()` })
    .where(and(eq(lifecycleRepair.id, repairId), eq(lifecycleRepair.status, "requested")))
    .returning({ id: lifecycleRepair.id });
  return rows.length === 1;
}

export interface RepairRow {
  id: string;
  lineageId: string;
  gateId: string;
  orgId: string;
  attempt: number;
  route: string;
  status: string;
  baseArtifactId: string;
  baseRepresentationRevisionId: string;
  expectedBaseRevisionId: string;
  findings: RepairFinding[];
  successorGateId: string | null;
  successorArtifactId: string | null;
  successorRepresentationRevisionId: string | null;
  findingOutcomes: RepairFindingOutcome[] | null;
  changeSummary: string | null;
}

export async function readRepair(repairId: string): Promise<RepairRow | null> {
  const [r] = await db.select().from(lifecycleRepair).where(eq(lifecycleRepair.id, repairId)).limit(1);
  if (!r) return null;
  return toRepairRow(r);
}

/** Recover the repair whose SUCCESSOR gate is `gateId` — the anchor a post-change
 * verification-reopen gate uses to thread the ORIGINAL repair lineage (so the cycle
 * bound counts the verify→reopen→repair loop, cinatra#2042). Null for a gate that is
 * not a repair successor (e.g. an external-change verification). */
export async function readRepairBySuccessorGateId(gateId: string): Promise<RepairRow | null> {
  const [r] = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.successorGateId, gateId))
    .limit(1);
  if (!r) return null;
  return toRepairRow(r);
}

/** The full lineage chain (every repair attempt), oldest attempt first — the audit
 * lineage the AC requires. */
export async function readRepairLineage(lineageId: string): Promise<RepairRow[]> {
  const rows = await db
    .select()
    .from(lifecycleRepair)
    .where(eq(lifecycleRepair.lineageId, lineageId))
    .orderBy(asc(lifecycleRepair.attempt), asc(lifecycleRepair.createdAt));
  return rows.map(toRepairRow);
}

function toRepairRow(r: typeof lifecycleRepair.$inferSelect): RepairRow {
  return {
    id: r.id,
    lineageId: r.lineageId,
    gateId: r.gateId,
    orgId: r.orgId,
    attempt: r.attempt,
    route: r.route,
    status: r.status,
    baseArtifactId: r.baseArtifactId,
    baseRepresentationRevisionId: r.baseRepresentationRevisionId,
    expectedBaseRevisionId: r.expectedBaseRevisionId,
    findings: (r.findings as RepairFinding[]) ?? [],
    successorGateId: r.successorGateId,
    successorArtifactId: r.successorArtifactId,
    successorRepresentationRevisionId: r.successorRepresentationRevisionId,
    findingOutcomes: (r.findingOutcomes as RepairFindingOutcome[] | null) ?? null,
    changeSummary: r.changeSummary,
  };
}

// ---------------------------------------------------------------------------
// Durable batch-membership epoch (replaces S1's in-memory seal).
// ---------------------------------------------------------------------------

export interface BatchEpochRow {
  id: string;
  orgId: string;
  producerRunId: string;
  membershipHash: string;
  membership: BatchTarget[];
  targetCount: number;
  status: "sealed" | "partitioned";
}

function toEpochRow(r: typeof lifecycleBatchEpoch.$inferSelect): BatchEpochRow {
  return {
    id: r.id,
    orgId: r.orgId,
    producerRunId: r.producerRunId,
    membershipHash: r.membershipHash,
    membership: (r.membership as BatchTarget[]) ?? [],
    targetCount: r.targetCount,
    status: r.status as "sealed" | "partitioned",
  };
}

/** The OPEN (still-sealed, not yet closed) epoch for a production, or null. At most
 * one exists (the partial-unique open index). The crash-recovery anchor: a re-sweep
 * finds the frozen membership here instead of re-snapshotting the pending set. */
export async function resolveOpenBatchEpoch(orgId: string, producerRunId: string): Promise<BatchEpochRow | null> {
  const [r] = await db
    .select()
    .from(lifecycleBatchEpoch)
    .where(
      and(
        eq(lifecycleBatchEpoch.orgId, orgId),
        eq(lifecycleBatchEpoch.producerRunId, producerRunId),
        eq(lifecycleBatchEpoch.status, "sealed"),
      ),
    )
    .limit(1);
  return r ? toEpochRow(r) : null;
}

/**
 * Resolve or SEAL a durable batch epoch for a production. MUST be called under the
 * production advisory lock (the orchestration store holds it), so this is a simple
 * find-or-create with no in-flight race:
 *
 *   - An OPEN epoch already exists (a prior pass sealed it, then crashed
 *     mid-partition) → RETURN its FROZEN membership (`reused: true`). The frozen set
 *     is what closes S1's crash-window: the re-sweep processes exactly the sealed
 *     membership, never a grown pending snapshot; a NEW revision that arrived after
 *     the seal is NOT in it and forms a successor epoch once this one closes.
 *   - No open epoch → SEAL the candidate membership durably (id + frozen membership
 *     + content hash), status 'sealed', and return it (`reused: false`).
 */
export async function sealBatchEpoch(input: {
  orgId: string;
  producerRunId: string;
  candidateMembers: BatchTarget[];
}): Promise<{ epoch: BatchEpochRow; reused: boolean }> {
  const open = await resolveOpenBatchEpoch(input.orgId, input.producerRunId);
  if (open) return { epoch: open, reused: true };

  const sealed = sealBatch({ kind: "explicit", targets: input.candidateMembers });
  if (!sealed.ok) {
    throw new Error(`sealBatchEpoch: candidate membership does not seal — ${sealed.reason}`);
  }
  const membershipHash = batchMembershipHash(sealed.targets);
  const id = randomUUID();
  const inserted = await db
    .insert(lifecycleBatchEpoch)
    .values({
      id,
      orgId: input.orgId,
      producerRunId: input.producerRunId,
      membershipHash,
      membership: sealed.targets as unknown,
      targetCount: sealed.targets.length,
      status: "sealed",
    })
    .onConflictDoNothing({
      target: [lifecycleBatchEpoch.orgId, lifecycleBatchEpoch.producerRunId, lifecycleBatchEpoch.membershipHash],
    })
    .returning();
  if (inserted[0]) return { epoch: toEpochRow(inserted[0]), reused: false };

  // The identical membership was already an epoch (a prior fully-processed epoch of
  // the same membership, or a race the lock should have prevented) — read it back.
  const [existing] = await db
    .select()
    .from(lifecycleBatchEpoch)
    .where(
      and(
        eq(lifecycleBatchEpoch.orgId, input.orgId),
        eq(lifecycleBatchEpoch.producerRunId, input.producerRunId),
        eq(lifecycleBatchEpoch.membershipHash, membershipHash),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("sealBatchEpoch: epoch vanished between insert-conflict and read");
  return { epoch: toEpochRow(existing), reused: existing.status === "sealed" };
}

/** Close an epoch (all members gated + linked + marked): status 'sealed' →
 * 'partitioned'. A subsequent new revision for the production seals a SUCCESSOR
 * epoch (the open-uniq index no longer blocks it). Idempotent. */
export async function closeBatchEpoch(epochId: string): Promise<void> {
  await db
    .update(lifecycleBatchEpoch)
    .set({ status: "partitioned", partitionedAt: sql`now()` })
    .where(and(eq(lifecycleBatchEpoch.id, epochId), eq(lifecycleBatchEpoch.status, "sealed")));
}

export async function readBatchEpoch(epochId: string): Promise<BatchEpochRow | null> {
  const [r] = await db.select().from(lifecycleBatchEpoch).where(eq(lifecycleBatchEpoch.id, epochId)).limit(1);
  return r ? toEpochRow(r) : null;
}

/** Every OPEN (still-sealed) epoch, oldest first, bounded. The independent
 * epoch-drain reads this to close an epoch STRANDED by a crash between the final
 * member mark and `closeBatchEpoch` (that production then has NO pending events, so
 * the pending-keyed sweep never revisits it — an open epoch would otherwise block a
 * successor epoch forever via the open-uniq index). */
export async function listOpenBatchEpochs(limit = 100): Promise<BatchEpochRow[]> {
  const rows = await db
    .select()
    .from(lifecycleBatchEpoch)
    .where(eq(lifecycleBatchEpoch.status, "sealed"))
    .orderBy(asc(lifecycleBatchEpoch.sealedAt))
    .limit(Math.max(1, Math.min(limit, 500)));
  return rows.map(toEpochRow);
}

// ---------------------------------------------------------------------------
// Durable per-epoch aggregate disposition (S2 owns the repair-side aggregate).
// ---------------------------------------------------------------------------

export type RecordBatchDispositionResult =
  | { ok: true; disposition: BatchDisposition; idempotent: boolean }
  | { ok: false; code: "epoch-not-found" | "outcome-membership-mismatch"; error: string };

/**
 * Compute + persist the durable AGGREGATE disposition of a batch epoch from its
 * per-target outcomes (the pure `aggregateBatchDisposition` matrix: approved /
 * changes_requested / rejected / partially_approved). The outcomes MUST be a
 * BIJECTION with the epoch's FROZEN membership — every member decided exactly once,
 * no foreign or duplicate target — otherwise a subset could (wrongly) persist
 * `approved` and release effects on undecided targets. One aggregate per epoch
 * (idempotent on epoch_id); a re-drive returns the STORED first-write aggregate.
 */
export async function recordBatchDisposition(input: {
  epochId: string;
  outcomes: PerTargetOutcome[];
}): Promise<RecordBatchDispositionResult> {
  const epoch = await readBatchEpoch(input.epochId);
  if (!epoch) return { ok: false, code: "epoch-not-found", error: `batch epoch ${input.epochId} not found` };

  // Bijection guard: the decided targets must EXACTLY cover the frozen membership.
  const key = (t: { artifactId: string; representationRevisionId: string }) =>
    `${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`;
  const memberKeys = new Set(epoch.membership.map(key));
  const decidedKeys = new Set<string>();
  for (const o of input.outcomes) {
    const k = key(o.target);
    if (!memberKeys.has(k)) {
      return { ok: false, code: "outcome-membership-mismatch", error: "an outcome names a target outside the sealed epoch membership" };
    }
    if (decidedKeys.has(k)) {
      return { ok: false, code: "outcome-membership-mismatch", error: "a target was decided more than once" };
    }
    decidedKeys.add(k);
  }
  if (decidedKeys.size !== memberKeys.size) {
    return { ok: false, code: "outcome-membership-mismatch", error: "not every sealed member was decided (incomplete outcome set)" };
  }

  const disposition = aggregateBatchDisposition(input.outcomes);
  const inserted = await db
    .insert(lifecycleBatchDisposition)
    .values({
      id: randomUUID(),
      epochId: input.epochId,
      aggregate: disposition.aggregate,
      terminal: disposition.terminal,
      effectsReleasable: disposition.effectsReleasable,
      repairScope: disposition.repairScope as unknown,
      unionFindings: disposition.unionFindings as unknown,
      perTargetOutcomes: input.outcomes as unknown,
    })
    .onConflictDoNothing({ target: [lifecycleBatchDisposition.epochId] })
    .returning({ id: lifecycleBatchDisposition.id });
  if (inserted.length === 1) return { ok: true, disposition, idempotent: false };
  // A prior write won — return the DURABLE first-write aggregate, not the recompute.
  const stored = await readBatchDisposition(input.epochId);
  return { ok: true, disposition: stored ?? disposition, idempotent: true };
}

export async function readBatchDisposition(epochId: string): Promise<BatchDisposition | null> {
  const [r] = await db
    .select()
    .from(lifecycleBatchDisposition)
    .where(eq(lifecycleBatchDisposition.epochId, epochId))
    .limit(1);
  if (!r) return null;
  return {
    aggregate: r.aggregate as BatchDisposition["aggregate"],
    terminal: r.terminal,
    repairScope: (r.repairScope as BatchTarget[]) ?? [],
    unionFindings: (r.unionFindings as RepairFinding[]) ?? [],
    effectsReleasable: r.effectsReleasable,
  };
}

// The REJECTED-recommendation efficacy row (routed AC-6) lives in the sibling
// sync-pg module `src/lib/run-selected-skill-revisions.ts` (beside the ACCEPTED
// half) so the confirm path writes both halves through one already-reachable
// module — the heavier repair store never joins the run-start route graph.
