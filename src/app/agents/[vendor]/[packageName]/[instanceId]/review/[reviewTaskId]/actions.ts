import "server-only";

import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
  type SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import {
  floorActionDisposition,
  floorActionRunAccessOp,
  resolveReviewFloorSubmission,
  REGENERATE_MULTI_TARGET_REASON,
  REGENERATE_NEEDS_A_NOTE,
  REGENERATE_NOT_ON_THIS_REVIEW,
  type ReviewFloorSubmission,
} from "@/lib/artifacts/review-surface-model";
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
 * THE FLOOR'S ONE ENTRY (cinatra#3080, epic #3023). Comment · Regenerate ·
 * Continue all arrive here, and each takes exactly one road:
 *
 *   Comment    — a non-terminal annotation through the #1807 decision core. It
 *                records the note AND CHANGES NOTHING ELSE: the gate stays
 *                pending, the run stays parked, the frozen revision is
 *                unchanged, and no successor gate is opened.
 *   Regenerate — the change road's CANONICAL `changes_requested` operation (the
 *                same one the typed changes-requested road calls; never a
 *                parallel endpoint), targeting the step that produced the
 *                reviewed revision. It settles the gate as superseded and opens
 *                exactly one successor, so it needs the right a TERMINAL
 *                decision needs.
 *   Continue   — the former Approve, byte for byte: the same `approve`
 *                disposition, the same fingerprint identity, no migration.
 *
 * WHAT WAS REMOVED HERE. Until this slice, a NON-EMPTY COMMENT on a single-target
 * lifecycle gate was routed into `changes_requested` — the gate closed and a
 * repair opened, from the affordance that decides nothing. That overload is gone:
 * the canonical operation now has exactly one caller (the Regenerate branch
 * below), which is what makes item 3's "changes nothing else" a property of the
 * code rather than of the copy.
 *
 * REJECT IS RETIRED. A submission naming it is refused here with the platform's
 * one stated reason, before any access check or gate read — and refused again by
 * the decision core itself, so neither this action nor any other caller can
 * produce one.
 *
 * The LIVE decision-submit binder (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f
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
  /**
   * WHAT THE FLOOR ASKED FOR — one of `comment` / `regenerate` / `continue`,
   * plus the two words already-shipped clients still speak: `approve` (the
   * compatibility alias of Continue) and `reject` (refused, with the reason).
   */
  submission: ReviewFloorSubmission,
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
   * FOR A PICTURE, THE EDITED PROMPT (cinatra#3080 acceptance item 5) — its own
   * value, never folded into the note. The review screen shows it as its own
   * pre-filled field beside the note; Regenerate carries the two separately so
   * the producing step is told what to make again AND what to change about how
   * it was asked. Every other action ignores it, and the DISPLAY is never given
   * it at all.
   */
  regeneratePrompt?: string | null,
): Promise<ReviewSubmitOutcome> {
  // WHAT WAS ASKED FOR, RESOLVED FIRST. A retired word is answered before an
  // actor is resolved, an access check runs or a gate is read: the refusal is a
  // statement about the product, not about this run, so it must not depend on
  // (or disclose) anything about the run.
  const resolved = resolveReviewFloorSubmission(submission);
  if (resolved.kind === "retired") {
    return { kind: "error", message: resolved.reason };
  }
  const action = resolved.action;

  const actorCtx = resolvedActorCtx ?? (await resolveReviewActorContext());
  if (!actorCtx) {
    return {
      kind: "not-permitted",
      message: "Sign in to the run's organization to decide this review.",
    };
  }

  // A REGENERATE WITH NOTHING TO CARRY IS REFUSED BEFORE ANYTHING ELSE. The note
  // IS the thing that goes back to the producing step, so an empty one is a
  // shape error, not a decision — refused with the reason, and no store is
  // touched (acceptance item 4).
  const note = comment?.trim() ?? "";
  if (action === "regenerate" && note.length === 0) {
    return { kind: "error", message: REGENERATE_NEEDS_A_NOTE };
  }

  // Run access for the FLOOR ACTION first (Continue and Regenerate both settle
  // the gate → approveHitl; Comment annotates → respondToHitl) — before any gate
  // read, so gate existence/state is never side-channeled to an unauthorized
  // caller. Regenerate sitting on the TERMINAL right is acceptance item 4's
  // "Regenerate needs the same right a terminal decision needs": it settles the
  // gate as superseded, so a reader who may respond but not decide cannot press it.
  const op = floorActionRunAccessOp(action);
  const access = await enforceReviewDecisionAccess({ runId, op, actorCtx });
  if (!access.ok) {
    return {
      kind: "not-permitted",
      message:
        "You do not have the run access this decision needs — Continue and Regenerate require the run's decision access, a comment requires respond access.",
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
  // on this surface (acceptance item 4). It settles the earlier gate as
  // superseded in the change road's existing representation and opens exactly one
  // successor gate on the next revision; the store keys its idempotency on the
  // gate plus the exact words, so a double press re-derives the same repair
  // rather than opening a second one, and a Continue that lands after it (or the
  // reverse) loses the gate CAS and is surfaced as a BLOCK — the first decision
  // stands.
  if (action === "regenerate") {
    // A review the lifecycle road never opened — a batch gate, or a plain review
    // task — has no producing step to send the words back to. Named, not silently
    // degraded to a comment.
    if (
      !isLifecycleReviewOrchestrationActive() ||
      !isAutoReviewTaskId(reviewTaskId) ||
      isBatchAutoReviewTaskId(reviewTaskId)
    ) {
      return { kind: "error", message: REGENERATE_NOT_ON_THIS_REVIEW };
    }
    // A gate that still pins MORE THAN ONE target (a legacy row from before
    // one-review-per-artifact) cannot say which piece of work to make again.
    // Refused WITH THE REASON — and Comment and Continue below still work on it.
    if (pinnedTargets.length !== 1) {
      return { kind: "error", message: REGENERATE_MULTI_TARGET_REASON };
    }
    const result = await submitReviewSurfaceChangesRequested({
      runId,
      reviewTaskId,
      baseTarget: pinnedTargets[0],
      feedback: note,
      // THE PICTURE'S PROMPT, SEPARATELY (item 5). Passed as its own value all
      // the way to the change road, which records it as its own finding — the
      // note says what to change, the prompt says what to make.
      prompt: regeneratePrompt?.trim() ? regeneratePrompt.trim() : null,
      actorCtx,
    });
    return mapChangesRequestedToOutcome(result);
  }

  // COMMENT and CONTINUE — the #1807 decision core, unchanged. `continue` carries
  // the stored `approve` (no migration); `comment` stays the non-terminal
  // annotation it has always been, and — since this slice — nothing else.
  const disposition = floorActionDisposition(action);
  if (!disposition) {
    // Unreachable: `regenerate` is the only action with no disposition and it
    // returned above. Fail closed rather than submit a decision with no verb.
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
