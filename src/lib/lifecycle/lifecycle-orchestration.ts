/**
 * The REVIEW-ORCHESTRATION pure core (cinatra#2039, epic #2037 S1).
 *
 * S1 makes review AUTOMATIC: an `ArtifactProduced` event (S0 outbox) is turned
 * into a policy-matched review gate with NO agent-side wiring. This module is the
 * TOTAL, DB-free decision the outbox consumer drives per event — it evaluates the
 * S0 lattice for the REVIEW checkpoint (Point V; recommendation is S3, verification
 * is S4) and returns exactly what the store must persist: create a gate (and how
 * the run continues + which effect it holds) or leave the artifact ungated.
 *
 * IDEMPOTENCY is baked into the derived review-task id: an auto-gate's
 * `reviewTaskId` is a pure function of the DETERMINISTIC produced-event id, so an
 * event replay re-derives the SAME task id and the gate emitter (idempotent on
 * `(run_id, review_task_id)`) is a no-op — no duplicate gate. The prefix is
 * DISJOINT from the flow-authored `wayflow-<taskId>` reviewer-gate convention
 * (#1796), so the resume-delivery worker never mis-routes an auto-gate down the
 * WayFlow resume wire and vice-versa.
 *
 * PURE (no React / DB / server-only): the store (packages/agents/src/
 * lifecycle-review-orchestration-store.ts) injects the resolved context (artifact
 * type, org bound, compiled manifest, human-present) — none of which lives on the
 * event row — and applies this plan.
 */

import { createHash } from "node:crypto";

import {
  evaluatePolicy,
  isExternalEffectClass,
  type CompiledManifestLifecycle,
  type DestinationClass,
  type LifecycleOriginKind,
  type OrgPolicyRule,
  type PolicyOutcome,
  type RunElevation,
} from "./lifecycle-policy";
import { evaluateThenPark, type EvaluateThenParkOutcome } from "./lifecycle-continuation";
import type { BatchTarget } from "./lifecycle-batch";
import type { ContinuationMode } from "./lifecycle-produced-event";

// ---------------------------------------------------------------------------
// The auto-gate review-task id (idempotency + routing key).
// ---------------------------------------------------------------------------

/** The prefix every AUTO-created review gate's `reviewTaskId` carries. DISJOINT
 * from the flow-authored `wayflow-` reviewer-gate prefix (#1796) so the two gate
 * families never collide and the resume-delivery worker (which only resumes a
 * `wayflow-<taskId>` run) skips auto-gates by construction. */
export const AUTO_REVIEW_TASK_PREFIX = "lifecycle-review:";

/** Derive the stable `reviewTaskId` for an auto-created review gate from the
 * DETERMINISTIC produced-event id. Total + injective on the event id, so a
 * replayed event re-derives the identical task id (the emitter is idempotent on
 * it) and two distinct events never share a gate. */
export function autoReviewTaskId(eventId: string): string {
  return `${AUTO_REVIEW_TASK_PREFIX}${eventId}`;
}

/** Whether a `reviewTaskId` names an auto-created (S1) review gate. */
export function isAutoReviewTaskId(reviewTaskId: string): boolean {
  return reviewTaskId.startsWith(AUTO_REVIEW_TASK_PREFIX);
}

/** The INVERSE of `autoReviewTaskId`: recover the produced-event id a SINGLE-target
 * auto-gate task id encodes, or null when the task id is not a single-event
 * auto-gate. Single-sources the prefix so a store re-deriving the event (e.g. to
 * re-evaluate an expired gate's requiredness) never hardcodes the prefix length. A
 * BATCH partition gate (`lifecycle-review:batch:` — a coalesced production, see
 * below) encodes no single event id, so it returns null: the store re-derives a
 * batch gate's requiredness from its PINNED target set, not from one event. */
export function autoReviewEventId(reviewTaskId: string): string | null {
  // A BATCH partition gate, an S2 REPAIR-SUCCESSOR gate, or an S4 VERIFICATION-
  // REOPEN gate encodes no single event id; the store re-derives their requiredness
  // from the PINNED target set.
  if (
    isBatchAutoReviewTaskId(reviewTaskId) ||
    isRepairSuccessorTaskId(reviewTaskId) ||
    isVerificationReopenTaskId(reviewTaskId)
  ) {
    return null;
  }
  return isAutoReviewTaskId(reviewTaskId)
    ? reviewTaskId.slice(AUTO_REVIEW_TASK_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// S2 (cinatra#2040) — repair-successor gate ids.
// ---------------------------------------------------------------------------

/** The prefix a REPAIR-SUCCESSOR gate's `reviewTaskId` carries — the NEW gate that
 * pins a producer's repaired (successor) revision after a `changes_requested`
 * decision (never re-pinned under the reviewer; always a fresh gate). A superset of
 * `AUTO_REVIEW_TASK_PREFIX` so `isAutoReviewTaskId` recognizes it (the expiry drain
 * reasons over it; the resume-delivery worker still skips it, being non-`wayflow-`),
 * and DISJOINT from the batch prefix. */
export const REPAIR_SUCCESSOR_TASK_PREFIX = `${AUTO_REVIEW_TASK_PREFIX}repair:`;

/** Derive the successor gate's `reviewTaskId` from the repair lineage id + the
 * attempt ordinal. Deterministic + injective on `(repairId, attempt)`, so a
 * re-driven pin of the SAME successor is idempotent on `(run, task)` and two
 * distinct repair attempts never collide. */
export function repairSuccessorReviewTaskId(repairId: string, attempt: number): string {
  return `${REPAIR_SUCCESSOR_TASK_PREFIX}${repairId}:${attempt}`;
}

/** Whether a `reviewTaskId` names an S2 repair-successor gate. */
export function isRepairSuccessorTaskId(reviewTaskId: string): boolean {
  return reviewTaskId.startsWith(REPAIR_SUCCESSOR_TASK_PREFIX);
}

// ---------------------------------------------------------------------------
// S4 (cinatra#2042) — post-change verification-reopen gate ids.
// ---------------------------------------------------------------------------

/** The prefix a VERIFICATION-REOPEN gate's `reviewTaskId` carries — the ONE bounded
 * gate a FAILED post-change verification reopens on the same run (S4, epic spine
 * item 5). A superset of `AUTO_REVIEW_TASK_PREFIX` so `isAutoReviewTaskId`
 * recognizes it (the expiry drain reasons over it; the resume-delivery worker skips
 * it, being non-`wayflow-`), and DISJOINT from the repair-successor + batch
 * prefixes. It re-derives the repaired target's requiredness from the PINNED set. */
export const VERIFICATION_REOPEN_TASK_PREFIX = `${AUTO_REVIEW_TASK_PREFIX}verify:`;

/** Derive the verification-reopen gate's `reviewTaskId` from the verification
 * record id. Deterministic + injective, so a re-driven verification of the SAME
 * repair re-derives the identical reopen gate (idempotent on `(run, task)`) — a
 * failed verification reopens EXACTLY ONE bounded gate, never a fresh one per drive. */
export function verificationReopenReviewTaskId(verificationId: string): string {
  return `${VERIFICATION_REOPEN_TASK_PREFIX}${verificationId}`;
}

/** Whether a `reviewTaskId` names an S4 verification-reopen gate. */
export function isVerificationReopenTaskId(reviewTaskId: string): boolean {
  return reviewTaskId.startsWith(VERIFICATION_REOPEN_TASK_PREFIX);
}

// ---------------------------------------------------------------------------
// Batch (coalesced multi-artifact production) partition gate ids.
// ---------------------------------------------------------------------------

/** The prefix a BATCH PARTITION gate's `reviewTaskId` carries — a coalesced
 * multi-artifact production, partitioned into ≤50-target atomicity units per the
 * S0 batch contract (`lifecycle-batch.ts`). A superset of `AUTO_REVIEW_TASK_PREFIX`
 * so `isAutoReviewTaskId` still recognizes it (the expiry drain reasons over it;
 * the resume-delivery worker still skips it, being non-`wayflow-`). */
export const AUTO_REVIEW_BATCH_PREFIX = `${AUTO_REVIEW_TASK_PREFIX}batch:`;

/** The canonical, INJECTIVE key for a batch target — LENGTH-PREFIXES the artifact
 * id (`<len>:<artifactId>:<representationRevisionId>`) so the hash material is
 * unambiguous for arbitrary opaque ids (the same guarantee `lifecycle-batch`'s
 * private `batchTargetKey` gives). */
function batchTargetHashKey(t: BatchTarget): string {
  return `${t.artifactId.length}:${t.artifactId}:${t.representationRevisionId}`;
}

/** Derive the stable, idempotent `reviewTaskId` for one batch PARTITION gate from
 * its target set. DETERMINISTIC on the SET (sorted by the canonical key, then
 * hashed), so the same partition membership always yields the same id regardless
 * of input order — a replay re-emits onto the same gate (idempotent on
 * `(run, task)`), and two distinct partitions never collide (a target's
 * `(artifactId, representationRevisionId)` is a globally-unique pinned revision, so
 * no target appears in two partitions). Total. */
export function batchPartitionReviewTaskId(partitionTargets: readonly BatchTarget[]): string {
  const material = [...partitionTargets]
    .map(batchTargetHashKey)
    .sort()
    .join("\u0000");
  const hash = createHash("sha256").update(material).digest("hex");
  return `${AUTO_REVIEW_BATCH_PREFIX}${hash}`;
}

/** Whether a `reviewTaskId` names a BATCH partition (coalesced production) gate. */
export function isBatchAutoReviewTaskId(reviewTaskId: string): boolean {
  return reviewTaskId.startsWith(AUTO_REVIEW_BATCH_PREFIX);
}

// ---------------------------------------------------------------------------
// Input: the event's lattice axes + the injected resolution context.
// ---------------------------------------------------------------------------

/** The produced-event fields the review orchestration reasons over. `originKind`
 * is already the LATTICE provenance axis (the emitter maps the physical
 * `ArtifactOriginKind` via `lifecycleOriginKind` at emit time). */
export interface ProducedEventAxes {
  eventId: string;
  artifactId: string;
  representationRevisionId: string;
  originKind: LifecycleOriginKind;
  destinationClass: DestinationClass;
  continuationMode: ContinuationMode;
}

/** The context the store resolves and injects — none of it is on the event row:
 * the artifact TYPE (read from `objects.type`), whether a human is present on the
 * run, the org bound (policy store), and the producing agent's compiled manifest
 * lifecycle declarations (`agent_templates.lifecycle_config`). */
export interface ReviewOrchestrationContext {
  artifactType: string;
  humanPresent: boolean;
  orgRule: OrgPolicyRule;
  manifest?: CompiledManifestLifecycle;
  elevation?: RunElevation;
}

// ---------------------------------------------------------------------------
// Output: the orchestration plan.
// ---------------------------------------------------------------------------

/** The plan the store applies for one produced event. */
export type ReviewOrchestrationPlan =
  | {
      action: "no-gate";
      /** The lattice outcome that produced the non-fire (skip / forbidden). */
      outcome: PolicyOutcome;
      reason: string;
    }
  | {
      action: "create-gate";
      /** The derived, idempotent gate key. */
      reviewTaskId: string;
      /** The lattice outcome (`required` | `fire`). */
      outcome: PolicyOutcome;
      /** How the producing run continues:
       *   - `checkpointed` → the run PARKS (the store calls `maybeParkCheckpoint`
       *     with `park`); the park is released by the decision / TTL sweeper.
       *   - `async_effects_gated` → the run NEVER pauses; the artifact's typed
       *     downstream effect is HELD by the gate until the decision. */
      continuationMode: ContinuationMode;
      /** The evaluate-then-park outcome for a `checkpointed` run (null for an
       * async run — it never parks). */
      park: EvaluateThenParkOutcome | null;
      /** The effect class the gate HOLDS in async mode (an external-effect class),
       * or null when there is no external effect to hold (`none`). Effect-holding
       * is enforced by the store's `isArtifactEffectHeld` predicate — an external
       * artifact under a pending gate cannot publish / promote / hand off. */
      heldEffect: DestinationClass | null;
      reason: string;
    };

/**
 * Plan the REVIEW checkpoint for one produced event. Evaluates the S0 four-layer
 * lattice; a non-fire (skip / forbidden) is `no-gate`; a fire (`required` /
 * `fire`) is `create-gate` with the continuation resolved from the event's
 * declared mode. Total + deterministic.
 *
 * NOTE the lattice can only return `skip | forbidden | required | fire` for the
 * REVIEW checkpoint (its core default is never `indeterminate` — only verification
 * is), so `policy_unresolved` is unreachable here; it is folded into `no-gate`
 * defensively rather than left to fall through.
 */
export function planReviewForEvent(
  event: ProducedEventAxes,
  ctx: ReviewOrchestrationContext,
): ReviewOrchestrationPlan {
  const decision = evaluatePolicy({
    checkpoint: "review",
    artifactType: ctx.artifactType,
    destinationClass: event.destinationClass,
    originKind: event.originKind,
    humanPresent: ctx.humanPresent,
    orgRule: ctx.orgRule,
    manifest: ctx.manifest,
    elevation: ctx.elevation,
  });

  if (!decision.fired) {
    return { action: "no-gate", outcome: decision.outcome, reason: decision.reason };
  }

  const park =
    event.continuationMode === "checkpointed"
      ? evaluateThenPark(decision, {
          checkpoint: "review",
          destinationClass: event.destinationClass,
        })
      : null;

  const heldEffect =
    event.continuationMode === "async_effects_gated" && isExternalEffectClass(event.destinationClass)
      ? event.destinationClass
      : null;

  return {
    action: "create-gate",
    reviewTaskId: autoReviewTaskId(event.eventId),
    outcome: decision.outcome,
    continuationMode: event.continuationMode,
    park,
    heldEffect,
    reason: decision.reason,
  };
}

// ---------------------------------------------------------------------------
// Effects-gating verdict (the pure half of `isArtifactEffectHeld`).
// ---------------------------------------------------------------------------

/** The store-side facts the effects-gating verdict reasons over for one artifact
 * revision. */
export interface EffectHoldFacts {
  /** The produced event for the revision, or null when the revision never
   * emitted one (a pre-fence artifact / a non-enumerated writer). */
  event: { destinationClass: DestinationClass; status: string; continuationAddress: string | null } | null;
  /** The gate the event's `continuationAddress` points at, resolved by the store
   * (null when the address is unset or the gate row is gone). */
  gateStatus: "pending" | "resolved" | null;
  /** The terminal disposition of a RESOLVED gate (S2, cinatra#2040). A gate
   * resolved as `changes_requested` has NOT released its held effect — a repair is
   * in flight; the effect stays held until the successor gate approves. `approve`
   * releases; `reject` terminates the effect (still not held — a tombstoned
   * artifact publishes nothing). Null/absent for a pending gate or a pre-S2 gate. */
  gateDisposition?: "approve" | "reject" | "changes_requested" | null;
  /** TRUE when a CHECKPOINTED continuation park protecting THIS revision's effect
   * was TTL-fail-closed into the terminal `policy_unresolved` state (cinatra#2047
   * defect D-7). S0's continuation contract: "TTL always-resumes with the protected
   * effect in a terminal `policy_unresolved` blocked state" — the block lands on
   * the EFFECT, not merely on the park row. Resolved by the store from
   * `lifecycle_continuation_park` (joined on the produced-event id). */
  policyUnresolvedPark?: boolean;
}

export interface EffectHoldVerdict {
  held: boolean;
  reason: string;
  /** TRUE only for the TERMINAL `policy_unresolved` block (a TTL-expired park):
   * the effect is not merely waiting on a decision — the policy was never resolved
   * and only an explicit later policy decision releases it. Distinguishes an
   * ops-actionable dead end from an ordinary pending-gate hold. */
  policyUnresolved?: boolean;
}

/**
 * Decide whether an artifact revision's downstream EFFECT is held. Pure — the
 * store resolves the facts (produced-event row + linked gate status).
 *
 *   - No event, or a NON-external (`none`) destination → nothing to hold; the
 *     effect flows immediately (the "ungated artifact's effects flow" invariant).
 *   - An external-effect revision whose CHECKPOINTED park was TTL-fail-closed into
 *     `policy_unresolved` → HELD *terminally* (cinatra#2047 D-7). This outranks
 *     every gate state: the always-resume path released the RUN, but the protected
 *     EFFECT stays blocked until an explicit later policy decision (S0's
 *     continuation contract). Without this the always-resume path would publish an
 *     artifact whose policy was never resolved.
 *   - An external-effect event still `pending` (not yet orchestrated) → HELD,
 *     fail-closed: the effect must not race ahead of the review decision that the
 *     consumer has not yet made.
 *   - An orchestrated external event with NO linked gate → the lattice left it
 *     ungated (only an org `forbidden` bound skips an external review), so the
 *     org explicitly permitted the effect → NOT held.
 *   - An orchestrated external event WITH a gate → HELD while the gate is
 *     `pending`; released once it resolves.
 */
export function evaluateEffectHold(facts: EffectHoldFacts): EffectHoldVerdict {
  const { event, gateStatus } = facts;
  if (!event) return { held: false, reason: "no produced event for this revision — ungated" };
  if (!isExternalEffectClass(event.destinationClass)) {
    return { held: false, reason: "no external effect to hold (destination 'none')" };
  }
  // D-7 (cinatra#2047): a TTL-fail-closed park's terminal `policy_unresolved`
  // block lands HERE, on the effect — checked BEFORE any gate state, because the
  // block survives a resolved gate (the park expired precisely because no decision
  // ever resolved the policy). Released only by an explicit later policy decision.
  if (facts.policyUnresolvedPark === true) {
    return {
      held: true,
      policyUnresolved: true,
      reason:
        "external effect terminally blocked — a checkpointed park TTL-expired with the policy unresolved (policy_unresolved)",
    };
  }
  if (event.status === "pending") {
    return { held: true, reason: "external effect awaiting review orchestration — fail-closed" };
  }
  if (!event.continuationAddress) {
    return { held: false, reason: "review not gated by policy (org-forbidden) — effect permitted" };
  }
  if (gateStatus === "pending") {
    return { held: true, reason: "external effect held by a pending review gate" };
  }
  // S2 (cinatra#2040): a gate resolved as `changes_requested` has NOT released —
  // the repair is in flight. The effect stays HELD until the store re-points the
  // event to the successor gate (which then holds it while pending, releases on
  // its approval). Fail-closed: without this, `changes_requested` would look like
  // any resolved gate and release the external effect on an unrepaired artifact.
  if (gateStatus === "resolved" && facts.gateDisposition === "changes_requested") {
    return { held: true, reason: "external effect held pending repair (changes_requested)" };
  }
  return { held: false, reason: "review gate resolved — effect released" };
}
