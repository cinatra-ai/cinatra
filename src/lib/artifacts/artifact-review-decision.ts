/**
 * The generic artifact-review DECISION core (cinatra#1795, epic #1620 S12,
 * items 4 + 5): the versioned decision payload, submit-time re-validation, the
 * atomic multi-target commit plan, server-authoritative audit + disposition
 * capture, and true (sequential + concurrent) idempotency.
 *
 * SUBMIT-TIME RE-VALIDATION (never trust the prepared snapshot): the reviewer's
 * decision is re-checked against the LIVE gate at submit — the target set still
 * belongs to the pending gate (no substitution; a terminal decision covers the
 * whole gate), every reviewed revision is still a live member, and the gate is
 * still pending. A stale prepare cannot commit a decision the gate no longer
 * authorizes.
 *
 * SERVER-AUTHORITATIVE PROVENANCE (never client-supplied): the client decision
 * names only WHAT is reviewed (the immutable targets) + the disposition. The
 * renderer PROVENANCE recorded on each audit row is RE-DERIVED by the host from
 * the artifact's TYPE at submit time (the `deriveProvenance` port, the same
 * type-resolution the preparation surface uses) — a client cannot forge the
 * "what rendered" audit field, and a renderer that became unbuilt between prepare
 * and submit is recorded as it now resolves.
 *
 * ATOMICITY + EXACTLY-ONCE RESUME (the AC-3 invariant, corrected): a decision
 * over N targets is all-or-nothing. If ANY target fails re-validation the core
 * aborts BEFORE producing a commit plan. The workflow resume is NOT a separate
 * post-commit side effect (which could fail and strand a resolved-but-unresumed
 * workflow) — the terminal resume INTENT is part of the plan and the `commit`
 * port persists it TRANSACTIONALLY with the gate CAS + audit rows + dispositions
 * (a durable outbox — the intent is persisted EXACTLY ONCE, and the binder's
 * delivery worker drains it AT-LEAST-ONCE, so the downstream resume consumer must
 * be idempotent per gate). So a persistence failure rolls back every effect
 * INCLUDING the resume, and a committed decision's resume can never be lost.
 *
 * IDEMPOTENCY (sequential AND concurrent): the decision carries a stable
 * FINGERPRINT (run + gate + disposition + sorted targets + comment). A gate
 * resolved by a MATCHING fingerprint — whether discovered at read time (a normal
 * response-lost retry) or at commit time (a concurrent race) — is an idempotent
 * success; a DIFFERENT fingerprint is a conflict. The outbox makes the resume
 * safe to have already been (or still be about to be) delivered.
 *
 * DISPOSITION (AC-3): a REJECT records a TOMBSTONE disposition on the reviewed
 * artifacts (the `ReviewDispositionOp` union does not admit a hard delete).
 *
 * PURE (no React / DB / server-only): every seam is an injected port. The live
 * binder (the single-transaction commit + the outbox resume-delivery worker + the
 * type-resolution `deriveProvenance`) is the decision-chrome surface's job —
 * fenced until the review-surface design spec — and MUST honor the
 * single-transaction + exactly-once-PERSISTENCE / at-least-once-delivery
 * (idempotent-consumer) contract this core assumes.
 */
import { createHash } from "node:crypto";

import {
  normalizeReviewTargets,
  partitionAgainstPinnedTargets,
  reviewTargetKey,
  reviewTargetKeySet,
  type ArtifactReviewTarget,
} from "./artifact-review-target";
import type { RevisionMemberOutcome, RunAccessOutcome, ReviewTargetMount } from "./artifact-review-preparation";
import { buildReviewResumeText } from "./artifact-review-rejection";

// ---------------------------------------------------------------------------
// The versioned decision payload (client-supplied WHAT + disposition only).
// ---------------------------------------------------------------------------

export const ARTIFACT_REVIEW_DECISION_API_VERSION = 1;

export type ReviewDisposition = "approve" | "reject" | "comment";

/** The renderer that the host resolved for a reviewed revision, captured on the
 * audit row (AC-3 "renderer provenance"). Derived SERVER-SIDE from the artifact
 * type — never accepted from the client. `digest` is set only for a runtime
 * (main-realm dynamic) load — the exact package + content digest. */
export interface ReviewRendererProvenance {
  kind: "build-map" | "runtime" | "floor";
  packageName: string | null;
  digest: string | null;
}

/** Map a host mount descriptor to audit provenance. The `deriveProvenance` port
 * binder uses this against the mount it RE-RESOLVES at submit time (from the
 * type), so the provenance is authoritative, not a client claim. */
export function rendererProvenanceFromMount(mount: ReviewTargetMount): ReviewRendererProvenance {
  if (mount.kind === "build-map") {
    return { kind: "build-map", packageName: mount.packageName, digest: null };
  }
  if (mount.kind === "runtime") {
    return { kind: "runtime", packageName: mount.packageName, digest: mount.descriptor.tuple.digest };
  }
  return { kind: "floor", packageName: mount.packageName, digest: null };
}

/** The client decision: WHAT is reviewed + the disposition + an optional comment.
 * Carries NO renderer identity and NO provenance — both are host-authoritative. */
export interface ArtifactReviewDecision {
  decisionApiVersion: number;
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  comment: string | null;
  reviewedTargets: ArtifactReviewTarget[];
}

/**
 * The stable idempotency fingerprint of a decision: a hash over run + gate +
 * disposition + the SORTED target key set + the comment. Order-independent in the
 * targets (sorted) so two submits of the same decision with reordered targets
 * fingerprint identically. The binder stamps this on the resolved gate; a retry
 * or race that matches is idempotent, a mismatch is a conflict.
 */
export function reviewDecisionFingerprint(decision: {
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  comment: string | null;
  reviewedTargets: ReadonlyArray<ArtifactReviewTarget>;
}): string {
  const targetKeys = decision.reviewedTargets.map(reviewTargetKey).sort();
  const material = JSON.stringify({
    v: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    comment: decision.comment,
    targetKeys,
  });
  return createHash("sha256").update(material).digest("hex");
}

// ---------------------------------------------------------------------------
// The atomic commit plan (what the binder persists in ONE transaction).
// ---------------------------------------------------------------------------

export interface ReviewAuditRow {
  artifactId: string;
  representationRevisionId: string;
  disposition: ReviewDisposition;
  /** Host-derived — the renderer the artifact's type resolves to at submit time. */
  rendererProvenance: ReviewRendererProvenance;
}

/** A reject disposition op. The union admits ONLY `tombstone` — a review can
 * never hard-delete a durable artifact. */
export interface ReviewDispositionOp {
  artifactId: string;
  representationRevisionId: string;
  kind: "tombstone";
}

/** The terminal resume INTENT — persisted transactionally with the resolution
 * (exactly once) and drained at-least-once by the binder's delivery worker (an
 * idempotent consumer makes redelivery safe). Discriminated so a reject can never
 * be delivered down the approve wire. Null for a non-terminal (comment)
 * decision. */
export type ReviewResumeIntent =
  | { kind: "approve"; userResponse: string }
  | { kind: "reject"; rejectResponse: string };

export interface ReviewDecisionCommitPlan {
  runId: string;
  reviewTaskId: string;
  disposition: ReviewDisposition;
  /** approve/reject resolve the gate (CAS + resume intent); comment is a
   * non-terminal annotation (audit only, gate stays pending, no resume). */
  terminal: boolean;
  /** The idempotency fingerprint the binder stamps on the resolved gate. */
  fingerprint: string;
  comment: string | null;
  auditRows: ReviewAuditRow[];
  dispositionOps: ReviewDispositionOp[];
  /** The exactly-once-persisted resume outbox intent (terminal only). */
  resumeIntent: ReviewResumeIntent | null;
}

/** The outcome of the atomic commit CAS. */
export type ReviewCommitOutcome =
  | { status: "committed" }
  /** The gate was already resolved by a MATCHING-fingerprint decision (a
   * concurrent race committed the same decision first) — idempotent. */
  | { status: "already-resolved" }
  /** The gate moved to a state a matching decision cannot resolve (a different
   * decision, or a terminal-other state). */
  | { status: "conflict" };

// ---------------------------------------------------------------------------
// Gate state at read time.
// ---------------------------------------------------------------------------

export type ReviewGateState =
  /** Pending review gate carrying its frozen pinned target set. */
  | { status: "pending"; targets: ArtifactReviewTarget[] }
  /** Already resolved by a review decision, carrying that decision's fingerprint
   * (for sequential-retry idempotency). */
  | { status: "resolved"; fingerprint: string }
  /** Absent, or in a terminal-other state (failed/cancelled) no review decision
   * can resolve. Folded together so gate existence is not leaked. */
  | { status: "unavailable" };

// ---------------------------------------------------------------------------
// Ports.
// ---------------------------------------------------------------------------

export type ReviewRunAccessOp = "approveHitl" | "respondToHitl";

export interface SubmitDecisionPorts {
  /** Access-check the run for the decision op (approve/reject → approveHitl;
   * comment → respondToHitl). */
  verifyRunAccess(runId: string, op: ReviewRunAccessOp): Promise<RunAccessOutcome> | RunAccessOutcome;
  /** The gate's live state: pending (+ frozen pinned set), resolved (+ the
   * resolving fingerprint), or unavailable. */
  readGateState(runId: string, reviewTaskId: string): Promise<ReviewGateState> | ReviewGateState;
  /** Re-confirm a reviewed revision is STILL a live member at submit time. */
  revisionMember(
    artifactId: string,
    representationRevisionId: string,
  ): Promise<RevisionMemberOutcome> | RevisionMemberOutcome;
  /** SERVER-derive the renderer provenance for a reviewed target from its type
   * (the same host mount resolution the preparation surface uses). Never accepts
   * a client provenance claim. */
  deriveProvenance(
    target: ArtifactReviewTarget,
  ): Promise<ReviewRendererProvenance> | ReviewRendererProvenance;
  /** Persist the plan ATOMICALLY (gate CAS stamping `fingerprint` + audit rows +
   * dispositions + the resume outbox intent, in ONE transaction). Returns
   * committed / already-resolved (matching-fingerprint race) / conflict; MUST
   * throw on a persistence failure so the core aborts with nothing committed. */
  commit(plan: ReviewDecisionCommitPlan): Promise<ReviewCommitOutcome>;
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

export type SubmitDecisionError =
  | { kind: "invalid-decision"; message: string }
  | { kind: "run-access-denied"; status: number }
  | { kind: "gate-not-pending" }
  | { kind: "target-substitution"; substituted: ArtifactReviewTarget[] }
  | { kind: "incomplete-coverage"; missing: ArtifactReviewTarget[] }
  | { kind: "revision-not-member"; targets: ArtifactReviewTarget[] }
  | { kind: "gate-conflict" }
  | { kind: "commit-failed"; message: string };

export type SubmitDecisionResult =
  | { ok: true; idempotent: boolean; fingerprint: string; plan: ReviewDecisionCommitPlan | null }
  | { ok: false; error: SubmitDecisionError };

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

const VALID_DISPOSITIONS: ReadonlySet<ReviewDisposition> = new Set([
  "approve",
  "reject",
  "comment",
]);

export async function submitReviewDecisionCore(
  decision: ArtifactReviewDecision,
  ports: SubmitDecisionPorts,
): Promise<SubmitDecisionResult> {
  // 1. Validate the decision shape + normalize targets.
  if (decision.decisionApiVersion !== ARTIFACT_REVIEW_DECISION_API_VERSION) {
    return invalid(`Unsupported decisionApiVersion ${decision.decisionApiVersion}.`);
  }
  if (!VALID_DISPOSITIONS.has(decision.disposition)) {
    return invalid(`Unknown disposition "${decision.disposition}".`);
  }
  if (decision.comment !== null && typeof decision.comment !== "string") {
    return invalid("`comment` must be a string or null.");
  }
  const normalized = normalizeReviewTargets(decision.reviewedTargets);
  if (!normalized.ok) return invalid(normalized.error);
  // CANONICAL ORDER: sort the deduped targets by key and drive EVERY plan effect
  // (fingerprint, audit rows, disposition ops, resume intent) from this order. The
  // fingerprint is order-independent (it sorts internally), so the persisted
  // effects must be too — otherwise `[A,B]` and `[B,A]` would share a fingerprint
  // (deemed the same decision) yet emit different outbox/audit bytes. Targets are a
  // SET (the gate pinned a set); order carries no review meaning, so canonicalizing
  // loses nothing and makes idempotency byte-consistent.
  const reviewedTargets = [...normalized.targets].sort(byTargetKey);
  const terminal = decision.disposition !== "comment";
  const fingerprint = reviewDecisionFingerprint({
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    comment: decision.comment,
    reviewedTargets,
  });

  // 2. Run access for the decision op.
  const op: ReviewRunAccessOp = terminal ? "approveHitl" : "respondToHitl";
  const access = await ports.verifyRunAccess(decision.runId, op);
  if (!access.ok) {
    return { ok: false, error: { kind: "run-access-denied", status: access.status } };
  }

  // 3. Live gate state. A gate ALREADY resolved by THIS decision (a response-lost
  // sequential retry) is idempotent success; by a DIFFERENT decision, a conflict;
  // unavailable, gate-not-pending. Only a still-pending gate re-validates + commits.
  const gate = await ports.readGateState(decision.runId, decision.reviewTaskId);
  if (gate.status === "resolved") {
    if (gate.fingerprint === fingerprint) {
      // Already committed by an identical prior submit — the resume intent was
      // persisted with it and is delivered (at-least-once) by the outbox to an
      // idempotent consumer, so this retry re-drives nothing.
      return { ok: true, idempotent: true, fingerprint, plan: null };
    }
    return { ok: false, error: { kind: "gate-conflict" } };
  }
  if (gate.status !== "pending") {
    return { ok: false, error: { kind: "gate-not-pending" } };
  }

  // 4. Substitution: every reviewed target must belong to the pinned set.
  const { substituted } = partitionAgainstPinnedTargets(reviewedTargets, gate.targets);
  if (substituted.length > 0) {
    return { ok: false, error: { kind: "target-substitution", substituted } };
  }

  // 4b. Coverage: a TERMINAL decision resolves the whole gate, so it must cover
  // every pinned target; `comment` may annotate a subset.
  if (terminal) {
    const reviewedKeys = reviewTargetKeySet(reviewedTargets);
    const missing = gate.targets.filter((t) => !reviewedKeys.has(reviewTargetKey(t)));
    if (missing.length > 0) {
      return { ok: false, error: { kind: "incomplete-coverage", missing } };
    }
  }

  // 5. Per target: re-check membership (submit-time TOCTOU) AND derive the
  // server-authoritative renderer provenance from the type. Any vanished revision
  // aborts the WHOLE decision before any effect.
  const notMember: ArtifactReviewTarget[] = [];
  const auditRows: ReviewAuditRow[] = [];
  for (const target of reviewedTargets) {
    const member = await ports.revisionMember(target.artifactId, target.representationRevisionId);
    if (!member) {
      notMember.push(target);
      continue;
    }
    const rendererProvenance = await ports.deriveProvenance(target);
    auditRows.push({
      artifactId: target.artifactId,
      representationRevisionId: target.representationRevisionId,
      disposition: decision.disposition,
      rendererProvenance,
    });
  }
  if (notMember.length > 0) {
    return { ok: false, error: { kind: "revision-not-member", targets: notMember } };
  }

  // 6. Build the atomic commit plan. A reject records a TOMBSTONE per reviewed
  // artifact (never a hard delete — the op union admits none). The terminal
  // resume intent is part of the plan so the commit persists it transactionally.
  const dispositionOps: ReviewDispositionOp[] =
    decision.disposition === "reject"
      ? reviewedTargets.map((t) => ({
          artifactId: t.artifactId,
          representationRevisionId: t.representationRevisionId,
          kind: "tombstone" as const,
        }))
      : [];
  const resumeIntent = terminal ? buildResumeIntent(decision, reviewedTargets) : null;
  const plan: ReviewDecisionCommitPlan = {
    runId: decision.runId,
    reviewTaskId: decision.reviewTaskId,
    disposition: decision.disposition,
    terminal,
    fingerprint,
    comment: decision.comment,
    auditRows,
    dispositionOps,
    resumeIntent,
  };

  // 7. Atomic commit (gate CAS + audit + dispositions + resume outbox intent).
  let outcome: ReviewCommitOutcome;
  try {
    outcome = await ports.commit(plan);
  } catch (err) {
    // Persistence failed — the binder's transaction rolled back every effect
    // (including the resume intent). Zero partial commit; nothing to resume.
    return {
      ok: false,
      error: { kind: "commit-failed", message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (outcome.status === "conflict") {
    return { ok: false, error: { kind: "gate-conflict" } };
  }
  // committed | already-resolved (a concurrent matching-fingerprint race) are both
  // success; the resume rides the durable outbox either way (never inline here).
  return {
    ok: true,
    idempotent: outcome.status === "already-resolved",
    fingerprint,
    plan,
  };
}

function buildResumeIntent(
  decision: ArtifactReviewDecision,
  reviewedTargets: ReadonlyArray<ArtifactReviewTarget>,
): ReviewResumeIntent {
  const resumeText = buildReviewResumeText({
    disposition: decision.disposition === "reject" ? "reject" : "approve",
    reviewTaskId: decision.reviewTaskId,
    comment: decision.comment,
    targets: reviewedTargets,
  });
  return resumeText.kind === "approve"
    ? { kind: "approve", userResponse: resumeText.userResponse }
    : { kind: "reject", rejectResponse: resumeText.rejectResponse };
}

function invalid(message: string): SubmitDecisionResult {
  return { ok: false, error: { kind: "invalid-decision", message } };
}

/** Total order on targets by their canonical key — the single sort that makes the
 * plan bytes order-independent, matching the order-independent fingerprint. */
function byTargetKey(a: ArtifactReviewTarget, b: ArtifactReviewTarget): number {
  const ka = reviewTargetKey(a);
  const kb = reviewTargetKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
