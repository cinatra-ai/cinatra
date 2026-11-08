import "server-only";

import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
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
  resolveReviewFloorSubmission,
  floorActionDisposition,
  floorActionRunAccessOp,
  REGENERATE_NEEDS_A_NOTE,
  REGENERATE_MULTI_TARGET_REASON,
  REGENERATE_NOT_ON_THIS_REVIEW,
  type ReviewFloorSubmission,
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
 *
 * THE FLOOR (cinatra#3080): the caller submits a floor action — Comment,
 * Regenerate or Continue (`approve` is Continue's compatibility alias, `reject`
 * is refused with the platform's sentence). Comment ALWAYS reaches the decision
 * core as an annotation and decides nothing; Regenerate alone takes the change
 * road; Continue stores `approve` as before.
 */
export async function submitReviewDecisionAction(
  runId: string,
  reviewTaskId: string,
  /**
   * WHAT THE FLOOR ASKED FOR — `comment` / `regenerate` / `continue`, plus the
   * two words already-shipped clients still speak: `approve` (the compatibility
   * alias of Continue) and `reject` (refused, with the reason).
   */
  requestedDisposition: ReviewFloorSubmission,
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
   * The recorded prompt a Regenerate sends back with the note (cinatra#3080 item
   * 5): the words in the Note when the review opened carrying the work's
   * recorded prompt. Passed to the change road as its own value; every other
   * action ignores it. Deliberately the LAST parameter.
   */
  regeneratePrompt?: string | null,
): Promise<ReviewSubmitOutcome> {
  // WHAT WAS ASKED FOR, RESOLVED FIRST. A retired word is answered before an
  // actor is resolved, an access check runs or a gate is read: the refusal is a
  // statement about the product, not about this run.
  const resolved = resolveReviewFloorSubmission(requestedDisposition);
  if (resolved.kind === "retired") {
    return { kind: "error", message: resolved.reason };
  }
  const action = resolved.action;

  // A REGENERATE WITH NOTHING TO CARRY IS REFUSED BEFORE ANY READ: the note IS
  // what goes back to the producing step, so an empty one is a shape error.
  const note = comment?.trim() ?? "";
  if (action === "regenerate" && note.length === 0) {
    return { kind: "error", message: REGENERATE_NEEDS_A_NOTE };
  }

  const actorCtx = resolvedActorCtx ?? (await resolveReviewActorContext());
  if (!actorCtx) {
    return {
      kind: "not-permitted",
      message: "Sign in to the run's organization to decide this review.",
    };
  }

  // Run access for the FLOOR ACTION first (Continue and Regenerate both settle
  // the gate → approveHitl; Comment annotates → respondToHitl) — before any gate
  // read, so gate existence/state is never side-channeled to an unauthorized
  // caller.
  const op = floorActionRunAccessOp(action);
  const access = await enforceReviewDecisionAccess({ runId, op, actorCtx });
  if (!access.ok) {
    return {
      kind: "not-permitted",
      message:
        "You do not have the run access this decision needs — a terminal decision requires the run's decision access, a comment requires respond access.",
    };
  }

  // A suggestion partition is TERMINAL-ONLY (cinatra#2571): it rides Continue.
  // The change road below short-circuits BEFORE the core, so without this guard a
  // partition sent with a Regenerate would be silently dropped rather than refused.
  const carriesSuggestions =
    !!suggestionDecisions &&
    (suggestionDecisions.accepted.length > 0 || suggestionDecisions.dismissed.length > 0);
  if (carriesSuggestions && action !== "continue") {
    return {
      kind: "error",
      message: "Suggestion decisions require a Continue — the decision they ride on.",
    };
  }

  // The whole gate under one decision (§IV all-or-nothing): read the frozen
  // pinned set and review every target. A non-pending / absent gate has no set —
  // the gate changed under the reviewer, surfaced as a block (never a slip).
  const pinnedTargets = await readReviewGatePinnedTargets(runId, reviewTaskId);
  if (!pinnedTargets) {
    return { kind: "blocked", reason: "no-longer-pending" };
  }

  // REGENERATE — the change road's canonical operation, and the ONLY caller of it
  // on this surface: it settles the earlier gate as superseded and opens exactly
  // one successor gate on the next revision. Comment never takes this road.
  if (action === "regenerate") {
    if (
      !isLifecycleReviewOrchestrationActive() ||
      !isAutoReviewTaskId(reviewTaskId) ||
      isBatchAutoReviewTaskId(reviewTaskId)
    ) {
      return { kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW };
    }
    // A legacy gate that pins more than one target cannot say which piece of
    // work to make again; Comment and Continue still work on it.
    if (pinnedTargets.length !== 1) {
      return { kind: "error", message: REGENERATE_MULTI_TARGET_REASON };
    }
    const result = await submitReviewSurfaceChangesRequested({
      runId,
      reviewTaskId,
      baseTarget: pinnedTargets[0],
      feedback: note,
      prompt: regeneratePrompt?.trim() ? regeneratePrompt.trim() : null,
      actorCtx,
    });
    return mapChangesRequestedToOutcome(result);
  }

  // COMMENT and CONTINUE — the #1807 decision core. `continue` carries the stored
  // `approve` (no migration); `comment` is the non-terminal annotation, always.
  const disposition = floorActionDisposition(action);
  if (!disposition) {
    // Unreachable: `regenerate` is the only action without a disposition.
    return { kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW };
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
