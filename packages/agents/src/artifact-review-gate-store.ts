import "server-only";

// ---------------------------------------------------------------------------
// artifact-review-gate-store (cinatra#1796, epic #1620 S13)
//
// The persistence half of the #1795/#1807 generic artifact-review surface — the
// EMITTING GATE that pins immutable review targets, the run/gate read ports the
// preparation + decision PURE cores consume, and the ATOMIC decision commit
// (gate CAS + audit rows + reject→tombstone disposition record + the
// exactly-once-persisted resume intent, in ONE transaction). #1807 shipped the
// pure cores and their
// injected-port contracts; THIS store supplies the live binding they were fenced
// against, and the emit primitive a reviewer workflow calls at gate creation.
//
//   emitArtifactReviewGate   — PIN a run's review targets at gate creation. One
//                              row per (run_id, review_task_id); idempotent on a
//                              re-emit of the SAME pinned set, fail-closed on a
//                              DIFFERENT set (never silently overwrite a pin a
//                              reviewer may already be acting on).
//   readGatePinnedTargets    — the PREPARATION core's gate port: pending (+ the
//                              frozen pinned set) | not-pending | not-found.
//   readReviewGateState      — the DECISION core's gate port: pending (+ pinned
//                              set) | resolved (+ resolving fingerprint) |
//                              unavailable (absent → folded, so existence is not
//                              leaked).
//   commitReviewDecision     — the DECISION core's `commit` port: persist the
//                              plan in ONE transaction (terminal gate CAS stamping
//                              the fingerprint + disposition, audit rows, reject
//                              tombstone dispositions, and the resume outbox
//                              intent). Returns committed | already-resolved
//                              (matching-fingerprint race) | conflict; THROWS on a
//                              persistence failure so the core aborts with nothing
//                              committed (zero partial commit).
//   claimPendingResumeIntents / markResumeIntentDelivered — the lease drain the
//                              resume-delivery worker uses (0071 outbox-lease
//                              precedent). The intent is persisted EXACTLY ONCE
//                              (PK gate_id) but delivery is AT-LEAST-ONCE — a
//                              worker can send then crash before marking done and
//                              the expired lease is re-claimed — so the downstream
//                              resume consumer (the A2A/HITL resume, downstream of
//                              THIS slice) must be idempotent per gate. The actual
//                              resume SEND is not built here; this store owns the
//                              durable intent + the recoverable lease.
//   readReviewGate / readResumeIntent / readDispositions — inspection readers.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { db } from "./db";
import {
  artifactReviewGates,
  artifactReviewAudit,
  artifactReviewDispositions,
  artifactReviewResumeOutbox,
  gateAdvisoryComments,
  artifactVerificationRecords,
  gateSuggestionSnapshots,
  type PinnedReviewTargetRow,
} from "./schema";
import {
  enforceRunAccess,
  resolveEffectivePolicy,
  type ActorRoleHints,
  type RunForAccessCheck,
} from "./auth-policy";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
} from "./store";
import { AuthzError } from "@/lib/authz/errors";

import {
  normalizeReviewTargets,
  reviewTargetKey,
  type ArtifactReviewTarget,
} from "@/lib/artifacts/artifact-review-target";
import type {
  GatePinnedOutcome,
  RunAccessOutcome,
} from "@/lib/artifacts/artifact-review-preparation";
import type {
  ReviewCommitOutcome,
  ReviewDecisionCommitPlan,
  ReviewGateState,
  ReviewRunAccessOp,
} from "@/lib/artifacts/artifact-review-decision";

// ---------------------------------------------------------------------------
// Canonicalization — the stored pinned set is order-stable (sorted by the
// canonical target key), so a re-emit with reordered inputs is byte-identical
// and the idempotency comparison never trips on order (the decision core sorts
// the same way).
// ---------------------------------------------------------------------------

function byTargetKey(a: ArtifactReviewTarget, b: ArtifactReviewTarget): number {
  const ka = reviewTargetKey(a);
  const kb = reviewTargetKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function canonicalPinnedSet(targets: ArtifactReviewTarget[]): PinnedReviewTargetRow[] {
  return [...targets].sort(byTargetKey).map((t) => ({
    artifactId: t.artifactId,
    representationRevisionId: t.representationRevisionId,
  }));
}

function pinnedSetKey(targets: ReadonlyArray<PinnedReviewTargetRow>): string {
  return targets.map((t) => reviewTargetKey(t)).join("");
}

function rowsToTargets(rows: ReadonlyArray<PinnedReviewTargetRow>): ArtifactReviewTarget[] {
  return rows.map((r) => ({
    artifactId: r.artifactId,
    representationRevisionId: r.representationRevisionId,
  }));
}

export class ArtifactReviewGateError extends Error {
  readonly code: "invalid-targets" | "pin-conflict";
  constructor(code: "invalid-targets" | "pin-conflict", message: string) {
    super(message);
    this.name = "ArtifactReviewGateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The emitting gate.
// ---------------------------------------------------------------------------

export interface EmitReviewGateResult {
  gateId: string;
  /** The canonical pinned target set (order-stable). */
  targets: ArtifactReviewTarget[];
  /** True when the gate already existed with the SAME pinned set (idempotent
   * re-emit). */
  idempotent: boolean;
}

/**
 * PIN a run's review targets at gate creation. "Latest" is resolved by the
 * CALLER before it reaches here — this store freezes exactly what it is given, so
 * a reviewer approves the exact revision the gate froze (no review/serve TOCTOU).
 *
 * TRUST BOUNDARY — this is a TRUSTED, server-internal primitive, NOT a
 * client-reachable surface. It is invoked by the reviewer agent's OWN execution
 * (pre-interrupt target pinning, under the run's borrowed server-side authority)
 * or by a run-access-guarded server action — exactly as `writeHitlPrompt` and the
 * setup-interrupt status flip are invoked. The RESPONDER-side surfaces (the
 * preparation + decision binders, `enforceReviewRunAccess`) enforce run access
 * against the actual reviewing actor; the emitter, being the run itself, does not
 * re-authorize itself (a tautological self-check). The gate deliberately carries
 * NO FK to agent_runs (the auditor-review-companion precedent — synthetic ids +
 * run-row-churn tolerance), so emit does not require the run row to exist.
 *
 * Idempotent on (run_id, review_task_id): a re-emit of the SAME canonical pinned
 * set AND org returns the existing gate; a re-emit with a DIFFERENT set or a
 * DIFFERENT org is fail-closed (throws pin-conflict) — the gate is never silently
 * re-pinned, and never re-tagged to another org, under a reviewer.
 */
export async function emitArtifactReviewGate(input: {
  runId: string;
  orgId: string;
  reviewTaskId: string;
  targets: unknown;
  /** Optional gate TTL (cinatra#2039, epic #2037 S1). An AUTO-created review gate
   * passes an expiry so the lifecycle maintenance drain can resolve it per policy
   * (optional auto-resolve / required block+notify); a flow-authored gate passes
   * none (null — the expiry drain never touches it). Set only on the INSERT: a
   * re-emit onto an existing gate never re-stamps the expiry (idempotent pin). */
  expiresAt?: Date | null;
}): Promise<EmitReviewGateResult> {
  const normalized = normalizeReviewTargets(input.targets);
  if (!normalized.ok) {
    throw new ArtifactReviewGateError("invalid-targets", normalized.error);
  }
  const pinned = canonicalPinnedSet(normalized.targets);

  const gateId = randomUUID();
  const [inserted] = await db
    .insert(artifactReviewGates)
    .values({
      id: gateId,
      runId: input.runId,
      orgId: input.orgId,
      reviewTaskId: input.reviewTaskId,
      status: "pending",
      pinnedTargets: pinned,
      expiresAt: input.expiresAt ?? null,
    })
    // One gate per (run, task) — the run_task_uniq index.
    .onConflictDoNothing({
      target: [artifactReviewGates.runId, artifactReviewGates.reviewTaskId],
    })
    .returning({ id: artifactReviewGates.id });

  if (inserted) {
    return { gateId: inserted.id, targets: rowsToTargets(pinned), idempotent: false };
  }

  // Conflict: a gate already exists for this (run, task). Idempotent iff the
  // pinned set AND org match; otherwise fail closed (never re-pin / re-tag).
  const existing = await readReviewGate(input.runId, input.reviewTaskId);
  if (!existing) {
    // Extremely narrow race (row vanished between insert-conflict and read).
    throw new ArtifactReviewGateError(
      "pin-conflict",
      `Review gate ${input.reviewTaskId} on run ${input.runId} could not be reconciled.`,
    );
  }
  if (existing.orgId !== input.orgId) {
    throw new ArtifactReviewGateError(
      "pin-conflict",
      `Review gate ${input.reviewTaskId} on run ${input.runId} is bound to a different org.`,
    );
  }
  const existingPinned = canonicalPinnedSet(rowsToTargets(existing.pinnedTargets));
  if (pinnedSetKey(existingPinned) !== pinnedSetKey(pinned)) {
    throw new ArtifactReviewGateError(
      "pin-conflict",
      `Review gate ${input.reviewTaskId} on run ${input.runId} already pinned a different target set.`,
    );
  }
  return { gateId: existing.id, targets: rowsToTargets(existingPinned), idempotent: true };
}

// ---------------------------------------------------------------------------
// Read ports.
// ---------------------------------------------------------------------------

export interface ReviewGateRow {
  id: string;
  runId: string;
  orgId: string;
  reviewTaskId: string;
  status: "pending" | "resolved";
  pinnedTargets: PinnedReviewTargetRow[];
  disposition: string | null;
  fingerprint: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export async function readReviewGate(
  runId: string,
  reviewTaskId: string,
): Promise<ReviewGateRow | null> {
  const rows = await db
    .select()
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.runId, runId),
        eq(artifactReviewGates.reviewTaskId, reviewTaskId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    orgId: row.orgId,
    reviewTaskId: row.reviewTaskId,
    status: row.status as "pending" | "resolved",
    pinnedTargets: row.pinnedTargets as PinnedReviewTargetRow[],
    disposition: row.disposition,
    fingerprint: row.fingerprint,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Run-scoped gate reader (cinatra#2066, C0). Every OTHER gate reader is pair- or
// gate-keyed — a run could not enumerate its own gates, so a RESOLVED gate was
// invisible from any run surface (the run-embedding audit's lack #2). This is the
// missing run-scoped reader: it lists EVERY gate a run owns (pending AND
// resolved), ordered by creation so the canonical run view can weave them into
// the step rail as live steps and as read-only history. It reads the SAME table
// through the SAME run-scoped index the emit path anchors on
// (`artifact_review_gates_run_task_uniq`); no schema change. Access enforcement
// is the aggregate reader's job (readRunDetailAggregate) — this port is a plain
// read, exactly like `readReviewGate`.
// ---------------------------------------------------------------------------
export async function listReviewGatesForRun(runId: string): Promise<ReviewGateRow[]> {
  const rows = await db
    .select()
    .from(artifactReviewGates)
    .where(eq(artifactReviewGates.runId, runId))
    .orderBy(artifactReviewGates.createdAt);
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    orgId: row.orgId,
    reviewTaskId: row.reviewTaskId,
    status: row.status as "pending" | "resolved",
    pinnedTargets: row.pinnedTargets as PinnedReviewTargetRow[],
    disposition: row.disposition,
    fingerprint: row.fingerprint,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
  }));
}

/** One advisory-seam comment attached to a gate (zero-authority, decision-free). */
export interface GateAdvisoryCommentRow {
  id: string;
  gateId: string;
  authorId: string;
  authorKind: string;
  body: string;
  createdAt: Date;
}

/** One post-change verification record bound to a gate. */
export interface GateVerificationRecordRow {
  id: string;
  gateId: string;
  reviewedArtifactId: string;
  reviewedRepresentationRevisionId: string;
  repairedArtifactId: string;
  repairedRepresentationRevisionId: string;
  outcome: string;
  createdAt: Date;
}

/** One immutable auditor-re-home suggestion snapshot bound to a gate. */
export interface GateSuggestionSnapshotRow {
  id: string;
  gateId: string;
  payload: unknown;
  createdAt: Date;
}

/** Batch-read the advisory comments for a set of gates (run-scoped fan-out from
 * `listReviewGatesForRun`). Empty gate set ⇒ no query. Ordered by (gate, time). */
export async function readAdvisoryCommentsForGates(
  gateIds: readonly string[],
): Promise<GateAdvisoryCommentRow[]> {
  if (gateIds.length === 0) return [];
  const rows = await db
    .select()
    .from(gateAdvisoryComments)
    .where(inArray(gateAdvisoryComments.gateId, gateIds as string[]))
    .orderBy(gateAdvisoryComments.gateId, gateAdvisoryComments.createdAt);
  return rows.map((r) => ({
    id: r.id,
    gateId: r.gateId,
    authorId: r.authorId,
    authorKind: r.authorKind,
    body: r.body,
    createdAt: r.createdAt,
  }));
}

/** Batch-read the verification records for a set of gates (run-scoped fan-out). */
export async function readVerificationRecordsForGates(
  gateIds: readonly string[],
): Promise<GateVerificationRecordRow[]> {
  if (gateIds.length === 0) return [];
  const rows = await db
    .select()
    .from(artifactVerificationRecords)
    .where(inArray(artifactVerificationRecords.gateId, gateIds as string[]))
    .orderBy(artifactVerificationRecords.gateId, artifactVerificationRecords.createdAt);
  return rows.map((r) => ({
    id: r.id,
    gateId: r.gateId,
    reviewedArtifactId: r.reviewedArtifactId,
    reviewedRepresentationRevisionId: r.reviewedRepresentationRevisionId,
    repairedArtifactId: r.repairedArtifactId,
    repairedRepresentationRevisionId: r.repairedRepresentationRevisionId,
    outcome: r.outcome,
    createdAt: r.createdAt,
  }));
}

/** Batch-read the suggestion snapshots for a set of gates (run-scoped fan-out). */
export async function readSuggestionSnapshotsForGates(
  gateIds: readonly string[],
): Promise<GateSuggestionSnapshotRow[]> {
  if (gateIds.length === 0) return [];
  const rows = await db
    .select()
    .from(gateSuggestionSnapshots)
    .where(inArray(gateSuggestionSnapshots.gateId, gateIds as string[]))
    .orderBy(gateSuggestionSnapshots.gateId, gateSuggestionSnapshots.createdAt);
  return rows.map((r) => ({
    id: r.id,
    gateId: r.gateId,
    payload: r.payload,
    createdAt: r.createdAt,
  }));
}

/** The PREPARATION core's `readGatePinnedTargets` port. */
export async function readGatePinnedTargets(
  runId: string,
  reviewTaskId: string,
): Promise<GatePinnedOutcome> {
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return { status: "not-found" };
  if (gate.status !== "pending") return { status: "not-pending" };
  return { status: "pending", targets: rowsToTargets(gate.pinnedTargets) };
}

/** The DECISION core's `readGateState` port. Absent is folded into `unavailable`
 * so gate existence is never leaked to the caller. */
export async function readReviewGateState(
  runId: string,
  reviewTaskId: string,
): Promise<ReviewGateState> {
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return { status: "unavailable" };
  if (gate.status === "pending") {
    return { status: "pending", targets: rowsToTargets(gate.pinnedTargets) };
  }
  // resolved — carries the resolving fingerprint for sequential-retry idempotency.
  // A resolved gate ALWAYS carries a fingerprint (the CAS stamps it); guard
  // defensively so a corrupt row degrades to unavailable rather than "" matching.
  if (gate.fingerprint) return { status: "resolved", fingerprint: gate.fingerprint };
  return { status: "unavailable" };
}

// ---------------------------------------------------------------------------
// The atomic decision commit (the DECISION core's `commit` port).
// ---------------------------------------------------------------------------

/**
 * Persist a decision plan in ONE transaction. Terminal (approve/reject) resolves
 * the gate via a CAS (status pending→resolved, stamping the fingerprint +
 * disposition) and writes the audit rows, any reject tombstone dispositions, and
 * the exactly-once-persisted resume outbox intent. A non-terminal `comment` writes audit
 * rows only (the gate stays pending). All effects are driven from the canonically
 * sorted `plan.auditRows` / `plan.dispositionOps`, so the persisted bytes match
 * the order-independent fingerprint.
 *
 * Idempotency: a terminal CAS that matches 0 rows re-reads the gate — a
 * MATCHING-fingerprint resolved gate is `already-resolved` (a concurrent race
 * committed the same decision; no duplicate effects); any other state is
 * `conflict`. The audit unique index + the outbox PK make re-driven inserts
 * no-ops even under a race.
 *
 * THROWS on a persistence failure (the transaction rolls back every effect,
 * including the resume intent) — the decision core catches it as `commit-failed`,
 * so a committed decision's resume can never be lost and a failure commits nothing.
 */
export async function commitReviewDecision(
  plan: ReviewDecisionCommitPlan,
): Promise<ReviewCommitOutcome> {
  return db.transaction(async (tx) => {
    let gateId: string;
    let orgId: string;

    if (plan.terminal) {
      // Terminal CAS: pending → resolved, stamping fingerprint + disposition.
      const casRows = await tx
        .update(artifactReviewGates)
        .set({
          status: "resolved",
          disposition: plan.disposition,
          fingerprint: plan.fingerprint,
          resolvedAt: sql`now()`,
        })
        .where(
          and(
            eq(artifactReviewGates.runId, plan.runId),
            eq(artifactReviewGates.reviewTaskId, plan.reviewTaskId),
            eq(artifactReviewGates.status, "pending"),
          ),
        )
        .returning({ id: artifactReviewGates.id, orgId: artifactReviewGates.orgId });

      if (casRows.length !== 1) {
        // The gate was not pending. Discriminate idempotent race from conflict.
        const gate = await readReviewGateWithinTx(tx, plan.runId, plan.reviewTaskId);
        if (gate && gate.status === "resolved" && gate.fingerprint === plan.fingerprint) {
          return { status: "already-resolved" };
        }
        return { status: "conflict" };
      }
      gateId = casRows[0].id;
      orgId = casRows[0].orgId;
    } else {
      // Non-terminal comment: the gate must still be pending (a comment cannot
      // annotate a resolved/absent gate). No status change. LOCK the gate row
      // (FOR UPDATE) so a concurrent terminal CAS cannot resolve the gate BETWEEN
      // this read and the audit insert — the lock serializes the two, so the
      // comment either commits while still pending or reads the resolved status
      // and fails closed (no comment lands on a just-resolved gate).
      const gate = await readReviewGateWithinTx(tx, plan.runId, plan.reviewTaskId, {
        forUpdate: true,
      });
      if (!gate || gate.status !== "pending") {
        return { status: "conflict" };
      }
      gateId = gate.id;
      orgId = gate.orgId;
    }

    // Audit rows — idempotent on (gate_id, decision_fingerprint, artifact_id,
    // representation_revision_id) so a response-lost retry re-drives no dupes.
    if (plan.auditRows.length > 0) {
      await tx
        .insert(artifactReviewAudit)
        .values(
          plan.auditRows.map((r) => ({
            id: randomUUID(),
            gateId,
            runId: plan.runId,
            reviewTaskId: plan.reviewTaskId,
            decisionFingerprint: plan.fingerprint,
            artifactId: r.artifactId,
            representationRevisionId: r.representationRevisionId,
            disposition: r.disposition,
            rendererKind: r.rendererProvenance.kind,
            rendererPackage: r.rendererProvenance.packageName,
            rendererDigest: r.rendererProvenance.digest,
          })),
        )
        .onConflictDoNothing({
          target: [
            artifactReviewAudit.gateId,
            artifactReviewAudit.decisionFingerprint,
            artifactReviewAudit.artifactId,
            artifactReviewAudit.representationRevisionId,
          ],
        });
    }

    // Reject tombstone dispositions (durable record; the objects-store tombstone
    // application is drained downstream via applied_at). Idempotent on
    // (gate_id, artifact_id, representation_revision_id).
    if (plan.dispositionOps.length > 0) {
      await tx
        .insert(artifactReviewDispositions)
        .values(
          plan.dispositionOps.map((op) => ({
            id: randomUUID(),
            gateId,
            orgId,
            runId: plan.runId,
            artifactId: op.artifactId,
            representationRevisionId: op.representationRevisionId,
            kind: op.kind,
          })),
        )
        .onConflictDoNothing({
          target: [
            artifactReviewDispositions.gateId,
            artifactReviewDispositions.artifactId,
            artifactReviewDispositions.representationRevisionId,
          ],
        });
    }

    // Terminal resume intent (PK gate_id ⇒ at most one durable intent per gate).
    // A PLAIN insert, deliberately NOT onConflictDoNothing: the terminal CAS above
    // just won pending→resolved for the FIRST (and only) time for this gate, so
    // this commit is the SOLE legitimate inserter of the gate's intent. Any
    // pre-existing outbox row is therefore an invariant violation — the PK
    // conflict throws, rolling back the whole commit, rather than silently
    // accepting a stale (possibly wrong-kind) row.
    if (plan.resumeIntent) {
      const responseText =
        plan.resumeIntent.kind === "approve"
          ? plan.resumeIntent.userResponse
          : plan.resumeIntent.rejectResponse;
      await tx.insert(artifactReviewResumeOutbox).values({
        gateId,
        runId: plan.runId,
        reviewTaskId: plan.reviewTaskId,
        kind: plan.resumeIntent.kind,
        responseText,
        status: "pending",
      });
    }

    return { status: "committed" };
  });
}

async function readReviewGateWithinTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  runId: string,
  reviewTaskId: string,
  opts?: { forUpdate?: boolean },
): Promise<{ id: string; orgId: string; status: string; fingerprint: string | null } | null> {
  const base = tx
    .select({
      id: artifactReviewGates.id,
      orgId: artifactReviewGates.orgId,
      status: artifactReviewGates.status,
      fingerprint: artifactReviewGates.fingerprint,
    })
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.runId, runId),
        eq(artifactReviewGates.reviewTaskId, reviewTaskId),
      ),
    )
    .limit(1);
  const rows = opts?.forUpdate ? await base.for("update") : await base;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The resume-intent drain (exactly-once persistence, at-least-once delivery — the
// delivery worker's lease seam; the resume consumer must be idempotent per gate).
// ---------------------------------------------------------------------------

export interface ResumeIntentRow {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  kind: "approve" | "reject";
  responseText: string;
  status: "pending" | "delivering" | "done";
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
}

export async function readResumeIntent(gateId: string): Promise<ResumeIntentRow | null> {
  const rows = await db
    .select()
    .from(artifactReviewResumeOutbox)
    .where(eq(artifactReviewResumeOutbox.gateId, gateId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    gateId: row.gateId,
    runId: row.runId,
    reviewTaskId: row.reviewTaskId,
    kind: row.kind as "approve" | "reject",
    responseText: row.responseText,
    status: row.status as "pending" | "delivering" | "done",
    attempts: row.attempts,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

/**
 * LEASE the next batch of deliverable resume intents (pending, or delivering with
 * an EXPIRED lease — a crashed worker's rows are recoverable). One winner per row
 * (FOR UPDATE SKIP LOCKED), a fresh lease token + expiry stamped, `attempts`
 * incremented. The delivery worker sends each (approve→approve wire /
 * reject→reject wire, the `kind` is authoritative), then calls
 * markResumeIntentDelivered with the SAME lease token. Delivery is AT-LEAST-ONCE
 * (a crash after send, before mark, re-delivers on lease expiry), so the resume
 * consumer must be idempotent per gate.
 */
export async function claimPendingResumeIntents(opts?: {
  limit?: number;
  leaseMs?: number;
}): Promise<ResumeIntentRow[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200));
  const leaseMs = Math.max(1000, opts?.leaseMs ?? 60_000);
  const leaseToken = randomUUID();

  const claimed = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ gateId: artifactReviewResumeOutbox.gateId })
      .from(artifactReviewResumeOutbox)
      .where(
        and(
          // Gate-store extension (cinatra#2038 S0): a DEAD-LETTERED intent is
          // never re-claimed — its attempts were exhausted; it awaits ops.
          isNull(artifactReviewResumeOutbox.deadLetteredAt),
          or(
            eq(artifactReviewResumeOutbox.status, "pending"),
            and(
              eq(artifactReviewResumeOutbox.status, "delivering"),
              lte(artifactReviewResumeOutbox.leaseExpiresAt, sql`now()`),
            ),
          ),
        ),
      )
      .orderBy(artifactReviewResumeOutbox.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.gateId);
    return tx
      .update(artifactReviewResumeOutbox)
      .set({
        status: "delivering",
        leaseToken,
        leaseExpiresAt: sql`now() + (${leaseMs} || ' milliseconds')::interval`,
        attempts: sql`${artifactReviewResumeOutbox.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(inArray(artifactReviewResumeOutbox.gateId, ids))
      .returning();
  });

  return claimed.map((row) => ({
    gateId: row.gateId,
    runId: row.runId,
    reviewTaskId: row.reviewTaskId,
    kind: row.kind as "approve" | "reject",
    responseText: row.responseText,
    status: row.status as "pending" | "delivering" | "done",
    attempts: row.attempts,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
  }));
}

/**
 * Mark a leased resume intent DELIVERED — single-shot, guarded by the lease
 * token so a STALE worker (whose lease expired and was re-claimed) can never mark
 * another worker's in-flight delivery done. Returns true iff this call owned the
 * live lease.
 */
export async function markResumeIntentDelivered(
  gateId: string,
  leaseToken: string,
): Promise<boolean> {
  const done = await db
    .update(artifactReviewResumeOutbox)
    .set({ status: "done", updatedAt: sql`now()` })
    .where(
      and(
        eq(artifactReviewResumeOutbox.gateId, gateId),
        eq(artifactReviewResumeOutbox.leaseToken, leaseToken),
        eq(artifactReviewResumeOutbox.status, "delivering"),
      ),
    )
    .returning({ gateId: artifactReviewResumeOutbox.gateId });
  return done.length === 1;
}

// ---------------------------------------------------------------------------
// Gate-store extension: resume DEAD-LETTER (cinatra#2038, epic #2037 S0).
//
// The 0072 lease drain re-claims a delivering row whenever its lease expires —
// with no ceiling, a permanently-undeliverable resume would be re-leased forever.
// This slice adds a `max_attempts` ceiling + a `dead_lettered_at` STATE marker: a
// row whose `attempts` reached its `max_attempts` and is not `done` is
// DEAD-LETTERED (removed from the claim set — see `claimPendingResumeIntents` —
// and surfaced to ops), never silently retried into oblivion.
// ---------------------------------------------------------------------------

/**
 * Dead-letter every resume intent that has EXHAUSTED its delivery attempts
 * (`attempts >= max_attempts`), is not yet `done` / already dead-lettered, AND is
 * NOT actively in-flight. A `delivering` row with a LIVE lease is left alone — its
 * current attempt may still succeed; only once that lease EXPIRES (the worker
 * crashed / gave up) is the exhausted row dead-lettered instead of re-claimed. A
 * `pending` row (no live lease) with exhausted attempts is dead-lettered directly.
 * Sets `dead_lettered_at = now()` (+ an optional `last_error`) so the row leaves
 * the claim set and appears in ops visibility. Bounded to `limit` per pass via a
 * LIMIT subquery; returns the ACTUAL count transitioned. Idempotent.
 */
export async function deadLetterExhaustedResumeIntents(opts?: {
  lastError?: string;
  limit?: number;
}): Promise<number> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  // The FULL eligibility predicate: exhausted, not delivered/dead, and NOT
  // actively in-flight (a `delivering` row with a LIVE lease is left to finish).
  const eligibleCond = and(
    isNull(artifactReviewResumeOutbox.deadLetteredAt),
    gte(artifactReviewResumeOutbox.attempts, artifactReviewResumeOutbox.maxAttempts),
    or(
      // A pending (un-leased) exhausted row.
      eq(artifactReviewResumeOutbox.status, "pending"),
      // A delivering row with NO LIVE lease — expired OR never set (NULL). Either
      // way no worker is in-flight, so an exhausted strand is dead-letterable; a
      // NULL-lease delivering row would otherwise be un-claimable AND
      // un-dead-letterable (stuck forever). A LIVE lease (future, non-null) matches
      // neither branch, so the "leave an in-flight attempt to finish" rule holds.
      and(
        eq(artifactReviewResumeOutbox.status, "delivering"),
        or(
          isNull(artifactReviewResumeOutbox.leaseExpiresAt),
          lte(artifactReviewResumeOutbox.leaseExpiresAt, sql`now()`),
        ),
      ),
    ),
  );
  const eligible = db
    .select({ gateId: artifactReviewResumeOutbox.gateId })
    .from(artifactReviewResumeOutbox)
    .where(eligibleCond)
    .limit(limit);
  const dead = await db
    .update(artifactReviewResumeOutbox)
    .set({
      deadLetteredAt: sql`now()`,
      lastError: opts?.lastError ?? "resume delivery attempts exhausted",
      updatedAt: sql`now()`,
    })
    // RE-ASSERT the FULL eligibility predicate under the UPDATE (a proper CAS), not
    // just `dead_lettered_at IS NULL`: between the subquery select and this update a
    // concurrent claim could re-lease the row (fresh future lease) or a delivery
    // could mark it `done` — neither may be dead-lettered.
    .where(and(inArray(artifactReviewResumeOutbox.gateId, eligible), eligibleCond))
    .returning({ gateId: artifactReviewResumeOutbox.gateId });
  return dead.length;
}

export interface DeadLetteredResumeRow {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  kind: "approve" | "reject";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  deadLetteredAt: Date | null;
}

/** Ops visibility: the dead-lettered resume intents (delivery attempts
 * exhausted). The surface the AC's "surfaced in ops visibility" requires. */
export async function readDeadLetteredResumeIntents(limit = 100): Promise<DeadLetteredResumeRow[]> {
  const rows = await db
    .select()
    .from(artifactReviewResumeOutbox)
    .where(isNotNull(artifactReviewResumeOutbox.deadLetteredAt))
    .limit(Math.max(1, Math.min(limit, 500)));
  return rows.map((r) => ({
    gateId: r.gateId,
    runId: r.runId,
    reviewTaskId: r.reviewTaskId,
    kind: r.kind as "approve" | "reject",
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    lastError: r.lastError,
    deadLetteredAt: r.deadLetteredAt,
  }));
}

// ---------------------------------------------------------------------------
// Disposition inspection (the tombstone-application drain is downstream; the
// record + its `applied_at` pending marker are this store's durable output).
// ---------------------------------------------------------------------------

export interface ReviewDispositionRow {
  id: string;
  gateId: string;
  orgId: string;
  runId: string;
  artifactId: string;
  representationRevisionId: string;
  kind: string;
  appliedAt: Date | null;
}

export async function readGateDispositions(gateId: string): Promise<ReviewDispositionRow[]> {
  const rows = await db
    .select()
    .from(artifactReviewDispositions)
    .where(eq(artifactReviewDispositions.gateId, gateId));
  return rows.map((r) => ({
    id: r.id,
    gateId: r.gateId,
    orgId: r.orgId,
    runId: r.runId,
    artifactId: r.artifactId,
    representationRevisionId: r.representationRevisionId,
    kind: r.kind,
    appliedAt: r.appliedAt,
  }));
}

export interface ReviewAuditRowRead {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  decisionFingerprint: string;
  artifactId: string;
  representationRevisionId: string;
  disposition: string;
  rendererKind: string;
  rendererPackage: string | null;
  rendererDigest: string | null;
}

export async function readGateAuditRows(gateId: string): Promise<ReviewAuditRowRead[]> {
  const rows = await db
    .select()
    .from(artifactReviewAudit)
    .where(eq(artifactReviewAudit.gateId, gateId));
  return rows.map((r) => ({
    gateId: r.gateId,
    runId: r.runId,
    reviewTaskId: r.reviewTaskId,
    decisionFingerprint: r.decisionFingerprint,
    artifactId: r.artifactId,
    representationRevisionId: r.representationRevisionId,
    disposition: r.disposition,
    rendererKind: r.rendererKind,
    rendererPackage: r.rendererPackage,
    rendererDigest: r.rendererDigest,
  }));
}

// ---------------------------------------------------------------------------
// Run-access resolution — the run/gate ports' `verifyRunAccess` half. Resolves
// the run's effective auth policy + co-owners exactly as review-task-actions'
// resume gate does, then enforces the review op against the ACTUAL reviewing
// actor. Kept here (agents-coupled) so the artifact-side binder in
// src/app/artifacts/[id]/review-target-prepare.ts stays free of any
// agents-package coupling (the #1807 split).
//
//   preparation  → op "read"          (a reviewer must be able to READ the run)
//   approve/reject → op "approveHitl"  (a terminal decision drives the gate)
//   comment      → op "respondToHitl"  (a non-terminal annotation)
//
// A null run becomes a 404-shaped AuthzError inside enforceRunAccess so a caller
// cannot probe foreign run ids via the error — mapped here to {ok:false,404}.
// ---------------------------------------------------------------------------

export async function enforceReviewRunAccess(
  runId: string,
  actor: PrimitiveActorContext,
  op: "read" | ReviewRunAccessOp,
  roles?: ActorRoleHints,
): Promise<RunAccessOutcome> {
  // Plain fetch (no actor ⇒ no internal enforce) — this helper OWNS the gate.
  const run = await readAgentRunById(runId);
  let runForCheck: RunForAccessCheck | null = null;
  if (run) {
    // Resolve the effective policy through the SHARED resolver (falls back to
    // DEFAULT_AGENT_AUTH_POLICY — owner-only — when both run + template policy
    // are null; a bare `?? null` would let a null policy read as no ceiling).
    // Spread `...run` so `oboCeiling` (and the rest of the run record) rides into
    // enforceRunAccess for OBO containment — the exact runForCheck construction
    // readAgentRunById uses; a hand-picked subset silently dropped the ceiling.
    let effectivePolicy = run.authPolicy;
    if (!effectivePolicy) {
      const template = run.templateId ? await readAgentTemplateById(run.templateId) : null;
      effectivePolicy = resolveEffectivePolicy(run, template);
    }
    const coOwnerRows = await readRunCoOwners(run.id);
    runForCheck = {
      ...run,
      effectivePolicy,
      coOwnerUserIds: coOwnerRows.map((r) => r.userId),
    };
  }
  try {
    await enforceRunAccess(runForCheck, actor, op, roles);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, status: err.statusCode };
    throw err;
  }
}
