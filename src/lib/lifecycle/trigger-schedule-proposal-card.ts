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

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "@cinatra-ai/agents";
import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
// THE ROW A HELD SCHEDULE'S CARD OPENS ON (cinatra#2936). One decision, applied
// here as it is on the run page's scheduling step: `scheduleScreenSelection`
// applies `scheduleDefaultForLaunch`, which
// `@cinatra-ai/agents/lifecycle-coordinator` declares and exports.
import { scheduleScreenSelection } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type { TriggerScheduleProposalViewBody } from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import {
  TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  proposedScheduleSchema,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";
import {
  resolveProposalForReader,
  resolveProposalForRun,
  describeProposalSchedule,
} from "@cinatra-ai/agents/trigger-schedule-proposal-service";
import { decodeScheduleRunRef } from "./lifecycle-card-ref";

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
  /**
   * The reader's STANDING on the run, for a run-addressed ref whose run came
   * from no proposal (cinatra#3004). A schedule armed on the run's own
   * scheduling step is bound to the RUN rather than to one person, so who may
   * read it is the run's own access question — asked with the same actor and
   * role hints every other run surface asks it with. Omitted, the service falls
   * back to the run's own owner.
   */
  access?: { actor: PrimitiveActorContext; roles?: ActorRoleHints };
}): Promise<TriggerScheduleProposalCard> {
  const { ref, userId, orgId, access } = params;
  if (!userId || !orgId) return ABSENT_PROPOSAL_CARD;

  try {
    // TWO REF FAMILIES, ONE CARD (cinatra#2788, S9d). A conversation addresses
    // this card by the PROPOSAL — the token IS the subject. The run page and
    // the review page hold no token and know a RUN, so they address it by a
    // run-scoped ref whose key label is disjoint from every other ref family's:
    // a gate ref, a proposal token and a schedule run ref can never be mistaken
    // for one another, so the branch below is a decode, not a guess. The run
    // ref is tried FIRST because it is a cheap local decode that either
    // succeeds outright or leaves the token path exactly as it was.
    const runRef = decodeScheduleRunRef(ref);
    const resolved = runRef
      ? await resolveProposalForRun(runRef.runId, { userId, orgId }, access)
      : await resolveProposalForReader(ref, { userId, orgId });

    if (resolved.phase === "absent") return ABSENT_PROPOSAL_CARD;

    // EXPIRED — a DRAWN reading, never an absence (cinatra#2836; plan (A) §7.2
    // step 2, "an expired card **stays visible**, still editable, with
    // **Confirm** to set the schedule again"; §9.1 row 8).
    //
    // This branch is the fix. The resolver used to collapse an expired token
    // into `absent` together with every forged and foreign one, which deleted
    // the card — and the question it asked — out of the reader's transcript and
    // made a reader whose thirty minutes ran out indistinguishable from one who
    // was never entitled to the proposal at all. §IV reserves `absent` for the
    // second reader, and only for them.
    //
    // NOTHING IS DISCLOSED BY DRAWING IT. The service reaches this arm only for
    // a token that decrypted under this server's key and was minted for exactly
    // this reader in exactly this org; an expired-but-foreign token is refused
    // on the byte-identical path a forged one takes and still answers `absent`.
    // The body is the same projection of the same token the live card already
    // showed the same person.
    //
    // THE STATE IS THE FLOOR, exactly as it is for a live proposal. The expired
    // card's Confirm is pressable — the press re-proposes and confirms the
    // replacement — so the honest rung is `pending`, and a reader the instance
    // would refuse to run this agent for gets `restricted` for the same reason
    // and with the same sentence they would get before it expired.
    if (resolved.phase === "expired") {
      // THE SAME DECISION AS THE LIVE CARD'S, for the same reason: what the
      // reader sees is the schedule they stated, so the card re-opens on their
      // own rows rather than on an empty form.
      const expiredRows = scheduleScreenSelection({
        humanPresent: true,
        statedSchedule: resolved.proposal.schedule,
      });
      if (expiredRows === null) return ABSENT_PROPOSAL_CARD;
      const state: LifecycleCardState = resolved.canConfirm
        ? { state: "pending", canDecide: true, canComment: false }
        : {
            state: "restricted",
            canDecide: false,
            canComment: false,
            reason: resolved.restrictedReason ?? "You can't confirm this schedule.",
          };
      const view: TriggerScheduleProposalViewBody = {
        phase: "expired",
        version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
        agentName: resolved.agentName,
        // The rows the reader last saw, so the expired card re-opens on their
        // own schedule rather than on an empty form.
        schedule: expiredRows,
        // Read back through the ONE renderer the settled card uses, so "what
        // expired" is worded exactly as "what was armed" would have been.
        scheduleCopy: describeProposalSchedule(resolved.proposal.schedule),
      };
      return { state, view };
    }

    if (resolved.phase === "proposal") {
      // THE ROWS ARE THE SCHEDULE MOMENT'S DEFAULT, APPLIED (cinatra#2936).
      // A held schedule IS the "stated" answer — the person stated it in a
      // conversation and is reading it back — so the card's rows come from the
      // one decision rather than from a rule of this module's own, which is
      // what the run page's scheduling step now does too.
      //
      // A PERSON IS PRESENT WHENEVER THIS BODY IS BUILT. The resolution above
      // answers `absent` for every reader the token was not minted for, so a
      // drawn proposal body always has the person who stated it in front of it.
      // The refusal is honoured rather than worked around: no rows, no card.
      const proposalRows = scheduleScreenSelection({
        humanPresent: true,
        statedSchedule: resolved.proposal.schedule,
      });
      if (proposalRows === null) return ABSENT_PROPOSAL_CARD;
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
        schedule: proposalRows,
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
      // THE ARMED ROWS. Plan (A) §7.2: after Confirm "the same card, with the
      // same option rows, now shows the armed schedule". The selections come
      // from the resolver's read-back of the INSTALLED row, so the settled card
      // and the run page's schedule step draw one schedule, not two.
      schedule: resolved.schedule,
      triggerType: resolved.triggerType,
      scheduleCopy: resolved.scheduleCopy,
      // OMITTED UNLESS TRUE — a wire omission, deliberately NOT a version bump
      // (cinatra#2874 review). `superseded` is a NEW key, and a client bundle
      // still parsing with the pre-#2859 `.strict()` settled schema rejects any
      // payload that carries it. Making the field optional only helps a NEW
      // parser read an OLD payload; it does nothing for the direction that
      // actually breaks. So emitting `superseded: false` on every ordinary
      // settled card would blank EVERY settled card for a stale tab — to
      // describe a state that card is not even in. Emitting it only when true
      // means a stale client fails on exactly the genuinely superseded card:
      // the new, rare state, which is the honest minimal blast radius.
      //
      // Bumping TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION is strictly worse, not
      // safer: `version` is a `z.literal`, so a bump makes every stale client
      // reject every card — the exact harm this avoids — in exchange for a
      // clearer rejection nobody is left to read.
      //
      // `ProposalResolution.superseded` stays an always-boolean internally. Only
      // the emission is conditional, so no reader of the resolution has to start
      // handling `undefined`.
      ...(resolved.superseded ? { superseded: true as const } : {}),
      timezone: resolved.timezone,
      // The held-step tree is a compile-time property of the template, read on
      // the run's own Trigger tab. It is deliberately empty here rather than
      // wrong: S2 mounts the shared step tree, which reads it authoritatively.
      gatedSteps: [],
      released: resolved.released,
      // OMITTED UNLESS TRUE, for the reason `superseded` is (cinatra#2972).
      ...(resolved.stopped ? { stopped: true as const } : {}),
      arming: resolved.arming,
      // "Save changes … re-arms the trigger" (plan (A) §7.2). The reading is
      // the resolver's — the same predicate the endpoint refuses on — so the
      // card never offers a control the server is already going to refuse.
      canSave: resolved.canSave,
      // CANCEL SCHEDULE IS THE RECURRING SCHEDULE'S CONTROL, AFTER ITS FIRST
      // FIRE, AND NOTHING ELSE'S (cinatra#2972). Plan (A) §7.2 as amended
      // 2026-08-25: "its one control is **Cancel schedule**, shown only for a
      // recurring schedule that has fired once — it stops the recurring
      // schedule and then makes the scheduler non-editable".
      //
      // It used to be "any schedule that has not been released and is not still
      // arming", which put it on a one-off and on a recurring schedule that had
      // never fired. Both are withdrawn: what the control does now is STOP a
      // running schedule, and a schedule that has produced nothing has nothing
      // to stop.
      //
      // An ALREADY-STOPPED schedule answers false, which is what leaves the
      // card with no floor at all — "and then makes the scheduler
      // non-editable".
      // A COMPATIBILITY SHIM, READ BY NOBODY (cinatra#2972, codex round 2).
      // The control is gone and no renderer consults this field; it is still
      // EMITTED, as a constant false, so a stale client bundle whose `.strict()`
      // settled schema still REQUIRES the key can go on parsing settled cards
      // for the length of a rolling deploy. Dropping the emission would blank
      // every settled schedule card on such a tab — a wider harm than one dead
      // boolean on the wire — and emitting `false` cannot bring Run now back:
      // there is no control, no confirm strip and no `release` op left to read
      // it. Removable once no bundle predating this change can still be live.
      canRelease: false,
      canCancel:
        resolved.triggerType === "recurring" &&
        resolved.firedOnce &&
        !resolved.stopped &&
        !resolved.arming,
    };
    return { state: { state: "settled" }, view };
  } catch {
    // A store/transport failure must not become an existence signal either.
    return ABSENT_PROPOSAL_CARD;
  }
}

export { describeProposalSchedule };

// ---------------------------------------------------------------------------
// The card's DECISIONS (cinatra#2788, epic #2784 S9d).
//
// §VI's card operates four things. In a CONVERSATION: Confirm on the proposal
// floor, and Save changes on the armed one — the two the plan puts there, and
// the only two. On the RUN PAGE and the REVIEW PAGE, where §VI's card is the
// SCHEDULE STEP in the rail, the same Save changes plus the ONE operation
// **Cancel schedule** (`cancel-trigger-schedule`), and only for a recurring
// schedule that has fired once. **Run now** (`release-trigger-now`) is gone
// with its whole action path — plan (A) §7.2 as amended 2026-08-25, "there is
// no Run now" (cinatra#2972). `adjust` is the re-propose the two Confirms compose with; it is
// no longer a control of its own, because the rows are editable as they stand.
// Until this slice the confirm/adjust pair were cookie-bound server actions with
// zero UI callers and the cancel/release pair existed only on the run page's
// Trigger tab — so a card drawn in the widget could show a floor it could never
// press.
//
// THIS FUNCTION IMPLEMENTS NONE OF THEM. Each op is handed to the canonical
// path that already owns it, with an ACTOR the caller resolved from a real
// credential. What this module adds is the one thing those paths cannot do for
// themselves: turn the REF the card was drawn with into the subject the op acts
// on, server-side, so the client never names a token's template or a trigger's
// run.
//
// DYNAMIC IMPORTS ON THE MUTATION PATHS, deliberately. The resolve route
// imports this module for `resolveTriggerScheduleProposalCard`; a static edge
// from here to the confirm transaction, the install outbox and the trigger
// service would put all three on that route's graph for code no resolve ever
// runs. `trigger-schedule-proposal-actions.ts` defers for exactly this reason
// and says so.
//
// AN AUTHORIZATION DENIAL IS THE SAME SENTENCE EVERY TIME. A ref that does not
// decode, a proposal minted for someone else, a run the reader may not touch —
// all answer `not-permitted` with one fixed string, so the endpoint cannot be
// used to tell those apart. A STATE refusal (the proposal already expired, the
// moment has passed, the agent cannot run) is different in kind: it is UI copy
// the reader needs in order to act, and the service already writes it as such.
// ---------------------------------------------------------------------------

/** The one refusal for every authorization denial on this card's operations. */
export const SCHEDULE_DECISION_REFUSAL =
  "You can't take this action on this schedule.";

export type ScheduleDecisionOp =
  | "confirm"
  | "adjust"
  /** Re-arm an ALREADY-armed trigger from the card's own rows — plan (A) §7.2
   *  "Save changes, which re-arms the trigger". Not a second arming path: it
   *  delegates to `updateRunTriggerScheduleForActor`, which delegates in turn to
   *  the one `setRunTriggerForActor`. */
  | "save"
  /** STOP a recurring schedule that has fired — plan (A) §7.2's **Cancel
   *  schedule**. It stops the schedule; it never deletes it and never pauses
   *  the run (cinatra#2972). */
  | "cancel";

export type ScheduleDecisionOutcome =
  | { kind: "confirmed"; runId: string; alreadyConfirmed: boolean }
  /** Adjust RE-PROPOSES: the card swaps to the new ref and stays on its floor.
   *  Nothing was armed and nothing was written. */
  | { kind: "reproposed"; ref: string; expiresAt: number }
  /** Save changes landed: the trigger is re-armed on the rows just saved, and
   *  the card re-resolves rather than drawing the new schedule optimistically. */
  | { kind: "saved"; runId: string }
  /** The recurring schedule is stopped. The row stays and the card re-resolves
   *  onto read-only rows with no floor. */
  | { kind: "cancelled" }
  | { kind: "not-permitted"; message: string }
  | { kind: "error"; message: string };

const NOT_PERMITTED: ScheduleDecisionOutcome = {
  kind: "not-permitted",
  message: SCHEDULE_DECISION_REFUSAL,
};

/**
 * Operate one schedule-proposal card for one reader. NEVER throws.
 *
 * The actor is the CALLER's — resolved from a cookie session on a first-party
 * host or from the widget's own broker token — and every op re-derives its
 * subject from the ref against that actor before it acts.
 */
export async function decideTriggerScheduleProposal(params: {
  ref: string;
  op: ScheduleDecisionOp;
  /** §VI's selections, for `adjust` only. */
  schedule?: unknown;
  userId: string;
  orgId: string;
  role: string | null;
  /**
   * The reader's STANDING on the run, for a run-addressed ref (cinatra#3004).
   * The same value the read took, so a control a reader can see is a control
   * they can press. It authorizes nothing by itself — every op below re-checks
   * the actor against the run it reaches.
   */
  access?: { actor: PrimitiveActorContext; roles?: ActorRoleHints };
}): Promise<ScheduleDecisionOutcome> {
  const { ref, op, userId, orgId, role, access } = params;
  if (!userId || !orgId) return NOT_PERMITTED;

  try {
    if (op === "confirm") {
      // The token IS the subject and it is re-verified against this actor
      // INSIDE the confirm transaction — this frame passes it through and adds
      // no check of its own that could drift from that one.
      const { confirmTriggerScheduleProposal } = await import(
        "@cinatra-ai/agents/trigger-schedule-proposal-service"
      );
      const result = await confirmTriggerScheduleProposal(
        { userId, orgId, role },
        ref,
      );
      return result.ok
        ? {
            kind: "confirmed",
            runId: result.runId,
            alreadyConfirmed: result.alreadyConfirmed,
          }
        : { kind: "error", message: result.error };
    }

    if (op === "adjust") {
      // THE SUBJECT COMES FROM THE VERIFIED TOKEN, never from the body. A card
      // on four hosts must not be able to re-point a proposal at another agent,
      // so this path hands `adjustTriggerSchedule` the REF the card was drawn
      // with and nothing else: the service re-verifies that token against this
      // reader and takes the template off it.
      //
      // `priorToken` rather than a template id, and the difference is the
      // safety property (cinatra#2859): the replacement inherits the adjusted-
      // away proposal's consume identity, so the whole family is one row in the
      // consume table and at most one member can ever become a run. Handing a
      // template id would mint a fresh identity and leave the old card
      // spendable for the rest of its TTL — two runs, one on the schedule the
      // reader had just corrected away from.
      const {
        resolveProposalForReader,
        adjustTriggerSchedule,
        reproposeExpiredSchedule,
        PROPOSAL_REFUSALS,
      } = await import("@cinatra-ai/agents/trigger-schedule-proposal-service");
      const resolved = await resolveProposalForReader(ref, { userId, orgId });
      // Adjust re-opens the rows of a proposal that is still a proposal — or of
      // an EXPIRED one, which is the Confirm press on the expired card
      // (cinatra#2836; plan (A) §7.2 step 2). A settled one has a run; an absent
      // one is not this reader's.
      //
      // WHY THE EXPIRED CARD'S CONFIRM ARRIVES AS AN `adjust`. The expired token
      // is unspendable, so its floor cannot be a bare confirm: the press
      // re-proposes and confirms the replacement, which is the SAME composite an
      // EDITED live proposal already performs, on the same endpoint and under
      // the same authorization. One press, one meaning, no second op on the wire.
      if (resolved.phase !== "proposal" && resolved.phase !== "expired") {
        return NOT_PERMITTED;
      }
      const parsed = proposedScheduleSchema.safeParse(params.schedule);
      if (!parsed.success) {
        return { kind: "error", message: PROPOSAL_REFUSALS.invalid };
      }
      // TWO NAMED PATHS, EACH REFUSING EXACTLY WHAT IT SHOULD. The live card's
      // Adjust must keep treating an expired token as a refusal — widening it
      // would have made every one of its other callers start accepting a closed
      // window. Both demand the identical authority: a token authentically
      // minted for THIS reader in THIS org, with everything else, an
      // expired-but-foreign ref included, refused outright.
      const repropose =
        resolved.phase === "expired" ? reproposeExpiredSchedule : adjustTriggerSchedule;
      const proposed = await repropose({
        priorToken: ref,
        userId,
        orgId,
        schedule: parsed.data,
      });
      return proposed.ok
        ? { kind: "reproposed", ref: proposed.token, expiresAt: proposed.expiresAt }
        : { kind: "error", message: PROPOSAL_REFUSALS.invalid };
    }

    // Save and Cancel both act on the RUN the card settled into — resolved
    // here, never named by the caller.
    const settled = await resolveSettledRunForReader(ref, { userId, orgId }, access);
    if (!settled) return NOT_PERMITTED;

    if (op === "save") {
      // SAVE CHANGES (plan (A) §7.2). The selections are validated against the
      // SAME closed vocabulary Adjust is — there is no cron field to put an
      // expression in — and the run comes from the ref, so a caller cannot
      // re-point a save at somebody else's trigger.
      const parsed = proposedScheduleSchema.safeParse(params.schedule);
      if (!parsed.success) {
        const { PROPOSAL_REFUSALS } = await import(
          "@cinatra-ai/agents/trigger-schedule-proposal-service"
        );
        return { kind: "error", message: PROPOSAL_REFUSALS.invalid };
      }
      const { updateRunTriggerScheduleForActor } = await import(
        "@cinatra-ai/agents/trigger-service"
      );
      const result = await updateRunTriggerScheduleForActor(
        { userId, role, source: "ui" },
        { runId: settled, schedule: parsed.data },
      );
      if (result.ok) return { kind: "saved", runId: result.runId };
      return result.error === "forbidden" || result.error === "unauthorized"
        ? NOT_PERMITTED
        : { kind: "error", message: result.error };
    }

    // CANCEL SCHEDULE STOPS, IT DOES NOT DELETE (cinatra#2972). Plan (A) §7.2
    // as amended 2026-08-25: it "stops the recurring schedule and then makes
    // the scheduler non-editable". `deleteRunTriggerForActor` — which this op
    // used to call — removes the row AND flips an armed run to `stopped`, i.e.
    // exactly the two things the amendment says this control never does. The
    // Trigger tab's own Cancel trigger still calls that path; this one does not.
    const { stopRecurringTriggerForActor } = await import(
      "@cinatra-ai/agents/trigger-service"
    );
    const result = await stopRecurringTriggerForActor(
      { userId, role, source: "ui" },
      { runId: settled },
    );
    // The service's own refusals are authorization refusals ("forbidden",
    // "unauthorized") and are collapsed; anything else is state the reader
    // can act on.
    if (result.ok) return { kind: "cancelled" };
    return result.error === "forbidden" || result.error === "unauthorized"
      ? NOT_PERMITTED
      : { kind: "error", message: result.error };
  } catch {
    // A store or transport failure is not an existence signal either.
    return { kind: "error", message: "That didn't go through. Try again." };
  }
}

/**
 * The run a settled card's controls act on — `null` when this reader has no
 * settled card for this ref.
 *
 * BOTH REF FAMILIES, ONE ANSWER. A conversation's card holds the proposal token;
 * the run page's and the review page's hold the run-scoped ref. Either way the
 * run is the resolver's answer, taken against the live reader, so the two hosts
 * cannot reach different runs from the same press.
 *
 * THE SAME STANDING THE READ TOOK (cinatra#3004). A run that came from no
 * proposal is resolved under the RUN's own access control, so this call has to
 * present what the read presented — otherwise a control a reader can SEE would
 * answer "not permitted" when they press it. It grants nothing on its own: the
 * service behind each op re-checks the actor against the run it reaches.
 */
async function resolveSettledRunForReader(
  ref: string,
  actor: { userId: string; orgId: string },
  access?: { actor: PrimitiveActorContext; roles?: ActorRoleHints },
): Promise<string | null> {
  const { resolveProposalForReader, resolveProposalForRun } = await import(
    "@cinatra-ai/agents/trigger-schedule-proposal-service"
  );
  const runRef = decodeScheduleRunRef(ref);
  const resolved = runRef
    ? await resolveProposalForRun(runRef.runId, actor, access)
    : await resolveProposalForReader(ref, actor);
  return resolved.phase === "settled" ? resolved.runId : null;
}
