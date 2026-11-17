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
 *
 * THE FLOOR (cinatra#3080): the caller submits a floor action — Comment,
 * Regenerate or Continue (`approve` is Continue's compatibility alias, `reject`
 * is refused with the platform's sentence). The Note-field Comment ALWAYS
 * reaches the decision core as an annotation and decides nothing; Regenerate
 * takes the change road on its own origin; Continue stores `approve` as before.
 *
 * THE CONVERSATION'S COMMENT (`conversation-comment`) is its own submission, a
 * Comment from the review's conversation, the card's composer. It keeps the
 * road it had before the floor (cinatra#2063; #4339):
 * on a single-target lifecycle gate, or on a later leg of a declared review, its
 * words file `changes_requested` on the change road's TYPED origin; everywhere
 * else it is the same annotation as the Note-field Comment.
 */
export async function submitReviewDecisionAction(
  runId: string,
  reviewTaskId: string,
  /**
   * WHAT THE FLOOR ASKED FOR — `comment` / `regenerate` / `continue`, the
   * conversation's `conversation-comment`, plus the two words already-shipped
   * clients still speak: `approve` (the compatibility alias of Continue) and
   * `reject` (refused, with the reason).
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
   * action ignores it. Deliberately after every older parameter; only the
   * comment road's `options` (cinatra#4245) follows it.
   */
  regeneratePrompt?: string | null,
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
  // WHAT WAS ASKED FOR, RESOLVED FIRST. A retired word is answered before an
  // actor is resolved, an access check runs or a gate is read: the refusal is a
  // statement about the product, not about this run.
  const resolved = resolveReviewFloorSubmission(requestedDisposition);
  if (resolved.kind === "retired") {
    return { kind: "error", message: resolved.reason };
  }
  const action = resolved.action;
  const conversationComment = resolved.conversation;

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
  // the gate → approveHitl; Comment → respondToHitl, the conversation's comment
  // included, whose change road keeps the right it had before the floor) —
  // before any gate read, so gate existence/state is never side-channeled to an
  // unauthorized caller.
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
  // partition sent with a Regenerate or the conversation's comment would be
  // silently dropped rather than refused. The rule is about the field being
  // SUPPLIED, not about how many ids it lists: an empty partition outside
  // Continue is refused too (cinatra#3080), never normalized away. Absent
  // (`null` / `undefined`) is the only "no partition".
  const suppliesSuggestions = suggestionDecisions !== null && suggestionDecisions !== undefined;
  if (suppliesSuggestions && action !== "continue") {
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

  // REGENERATE — the change road's canonical operation on its `regenerate`
  // origin: it settles the earlier gate as superseded and opens exactly one
  // successor gate on the next revision. The Note-field Comment never takes this
  // road; the conversation's comment takes it on the typed origin, below.
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

  // THE PROMPT WINDOW'S TYPED CHANGE REQUEST on the step's OWN declared gate
  // (cinatra#4245 D2, design section VI). A DECLARED review gate (a `wayflow-`
  // task id, a step the flow declares in its own template) with no `#n` leg
  // suffix: its change request ENDS the run's pause, and the repair drain stops
  // the run before the repair run starts. Only the prompt window's typed change
  // request takes it (the lent Comment, `options.typedChangeRequest`, which no
  // client can set); the Note-field Comment and the conversation's comment stay
  // the non-terminal note there. That change request is terminal for the run,
  // so it also needs the access a terminal decision needs (`approveHitl`); a
  // reviewer who may only respond keeps the plain annotation. This action does
  // not read the gate's pin or event; the store decides. Only its not-eligible
  // refusal falls back to the plain annotation below; every other answer, a
  // pause refusal included, is mapped to its own outcome.
  if (action === "comment" && !conversationComment && options?.typedChangeRequest === true) {
    const endsPause =
      isDeclaredReviewTaskId(reviewTaskId) && baseReviewTaskId(reviewTaskId) === reviewTaskId;
    if (
      endsPause &&
      note.length > 0 &&
      isLifecycleReviewOrchestrationActive() &&
      pinnedTargets.length === 1 &&
      (await enforceReviewDecisionAccess({ runId, op: "approveHitl", actorCtx })).ok
    ) {
      const result = await submitReviewSurfaceChangesRequested({
        runId,
        reviewTaskId,
        baseTarget: pinnedTargets[0],
        feedback: note,
        // Named, never defaulted: an omitted origin is the floor's Regenerate.
        origin: "typed",
        actorCtx,
      });
      if (!declaredCommentStaysANote(result)) {
        return mapChangesRequestedToOutcome(result);
      }
    }
  }

  // THE CONVERSATION'S COMMENT keeps the LIFECYCLE prompt-window road
  // (cinatra#2063; #4339; its own submission since cinatra#3080). When
  // the review-orchestration fence is ON and this is a single-target LIFECYCLE
  // review gate, the typed words are a `changes_requested` decision on the
  // change road's TYPED origin: it CLOSES the base gate and OPENS a repair (a
  // producer that cannot repair escalates to a person, as before). The
  // authorization is UNCHANGED — the `respondToHitl` check above already ran
  // for the comment op. With the fence off, on a non-lifecycle / batch /
  // multi-target gate, or with no words, it falls through to the annotation.
  //
  // The PICTURE's leg of a per-artifact DECLARED review (cinatra#3035 W11,
  // #4339) takes the same road: a produced revision a declared gate pins opens
  // no automatic gate (cinatra#4225), so that leg is the picture's only review
  // until it is made again. The post's own leg (the step's own task id) keeps
  // the plain annotation. This action does not read the gate's pin; the store
  // reads the family witness on it, and a flow-authored gate it refuses as no
  // lifecycle gate keeps the plain annotation.
  if (conversationComment) {
    const declaredGate =
      isDeclaredReviewTaskId(reviewTaskId) && baseReviewTaskId(reviewTaskId) !== reviewTaskId;
    if (
      note.length > 0 &&
      isLifecycleReviewOrchestrationActive() &&
      ((isAutoReviewTaskId(reviewTaskId) && !isBatchAutoReviewTaskId(reviewTaskId)) || declaredGate) &&
      pinnedTargets.length === 1
    ) {
      const result = await submitReviewSurfaceChangesRequested({
        runId,
        reviewTaskId,
        baseTarget: pinnedTargets[0],
        feedback: note,
        origin: "typed",
        actorCtx,
      });
      if (!(declaredGate && declaredCommentStaysANote(result))) {
        return mapChangesRequestedToOutcome(result);
      }
    }
  }

  // COMMENT and CONTINUE — the #1807 decision core. `continue` carries the stored
  // `approve` (no migration); `comment` is the non-terminal annotation (the
  // Note-field Comment always, the conversation's comment off its road).
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
