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
  declaredCommentStaysANote,
  type ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";
import { isLifecycleReviewOrchestrationActive } from "@/lib/lifecycle/lifecycle-activation";
import { isAutoReviewTaskId, isBatchAutoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { baseReviewTaskId, isDeclaredReviewTaskId } from "@/lib/artifacts/artifact-review-target";

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
  requestedDisposition: ReviewDisposition | "continue",
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
  /**
   * WHICH ROAD a comment came by (cinatra#4245 D2, design section VI).
   *
   * `typedChangeRequest` is set ONLY by the run assistant's lent Comment
   * (`src/lib/lifecycle/lent-action-mcp.ts`), which files the person's own words
   * typed into the gate's prompt window (inside a conversation, the composer that
   * stands in for it): section VI's one channel for requesting changes. The
   * decision bar's Comment button (the page's bound action and the
   * gate-scoped decide route) never passes it, so a client cannot set it. It
   * matters only on the step's OWN declared gate, where a change request ends
   * the run's pause: there the button's Comment stays the non-terminal note
   * ("leaves the gate pending - nothing resumes, and the run stays paused").
   */
  options?: { readonly typedChangeRequest?: boolean },
): Promise<ReviewSubmitOutcome> {
  // Continue is transport compatibility, never a new persisted disposition.
  const disposition: ReviewDisposition = requestedDisposition === "continue"
    ? "approve"
    : requestedDisposition;
  const actorCtx = resolvedActorCtx ?? (await resolveReviewActorContext());
  if (!actorCtx) {
    return {
      kind: "not-permitted",
      message: "Sign in to the run's organization to decide this review.",
    };
  }

  if (disposition === "reject") {
    return { kind: "error", message: "There is no Reject decision. Leave the review open, Comment, or Continue." };
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
  //
  // A DECLARED review gate (a `wayflow-` task id, a step the flow declares in its
  // own template) takes the same road:
  //   - the PICTURE's leg of a per-artifact review (`#n`, cinatra#3035 W11): a
  //     produced revision a declared gate pins opens no automatic gate
  //     (cinatra#4225), so that leg is the picture's only review; its change
  //     request keeps the run paused (cinatra#4312);
  //   - the step's OWN gate (no `#n`, cinatra#4245): its change request ends the
  //     run's pause, and the repair drain stops the run before the repair run
  //     starts. Only the prompt window's typed change request takes it (the lent
  //     Comment, `options.typedChangeRequest`); the decision bar's Comment button
  //     stays the non-terminal note of design section VI. That change request is
  //     terminal for the run, so it also needs the access a terminal decision
  //     needs (`approveHitl`); a reviewer who may only respond keeps the plain
  //     annotation.
  // This action does not read the gate's pin or event; the store decides. Only its
  // not-eligible refusal (and a `#n` gate it reads as no lifecycle gate) falls back
  // to the plain annotation below; every other answer, a pause refusal included,
  // is mapped to its own outcome.
  const trimmedComment = comment?.trim() ?? "";
  const declaredGate = isDeclaredReviewTaskId(reviewTaskId);
  const endsPause = declaredGate && baseReviewTaskId(reviewTaskId) === reviewTaskId;
  if (
    disposition === "comment" &&
    trimmedComment.length > 0 &&
    isLifecycleReviewOrchestrationActive() &&
    ((isAutoReviewTaskId(reviewTaskId) && !isBatchAutoReviewTaskId(reviewTaskId)) || declaredGate) &&
    pinnedTargets.length === 1 &&
    (!endsPause ||
      (options?.typedChangeRequest === true &&
        (await enforceReviewDecisionAccess({ runId, op: "approveHitl", actorCtx })).ok))
  ) {
    const result = await submitReviewSurfaceChangesRequested({
      runId,
      reviewTaskId,
      baseTarget: pinnedTargets[0],
      feedback: trimmedComment,
      actorCtx,
    });
    if (!(declaredGate && declaredCommentStaysANote(result))) {
      return mapChangesRequestedToOutcome(result);
    }
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
