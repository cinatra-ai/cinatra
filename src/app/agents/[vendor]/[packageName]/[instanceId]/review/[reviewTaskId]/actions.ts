import "server-only";

import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
  type ReviewDisposition,
  type ReviewRunAccessOp,
  type SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import {
  submitReviewDecision,
  readReviewGatePinnedTargets,
  enforceReviewDecisionAccess,
  submitReviewSurfaceChangesRequested,
  type ReviewActorContext,
} from "@/app/artifacts/[id]/review-gate-ports";
import {
  mapSubmitResultToOutcome,
  mapChangesRequestedToOutcome,
  type ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";
import { isLifecycleReviewOrchestrationActive } from "@/lib/lifecycle/lifecycle-activation";
import { isAutoReviewTaskId, isBatchAutoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

import { resolveReviewActorContext } from "./review-actor";

/**
 * The LIVE decision-submit binder (cinatra#1795 S12 item 4; spec design@0c484154b069c6369a33c1375056126289888997
 * §IV/§V). The client sends only the disposition + rationale (display + DECIDE
 * only); the server re-resolves the reviewing actor, assembles the WHOLE-gate
 * decision the #1807 core requires for a terminal disposition (every pinned
 * target, read from the frozen gate — never a client-supplied set), and drives
 * `submitReviewDecision` → the #1796 store's atomic commit. The core re-validates
 * (run access + pinned-set membership + revision membership + gate CAS) and is
 * fail-closed on a fingerprint conflict; the typed result is mapped to the
 * surface's visible outcome (a conflict is a BLOCK, never a silent success).
 *
 * NOT a standalone Server Action: this is a plain server helper invoked ONLY by
 * the page's route-bound `"use server"` wrapper, which closes over `runId` /
 * `reviewTaskId` from the route params. There is deliberately no directly-callable
 * endpoint that accepts a client-supplied gate id — a client cannot retarget
 * another gate.
 *
 * ORDER is security-load-bearing: run access for the decision op is enforced
 * BEFORE the gate is read, so an unauthorized caller gets a uniform `not-permitted`
 * regardless of gate state (no pending-gate existence oracle).
 */
export async function submitReviewDecisionAction(
  runId: string,
  reviewTaskId: string,
  disposition: ReviewDisposition,
  comment: string | null,
  /**
   * The ALREADY-RESOLVED reviewing context (cinatra#2566, epic #2564 S2).
   *
   * A caller that has itself resolved the actor — the gate-scoped decision entry,
   * which must enforce run READ before this helper's decision-op check — passes
   * it in so BOTH checks run against ONE context. Resolving twice re-reads the
   * role/team/project hints, and two authorization decisions taken against two
   * reads of the same actor is a seam nothing should have to reason about.
   * Omitted by the review page's route-bound action, which resolves here exactly
   * as it always has.
   */
  resolvedActorCtx?: ReviewActorContext,
  /**
   * The reviewer's per-item SUGGESTION choices (cinatra#2571, epic #2564 S6b).
   *
   * Passed through untouched to the #1807 core, which normalizes it, refuses it
   * on a non-terminal decision, validates it `⊆` the gate's pinned snapshot
   * BEFORE the CAS, folds it into the decision fingerprint, and commits the
   * ledger + application intent inside the CAS transaction. Deliberately the LAST
   * parameter: this helper is the ONE decision entry, and adding the partition
   * here rather than minting a per-item action is what keeps it that way (#2047
   * row 8). Omitted by every caller that surfaces no suggestions.
   */
  suggestionDecisions?: SuggestionDecisionPartition | null,
): Promise<ReviewSubmitOutcome> {
  const actorCtx = resolvedActorCtx ?? (await resolveReviewActorContext());
  if (!actorCtx) {
    return {
      kind: "not-permitted",
      message: "Sign in to the run's organization to decide this review.",
    };
  }

  // Run access for the decision op FIRST (approve/reject → approveHitl; comment →
  // respondToHitl) — before any gate read, so gate existence/state is never
  // side-channeled to an unauthorized caller.
  const op: ReviewRunAccessOp = disposition === "comment" ? "respondToHitl" : "approveHitl";
  const access = await enforceReviewDecisionAccess({ runId, op, actorCtx });
  if (!access.ok) {
    return {
      kind: "not-permitted",
      message:
        "You do not have the run access this decision needs — a terminal decision requires approve access, a comment requires respond access.",
    };
  }

  // A suggestion partition is TERMINAL-ONLY (cinatra#2571). The #1807 core refuses
  // it on a comment, but the `changes_requested` branch below short-circuits
  // BEFORE the core — so without this guard a partition sent with a comment on a
  // lifecycle gate would be silently dropped rather than refused. No entry to this
  // helper may swallow per-item choices.
  const carriesSuggestions =
    !!suggestionDecisions &&
    (suggestionDecisions.accepted.length > 0 || suggestionDecisions.dismissed.length > 0);
  if (carriesSuggestions && disposition === "comment") {
    return {
      kind: "error",
      message: "Suggestion decisions require a terminal disposition (approve or reject).",
    };
  }

  // The whole gate under one decision (§IV all-or-nothing): read the frozen
  // pinned set and review every target. A non-pending / absent gate has no set —
  // the gate changed under the reviewer, surfaced as a block (never a slip).
  const pinnedTargets = await readReviewGatePinnedTargets(runId, reviewTaskId);
  if (!pinnedTargets) {
    return { kind: "blocked", reason: "no-longer-pending" };
  }

  // LIFECYCLE prompt-window path (cinatra#2063; owner ruling 2026-07-25). When the
  // review-orchestration fence is ON and this is a single-target LIFECYCLE review
  // gate, typed prompt-window feedback (the Comment path) is a `changes_requested`
  // decision: it CLOSES the base gate and OPENS a repair through the S2 store entry
  // point (no parallel write path). The authorization is UNCHANGED — the
  // `respondToHitl` check above already ran for the comment op. With the fence off,
  // on a non-lifecycle / batch / multi-target gate, or with empty feedback, the
  // Comment path falls through to the byte-identical annotation below.
  const trimmedComment = comment?.trim() ?? "";
  if (
    disposition === "comment" &&
    trimmedComment.length > 0 &&
    isLifecycleReviewOrchestrationActive() &&
    isAutoReviewTaskId(reviewTaskId) &&
    !isBatchAutoReviewTaskId(reviewTaskId) &&
    pinnedTargets.length === 1
  ) {
    const result = await submitReviewSurfaceChangesRequested({
      runId,
      reviewTaskId,
      baseTarget: pinnedTargets[0],
      feedback: trimmedComment,
      actorCtx,
    });
    return mapChangesRequestedToOutcome(result);
  }

  const decision: ArtifactReviewDecision = {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId,
    reviewTaskId,
    disposition,
    comment,
    reviewedTargets: pinnedTargets,
    suggestionDecisions: suggestionDecisions ?? null,
  };

  const result = await submitReviewDecision({ decision, actorCtx });
  return mapSubmitResultToOutcome(result, disposition);
}
