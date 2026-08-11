import "server-only";

// ---------------------------------------------------------------------------
// The trigger schedule proposal CARD resolver (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// S1 fixed the rule the whole epic travels on: the wire payload is a ref, never
// content, so every fact a card shows is resolved here, server-side, against
// the reader, on mount and focus and reload. This module is that resolution for
// §VI's card — it answers with S1's STATE (the ladder every lifecycle card
// shares) and, when there is something to draw, the typed BODY §VI specifies.
//
// TWO ANSWERS, ONE RESOLVE. Splitting state from body is not decoration: the
// state ladder is the epic's contract and must stay identical across the four
// interaction kinds, while the drawn body is per-kind and belongs to the
// section that specifies it. Resolving them together means a card can never
// show a `pending` floor over a `settled` body.
//
// THE REF IS THE PROPOSAL. Unlike the review and verification kinds — whose
// refs address a database row — a proposal ref IS the proposal: a signed,
// opaque, expiring token, because §VI's "nothing exists until the reader
// confirms" leaves no row to address. It is still not a capability. Verifying
// it proves the server minted it for THIS reader in THIS org, and nothing
// about whether they may still act on it; that is re-resolved on every call and
// again at Confirm.
//
// ABSENT SWALLOWS EVERYTHING, exactly as S1's resolver does. A malformed ref, a
// proposal minted for someone else, a template that has since vanished, a store
// that threw — all answer `absent`, and an `absent` card draws no DOM at all,
// so the surface cannot be used to probe what exists.
// ---------------------------------------------------------------------------

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import { TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import {
  resolveProposalForReader,
  describeProposalSchedule,
} from "@cinatra-ai/agents/trigger-schedule-proposal-service";

const ABSENT: LifecycleCardState = { state: "absent" };

export type TriggerScheduleProposalCard = {
  state: LifecycleCardState;
  view: TriggerScheduleProposalViewBody | null;
};

/** The one "nothing to draw" answer. */
export const ABSENT_PROPOSAL_CARD: TriggerScheduleProposalCard = {
  state: ABSENT,
  view: null,
};

/**
 * Resolve one proposal card for one reader. NEVER throws.
 *
 * The reader's identity comes from the CALLER's live session, never from the
 * ref: the token is bound to a (user, org) pair, and this call answers `absent`
 * unless the caller can present exactly that pair. Which is also why §IX marks
 * this card first-party only — the widget branch authenticates a principal
 * through a broker and its own slice owns whether that principal may ever hold
 * a proposal at all.
 */
export async function resolveTriggerScheduleProposalCard(params: {
  ref: string;
  userId: string;
  orgId: string;
  isAdmin: boolean;
}): Promise<TriggerScheduleProposalCard> {
  const { ref, userId, orgId, isAdmin } = params;
  if (!userId || !orgId) return ABSENT_PROPOSAL_CARD;

  try {
    const resolved = await resolveProposalForReader(ref, { userId, orgId });

    if (resolved.phase === "absent") return ABSENT_PROPOSAL_CARD;

    if (resolved.phase === "proposal") {
      // §IV: `restricted` and `absent` are never drawn for each other. A reader
      // who may SEE the proposal but not confirm it gets a DRAWN card with a
      // disabled floor and the reason on screen — never a silently dropped one.
      const state: LifecycleCardState = resolved.canConfirm
        ? { state: "pending", canDecide: true, canComment: false }
        : {
            state: "restricted",
            canDecide: false,
            canComment: false,
            reason: resolved.restrictedReason ?? "You can't confirm this schedule.",
          };
      const view: TriggerScheduleProposalViewBody = {
        phase: "proposal",
        version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
        agentName: resolved.agentName,
        schedule: resolved.proposal.schedule,
        // The duration estimate is a per-template read the scheduling step
        // already performs on its own surface; the card asks for it separately
        // rather than paying for it on every resolve of an already-settled
        // proposal. `null` renders the honest "Unavailable." the form draws.
        durationCopy: null,
        canConfirm: resolved.canConfirm,
        restrictedReason: resolved.restrictedReason,
      };
      return { state, view };
    }

    // Settled — §VI: "The settled card is the trigger's chrome." No floor to
    // press: the decision has been made, so S1's `settled` is the honest state
    // and the two quiet controls hang off the body, not off the decision axis.
    const view: TriggerScheduleProposalViewBody = {
      phase: "settled",
      version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
      agentName: resolved.agentName,
      runId: resolved.runId,
      triggerType: resolved.triggerType,
      scheduleCopy: resolved.scheduleCopy,
      timezone: resolved.timezone,
      // The held-step tree is a compile-time property of the template, read on
      // the run's own Trigger tab. It is deliberately empty here rather than
      // wrong: S2 mounts the shared step tree, which reads it authoritatively.
      gatedSteps: [],
      released: resolved.released,
      arming: resolved.arming,
      // Cancel acts on a live, un-released, fully-installed schedule. While the
      // install is still draining there is no scheduler to cancel yet.
      canCancel: !resolved.released && !resolved.arming,
      // "Release now for an administrator" (§VI) — admin-only, by design.
      canRelease: isAdmin && !resolved.released && !resolved.arming,
    };
    return { state: { state: "settled" }, view };
  } catch {
    // A store/transport failure must not become an existence signal either.
    return ABSENT_PROPOSAL_CARD;
  }
}

export { describeProposalSchedule };
