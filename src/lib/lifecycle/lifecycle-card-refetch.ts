import "server-only";

// ---------------------------------------------------------------------------
// The AUTHORITATIVE REFETCH contract for lifecycle cards (cinatra#2565,
// epic #2564 S1). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit §IV.
//
// A lifecycle DATA_PART carries an opaque ref and nothing else, so EVERY fact a
// card shows has to come from here: given a ref and the reader, resolve the
// state the card may draw right now. That is what makes a persisted transcript
// safe to keep — the bytes in the thread say nothing, and a reader who lost
// access between the turn and the reload sees the card disappear rather than a
// stale snapshot of what they used to be allowed to see.
//
// THE REF IS NOT A CAPABILITY. It addresses a row; it grants nothing. Every
// resolve re-runs the reader's access from scratch, so forging a ref buys an
// attacker exactly one thing: an `absent`.
//
// ABSENT SWALLOWS EVERYTHING (the generic-refusal contract). No access, no such
// row, a ref that does not decode, a store that threw — all answer `absent`.
// The card then draws no DOM at all (§IV), so the surface cannot be used to
// probe which runs, gates or records exist.
//
// ORDER IS LOAD-BEARING, and it mirrors `loadReviewGateSurface`: run READ
// access first (a reader with none never learns whether the gate exists), then
// the gate's own state, then the decision axis. Reversing the first two would
// leak gate existence to anyone holding a ref.
// ---------------------------------------------------------------------------

import {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  type LifecycleGateRefPayload,
} from "@/lib/lifecycle/lifecycle-card-ref";
import {
  enforceReviewRunAccess,
  readReviewGate,
  readReviewGateState,
} from "@cinatra-ai/agents/artifact-review-gate-store";
// The READ leaf, not the verification write store (cinatra#2567): this resolver
// only asks whether a reading exists, and reaching it through the write store
// dragged the whole verification lane onto every graph the MCP surface carries.
import { readVerificationRecordForGate } from "@cinatra-ai/agents/lifecycle-verification-read-store";
import type {
  LifecycleCardState,
  LifecycleDataPartViewType,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** The generic "nothing to draw" answer. Every denial path lands here. */
const ABSENT: LifecycleCardState = { state: "absent" };

/**
 * The reason a reader sees on a `restricted` card. It describes the READER's
 * standing on the run and names nothing about the item — no gate id, no policy
 * id, no counts. §IV requires the reason on screen; the refusal contract
 * requires it to be non-enumerating, and a fixed sentence satisfies both.
 */
export const LIFECYCLE_RESTRICTED_REASON =
  "Approving or rejecting needs approve access on this run.";

// ---------------------------------------------------------------------------
// The ref codec now lives in `@/lib/lifecycle/lifecycle-card-ref` (cinatra#2566)
// so the gate-emission path can MINT a ref without importing this resolver's
// store graph. Re-exported here unchanged: S1's import surface is preserved and
// there is still exactly ONE codec.
// ---------------------------------------------------------------------------

export {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
  type LifecycleGateRefPayload,
};

// ---------------------------------------------------------------------------
// The per-kind resolvers
// ---------------------------------------------------------------------------

async function resolveReviewGate(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<LifecycleCardState> {
  const { runId, reviewTaskId } = payload;
  // 1. Run READ access — before anything reveals that the gate exists.
  const read = await enforceReviewRunAccess(
    runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  );
  if (!read.ok) return ABSENT;

  // 2. The gate's own state.
  //    - `resolved`    → "no longer open" (§IV `settled`): it WAS this reader's
  //                      gate and it has been decided, so the card says so and
  //                      offers a refresh instead of letting a stale decision
  //                      through.
  //    - `unavailable` → `absent`. This covers a gate that never existed and a
  //                      row too corrupt to read, so drawing "no longer open"
  //                      here would let a replayed or garbage ref produce card
  //                      DOM for nothing at all. Nothing to draw means draw
  //                      nothing.
  const gate = await readReviewGateState(runId, reviewTaskId);
  if (gate.status === "unavailable") return ABSENT;
  if (gate.status !== "pending") return { state: "settled" };

  // 3. The decision axis (§IV `restricted`): a terminal decision needs approve
  //    access; commenting needs respond access. Resolved against the ACTUAL
  //    reader, never a role guess.
  const [decide, comment] = await Promise.all([
    enforceReviewRunAccess(runId, actorCtx.actor, "approveHitl", actorCtx.roleHints),
    enforceReviewRunAccess(runId, actorCtx.actor, "respondToHitl", actorCtx.roleHints),
  ]);
  if (!decide.ok) {
    return {
      state: "restricted",
      canDecide: false,
      canComment: comment.ok,
      reason: LIFECYCLE_RESTRICTED_REASON,
    };
  }
  return { state: "pending", canDecide: true, canComment: comment.ok };
}

async function resolveVerificationSummary(
  payload: LifecycleGateRefPayload,
  actorCtx: ReviewActorContext,
): Promise<LifecycleCardState> {
  const { runId, reviewTaskId } = payload;
  const read = await enforceReviewRunAccess(
    runId,
    actorCtx.actor,
    "read",
    actorCtx.roleHints,
  );
  if (!read.ok) return ABSENT;
  // The record hangs off the gate ROW id, so the gate is resolved first. A
  // missing gate or missing record is `absent` — there is no reading to show.
  const gate = await readReviewGate(runId, reviewTaskId);
  if (!gate) return ABSENT;
  const record = await readVerificationRecordForGate(gate.id);
  if (!record) return ABSENT;
  // §VII: the verification card "carries no floor at all — it asks nothing, so
  // it draws nothing to press".
  return { state: "advisory" };
}

/**
 * The trigger schedule proposal (§VI) has a Confirm/Adjust floor whose
 * single-use proposal token, store and arm-before-expose sequence are S5's
 * (#2569). Until that producer exists there is no row to authorize against, and
 * the honest answer is `absent` — a placeholder that rendered a floor with no
 * proposal behind it would be exactly the "AI arms a schedule" failure the epic
 * forbids. S5 replaces this body; the wire type, the registry entry and this
 * dispatch arm are already in place so it fills a seam rather than adding one.
 */
async function resolveTriggerScheduleProposal(): Promise<LifecycleCardState> {
  return ABSENT;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Resolve one lifecycle card's authoritative state. NEVER throws and never
 * distinguishes a denial from an absence: a store failure, a malformed ref and
 * a forbidden row all answer `absent`.
 */
export async function resolveLifecycleCardState(params: {
  viewType: LifecycleDataPartViewType;
  ref: string;
  actorCtx: ReviewActorContext;
}): Promise<LifecycleCardState> {
  const { viewType, ref, actorCtx } = params;
  try {
    switch (viewType) {
      case "artifact_review_gate": {
        const payload = decodeLifecycleGateRef(ref);
        return payload ? await resolveReviewGate(payload, actorCtx) : ABSENT;
      }
      case "verification_summary": {
        const payload = decodeLifecycleGateRef(ref);
        return payload ? await resolveVerificationSummary(payload, actorCtx) : ABSENT;
      }
      case "trigger_schedule_proposal":
        return await resolveTriggerScheduleProposal();
    }
  } catch {
    // A store/transport failure must not become an existence signal either.
    return ABSENT;
  }
}
