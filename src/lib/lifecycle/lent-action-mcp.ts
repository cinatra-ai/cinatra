// ---------------------------------------------------------------------------
// THE LENT ACTION — one self-MCP primitive (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "The card lends the assistant its own controls, once. ... While a card is
//    bound, and only then, the assistant holds one action that operates that
//    card and no other. Its choices are exactly what the card's own buttons
//    offer ... A card that offers no decision lends none. The grant is consumed
//    by its first use; a second attempt in the same message is refused, and the
//    assistant says so."
//
//   "The lent control is therefore new, and it is one more tool on that same
//    server — the only place the assistant can reach anything about the
//    lifecycle. It can be used only with a grant the server mints when a message
//    is sent with a bound card ... A card reference by itself grants nothing, and
//    a tool being visible to the model is not permission to use it."
//
//   "Using the action is pressing the button. Same identity, same permissions,
//    same recorded decision, same one-time effect."
//
// THE NAME IS HONEST, AND THAT IS DELIBERATE. `lifecycle_bound_card_decide`
// carries the `decide` token, so the delegated policies' decision-verb backstop
// DENIES it by construction. Reaching chat therefore costs an explicit,
// disclosed override entry plus its typed `CarveOut` twin — which is exactly the
// visibility this one exception is supposed to have. A name chosen to slip past
// the backstop (`lifecycle_bound_card_operate`) would have hidden the class the
// primitive belongs to, and the epic's own note about `schedule_proposal_render`
// says why that matters: the name is load-bearing for the guarantee.
//
// SIX GATES, IN THIS ORDER, EVERY ONE FAIL-CLOSED:
//
//   1. A GRANT ON THE FRAME. No grant, no action — a visible tool is not
//      permission. The grant arrives on the request frame, put there by the
//      transport from the header the hosted self-MCP reference carried; it is
//      never a tool argument, because an argument is something a model can
//      invent.
//   2. THE GRANT VERIFIES. Signature, shape and life. A forged, rotated-out or
//      expired grant is one observable.
//   3. THE GRANT MATCHES THE CALL. Person, organization, card, and the control
//      the call names against the grant's own MENU — the card's buttons narrowed
//      by the person's own words (cinatra#2853). A grant minted for another
//      card, another person, or a button the person never named is refused here.
//   4. THE PERSON'S OWN CREDENTIAL. Resolved LIVE from the store — never the
//      delegated chat token, whose whole point is that it is weaker. This is the
//      plan's bound-turn actor branch.
//   5. THE CARD IS STILL THERE, AND STILL LENDS THAT CONTROL. The bound-reference
//      resolver runs under that credential; a card that offers no decision lends
//      none, and a control the card does not offer is refused even with a valid
//      grant.
//   6. THE GRANT IS SPENT. One atomic delete, BEFORE the effect. Two concurrent
//      calls of one grant cannot both press the button, and a call whose effect
//      then fails does not get a second attempt — a retry is a new message with
//      a new grant, which is what "single use" has to mean if it is to mean
//      anything.
//
// WHAT THE SIX GATES DO NOT CLOSE, said plainly (convergence round 1, findings 1-3).
// A grant is a BEARER authority for its two minutes: it pins who may spend it,
// what it may press and that it is spent once, and it does NOT pin which turn of
// that person spends it — a party already holding a valid delegated token for
// the same person and organization could present a captured unspent grant on
// another of their turns. That is one press of one card the person had bound,
// added to authority such a party already holds. And nothing here decides
// whether the person's message was ASKING for the press: the model chooses to
// call, so text reaching the model — reviewed content, a form value, the
// conversation — can induce a call.
//
// WHAT BOUNDS THAT AFTER cinatra#2853. What lands is still the PERSON'S OWN
// WORDS, read out of the spent row rather than supplied by the model. And the
// MENU on the grant is now cut from those same words on the send path, before
// any model reads anything: a control the person's own message never named is
// not on it, so an induced call cannot reach Approve, Reject, a skills Confirm
// or a schedule Confirm on a message that never named one. The two keys are
// deliberately held apart: the person supplies the words, the assistant supplies
// the reading, and one without the other presses nothing.
//
// WHAT AN INDUCED CALL CAN STILL DO, stated exactly rather than rounded down
// (convergence round 1, findings 1 and 3):
//
//   · file the person's own words as a comment on a review. That is NOT
//     harmless — on an active single-target lifecycle review the card's own path
//     files a comment as CHANGES REQUESTED and the gate resolves — but it is
//     byte-for-byte what the review page's own box does with any typed sentence
//     today, with no model in the path at all, and this slice does not widen it;
//   · re-draw a schedule card's rows, which writes nothing and arms nothing;
//   · confirm a different subset of the skills THIS card offered.
//
// And the word key is WORD PRESENCE, not intent: a message that mentions an act
// without asking for it — a question, a negation, a quotation — still puts that
// act on the menu. `typed-decision-words.ts` says so in its own header. What the
// key removes is the case the plan cares about: an act the person never wrote.
//
// THEN, AND ONLY THEN, THE CARD'S OWN PATH RUNS. `submitReviewDecisionAction`
// for the review card's three buttons; `approveReviewTaskInternal` for the HITL
// screen's Continue. Neither is re-implemented and neither is relaxed: the same
// order, the same CAS, the same audit row a press produces. The platform's own
// outcome is relayed back word for word — "the assistant's line reports what came
// back and adds nothing".
// ---------------------------------------------------------------------------

import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
// THE CARD'S OWN PATHS ARE IMPORTED LAZILY, AND THAT IS A MEASUREMENT, NOT A
// STYLE CHOICE. This module is registered on the MCP server, which is reachable
// from `/api/mcp`, `/api/a2a`, `/api/llm-bridge` and `/chat` — four routes
// carrying LOCKED first-party-graph budgets (the route-graph ratchet). Pulling
// the review page's decision action and the gate's resume entry in statically
// put 38 modules onto each of those four routes for code that runs ONLY when a
// person's bound message actually presses a control. Deferring them to the call
// keeps all four budgets flat, which is the same reason
// `widget-lifecycle-frame-actor.ts` exists as its own leaf.
//
// The specifiers are LITERAL, so nothing about this is a variable-URL import,
// and the modules are the SAME ones the review page and the decide route call —
// nothing is re-implemented and nothing is relaxed. Both are injectable through
// `deps` so a test never pays the import at all.
type SubmitReviewDecisionAction = typeof import(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions"
)["submitReviewDecisionAction"];
type ApproveReviewTaskInternal = typeof import(
  "@cinatra-ai/agents/review-task-actions"
)["approveReviewTaskInternal"];

async function loadSubmitReviewDecision(): Promise<SubmitReviewDecisionAction> {
  const mod = await import(
    "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions"
  );
  return mod.submitReviewDecisionAction;
}

async function loadApproveScreen(): Promise<ApproveReviewTaskInternal> {
  const mod = await import("@cinatra-ai/agents/review-task-actions");
  return mod.approveReviewTaskInternal;
}

// THE SKILLS CARD'S AND THE SCHEDULE CARD'S OWN ENTRIES (cinatra#2853), lazy for
// the same measured reason as the two above, and named here so a reader can see
// at a glance that this module re-implements nothing:
//
//   · `confirmRecommendationForActor` / `skipRecommendationForActor` — the two
//     functions the chip row's Confirm and Skip reach through the cookie action,
//     and that the widget's broker route reaches with its own credential. One
//     core, three identities;
//   · `writeRunSkillSelectionForActor` — the SAME execute-tier selection write
//     the cookie action delegates to, resolved from this person's credential
//     instead of an ambient cookie, exactly as the broker route does it;
//   · `dispatchRunStartForPrincipal` — the canonical run-start dispatcher, which
//     re-checks the run's own ownership before it queues anything;
//   · `decideTriggerScheduleProposal` — the ONE entry every host's schedule card
//     operates through, `op` and all.
type ConfirmRecommendationForActor = typeof import(
  "@cinatra-ai/agents/run-recommendation-core"
)["confirmRecommendationForActor"];
type SkipRecommendationForActor = typeof import(
  "@cinatra-ai/agents/run-recommendation-core"
)["skipRecommendationForActor"];
type WriteRunSkillSelectionForActor = typeof import(
  "@cinatra-ai/agents/run-recommendation-core"
)["writeRunSkillSelectionForActor"];
type DispatchRunStartForPrincipal = typeof import(
  "@cinatra-ai/agents/run-dispatch-core"
)["dispatchRunStartForPrincipal"];
type DecideTriggerScheduleProposal = typeof import(
  "@/lib/lifecycle/trigger-schedule-proposal-card"
)["decideTriggerScheduleProposal"];

async function loadHoldDecisionCore() {
  return import("@cinatra-ai/agents/run-recommendation-core");
}

async function loadRunStartDispatcher(): Promise<DispatchRunStartForPrincipal> {
  const mod = await import("@cinatra-ai/agents/run-dispatch-core");
  return mod.dispatchRunStartForPrincipal;
}

async function loadDecideSchedule(): Promise<DecideTriggerScheduleProposal> {
  const mod = await import("@/lib/lifecycle/trigger-schedule-proposal-card");
  return mod.decideTriggerScheduleProposal;
}
import { LIFECYCLE_REF_MAX_LENGTH } from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";
import {
  controlsLentBy,
  resolveBoundReference,
} from "@/lib/lifecycle/bound-reference-resolver";
import {
  LENT_ACTION_CONTROLS,
  isLentActionControl,
  matchLentActionGrant,
  verifyLentActionGrant,
  type LentActionControl,
} from "@/lib/lifecycle/lent-action-grant";
import { consumeLentActionGrant } from "@/lib/lifecycle/lent-action-grant-store";

/** The primitive's name. Exported so the policy, the carve-out and the rule's
 *  own test all name the same string rather than three literals that can drift. */
export const LENT_ACTION_PRIMITIVE = "lifecycle_bound_card_decide";

/**
 * The refusal when this turn holds no authority to press that control.
 *
 * ONE SENTENCE FOR FOUR CASES — no grant, a grant that does not verify, a grant
 * for another card or another button, and a grant already spent. They are
 * deliberately indistinguishable: a caller learning WHICH would learn about an
 * authority they do not hold. It is about the CALLER'S OWN turn, so it discloses
 * nothing about any row.
 */
export const LENT_ACTION_NO_AUTHORITY =
  "This message is not allowed to operate that control. Nothing was done.";

/** The refusal when the card itself is not available to this person. Mirrors the
 *  pull primitives' one fixed sentence, and for the same reason. */
export const LENT_ACTION_CARD_UNAVAILABLE =
  "That card is not available to you. Nothing was done.";

type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

function say(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * WHY A CALL WAS REFUSED — on the SERVER'S OWN LOG, never in the answer.
 *
 * The sentence the caller gets stays one sentence for every cause; that is the
 * property, and it is not weakened here. But an operator reading a run could not
 * tell a forged grant from a spent one either, and a road that refuses cannot be
 * repaired from a sentence designed to say nothing. So the cause is written
 * where only the operator can read it: a fixed token, the control the call
 * asked for, and nothing else — no ref, no words, no identity.
 */
type LentActionRefusal =
  | "input-shape"
  | "no-grant-on-frame"
  | "grant-does-not-verify"
  | "grant-names-another-card-or-control"
  | "grant-already-spent";

export function noteLentActionRefusal(
  cause: LentActionRefusal,
  control: string | null,
): void {
  console.warn(
    `[lent-action] refused: cause=${cause} control=${control ?? "-"}`,
  );
}

function refuseNoAuthority(
  cause: LentActionRefusal,
  control: string | null = null,
): McpToolResult {
  noteLentActionRefusal(cause, control);
  return say({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
}

function refuseCardUnavailable(): McpToolResult {
  return say({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
}

const inputSchema = z
  .object({
    /** The bound card's opaque ref — the one the turn was told about. */
    ref: z.string().min(1).max(LIFECYCLE_REF_MAX_LENGTH),
    /**
     * The control to press — OPTIONAL, and that is the repair (cinatra#2934,
     * after the graded picture leg).
     *
     * WHY IT WAS A REQUIRED ARGUMENT, AND WHY THAT WAS WRONG. It was required so
     * the call and the grant could be made to agree. But WHICH control this
     * message may press is not a question the model answers: the SERVER decided
     * it at send time, alone, from the card's own kind — `primaryControlFor` —
     * and minted a grant naming that one. Gate 3 then compares the model's
     * answer to the server's own. A free variable whose only correct value the
     * server already holds cannot add safety; it can only ever produce a
     * refusal, and it did: a message that plainly asked to be filled and sent
     * came back "This message is not allowed to operate that control" while the
     * FILL of that same message applied — which is only possible when the grant
     * was live and matched the card, and the run's own rows show no spend, so
     * what did not agree was the ARGUMENT.
     *
     * OMITTED NOW MEANS "the control this message was granted", which is the
     * only control it could ever have pressed. A call that NAMES a different one
     * is refused exactly as before — asking for Reject on a comment grant is
     * still an authority this turn does not hold, and gate 3 still says so.
     */
    control: z.enum(LENT_ACTION_CONTROLS).optional(),
    /**
     * THE SKILLS CARD'S KEPT SET (cinatra#2853) — the full list of skill ids to
     * keep, as the person described it.
     *
     * FOR THE SKILLS CARD'S `confirm` ONLY — every other arm ignores it, and a
     * `skip` presses the card's Skip whatever this says.
     *
     * IT IS NOT A FREE VARIABLE. Every id must be one the card ACTUALLY
     * OFFERED, read back under the person's own access at gate 5; a call naming
     * anything else is REFUSED WHOLE and presses nothing — never quietly
     * filtered, because a quiet filter turns "keep the SEO skill" into "keep
     * nothing" and confirms that. Omitted means "everything the card offered",
     * which is exactly what pressing Confirm without touching a chip does.
     */
    keep: z.array(z.string().min(1).max(512)).max(200).optional(),
    /**
     * THE SCHEDULE CARD'S ROWS (cinatra#2853) — what the person said the
     * schedule should be.
     *
     * FOR THE SCHEDULE CARD'S `adjust` ONLY, and required by it — every other
     * arm ignores it, and a schedule passed with `confirm` refuses the call. It is handed to the card's own
     * `adjust` op, which validates it against the card's own schema and
     * RE-PROPOSES; adjust writes nothing and arms nothing, so the worst a wrong
     * value can do is draw rows the person can see and correct. Passing it with
     * `confirm` REFUSES the call: rows the person has not seen must never be
     * armed by the same act that draws them.
     */
    schedule: z.unknown().optional(),
  })
  .strict();

export const LENT_ACTION_TOOL_DESCRIPTION =
  "Press ONE control of the ONE lifecycle card this message is bound to, as the person who typed it, with their permissions. " +
  "Usable ONLY when this turn was given the matching single-use grant; without it the call does nothing and says so. " +
  "The grant names the controls THIS MESSAGE may press — the card's own buttons, narrowed by the server to the ones the person's OWN WORDS named. " +
  "Name the one they asked for in `control`, or omit it to press the first. " +
  "A control the person did not name, and a control the card does not offer, are both refused — a decision they did not state is not yours to take. " +
  "You do NOT supply the text: what lands on the card is the person's own message, held on the server with the grant. " +
  "It fires at most once per message. Report the answer that comes back and add nothing to it.";

/** The verified grant, as this module reads it off the request frame. */
type FrameGrant = { readonly grant: string; readonly userId: string; readonly orgId: string };

function readFrameGrant(): FrameGrant | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  // NEVER a tool argument. The grant is transport state, put on the frame by the
  // boundary from the header the hosted reference carried.
  const grant = ctx.lentActionGrant;
  if (typeof grant !== "string" || grant.length === 0) return null;
  // The acting person is the FRAME's, never the grant's own claim: the grant is
  // matched against this identity, so a stolen grant presented on somebody
  // else's frame fails gate 3 rather than acting as its own subject.
  const userId = ctx.a2aActorContext?.userId ?? ctx.userId ?? null;
  const orgId = (ctx.a2aActorContext ? ctx.a2aActorContext.orgId : ctx.orgId) ?? null;
  if (!userId || !orgId) return null;
  return { grant, userId, orgId };
}

/**
 * The lent action.
 *
 * Every early return is one of the two fixed sentences. The only place a richer
 * message appears is the platform's OWN outcome, relayed verbatim once the
 * card's path has run.
 */
export async function handleLentAction(
  input: unknown,
  deps: {
    readonly resolve?: typeof resolveBoundReference;
    readonly consume?: typeof consumeLentActionGrant;
    readonly resolveActor?: typeof resolveBoundTurnActor;
    readonly submitReviewDecision?: SubmitReviewDecisionAction;
    readonly approveScreen?: ApproveReviewTaskInternal;
    /** The skills card's and the schedule card's own entries (cinatra#2853). */
    readonly confirmHold?: ConfirmRecommendationForActor;
    readonly skipHold?: SkipRecommendationForActor;
    readonly writeSelection?: WriteRunSkillSelectionForActor;
    readonly dispatchRunStart?: DispatchRunStartForPrincipal;
    readonly decideSchedule?: DecideTriggerScheduleProposal;
    /** This message's own fills + its own attachments (cinatra#2934). */
    readonly readFills?: (
      runId: string,
      ref: string,
      messageId: string,
    ) => Promise<{ ref: string; values: Record<string, unknown> }[]>;
    readonly readAttachments?: (
      runId: string,
      messageId: string,
    ) => Promise<readonly Record<string, unknown>[] | null>;
    readonly buildPayload?: BuildChatGateSubmitPayload;
    readonly now?: () => Date;
  } = {},
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return refuseNoAuthority(
      "input-shape",
      typeof (input as { control?: unknown } | null)?.control === "string"
        ? ((input as { control: string }).control)
        : null,
    );
  }

  // GATE 1 — a grant on the frame.
  const frame = readFrameGrant();
  if (!frame) return refuseNoAuthority("no-grant-on-frame", parsed.data.control ?? null);

  // GATE 2 — the grant verifies.
  const claims = verifyLentActionGrant(frame.grant, { now: deps.now });
  if (!claims) return refuseNoAuthority("grant-does-not-verify", parsed.data.control ?? null);

  // THE CONTROL IS THE GRANT'S. A call that named one must still agree with it
  // (gate 3 below refuses otherwise); a call that named none presses the one
  // this message was granted, which is the only one it could have pressed.
  const control = parsed.data.control ?? claims.control;

  // GATE 3 — the grant matches THIS call.
  const matches = matchLentActionGrant(claims, {
    userId: frame.userId,
    orgId: frame.orgId,
    cardRef: parsed.data.ref,
    control,
  });
  if (!matches) {
    return refuseNoAuthority("grant-names-another-card-or-control", control);
  }

  // GATE 4 — the person's own credential, resolved live.
  const resolveActor = deps.resolveActor ?? resolveBoundTurnActor;
  const actorCtx = await resolveActor({ userId: frame.userId, orgId: frame.orgId });
  if (!actorCtx) return refuseCardUnavailable();

  // GATE 5 — the card is still there and still lends this control.
  const resolve = deps.resolve ?? resolveBoundReference;
  const bound = await resolve({ ref: parsed.data.ref, actorCtx });
  if (bound.kind === "absent") return refuseCardUnavailable();
  const lent = controlsLentBy(bound);
  if (!isLentActionControl(control) || !lent.includes(control)) {
    return refuseCardUnavailable();
  }

  // GATE 6 — spend the grant. Before the effect, atomically, once.
  //
  // THE SPEND IS ALSO WHERE THE PERSON'S WORDS COME FROM (convergence round 1,
  // finding 2). The row carries the message they typed, captured at mint time;
  // the model supplies no text at all, so "your words, word for word" is a
  // property of the mechanism rather than an instruction a prompt-injected model
  // could ignore. A row with no text lands an empty comment, never an invented
  // one.
  // THE ROW IS SPENT ON ITS ANCHOR, NOT ON THE BUTTON PRESSED (cinatra#2853).
  // The ledger row records one control — the grant's anchor — and its predicate
  // is what makes the spend atomic and once-only; that property is unchanged,
  // and so is "a row minted `fill` matches no spend". WHICH of this message's
  // controls is pressed is authorized one line up, by the signed menu at gate 3,
  // which is the claim a caller cannot forge. Passing the pressed control here
  // instead would simply make every menu of more than one control unspendable.
  // (`lent-action-grant.ts` records the one consequence of that for a `fill`
  // grant, where the row's predicate is no longer a fourth independent lock.)
  //
  // WHAT THIS COSTS, NAMED (convergence round 1, finding 6): the row used to be
  // a SECOND, independent check that the control being pressed was the control
  // the grant was minted for. It no longer is — the database now sees the anchor
  // whichever button of the menu runs — so that defence-in-depth is gone and the
  // signed menu at gate 3 is the only place the control is checked. Restoring it
  // means recording the menu (or a digest of it) beside the row, which is a
  // schema change this slice does not make. The control is still checked TWICE
  // — against the signed menu at gate 3, and against what the LIVE card lends at
  // gate 5 — so what is gone is the database's independent third opinion, not
  // the check. The properties the row still carries are unchanged and are the
  // ones single-use rests on: one atomic statement, one winner, bound to the
  // person and to the card.
  const consume = deps.consume ?? consumeLentActionGrant;
  const spend = await consume({
    jti: claims.jti,
    userId: frame.userId,
    orgId: frame.orgId,
    cardRefFingerprint: claims.cardRefFingerprint,
    control: claims.control,
  });
  if (spend.outcome !== "consumed") {
    return refuseNoAuthority("grant-already-spent", control);
  }

  const text = spend.messageText;

  // THE CARD'S OWN PATH.
  if (bound.kind === "review") {
    const submit = deps.submitReviewDecision ?? (await loadSubmitReviewDecision());
    const disposition = reviewDisposition(control);
    if (!disposition) return refuseCardUnavailable();
    const outcome = await submit(
      bound.runId,
      bound.reviewTaskId,
      disposition,
      text,
      // ONE actor context for the resolve above and the decision-op check
      // inside — the decision route's own rule, for the same reason.
      actorCtx,
      null,
    );
    return say({ ok: outcome.kind === "decided" || outcome.kind === "annotated" || outcome.kind === "changes-requested", outcome });
  }

  // THE SKILLS CARD (cinatra#2853). Confirm and Skip, through the SAME two core
  // functions the chip row's own buttons reach — `run-recommendation-core`,
  // which the cookie action and the widget broker both call. Nothing is
  // re-implemented: the hold-instance CAS, the execute-tier selection write, the
  // verified release and the dispatch all run exactly as they do for a press.
  if (bound.kind === "recommendation_hold") {
    const core = deps.confirmHold && deps.skipHold && deps.writeSelection
      ? null
      : await loadHoldDecisionCore();
    const who = {
      actor: actorCtx.actor,
      roleHints: actorCtx.roleHints ?? {},
    } as Parameters<ConfirmRecommendationForActor>[0]["who"];
    // THE DISPATCHER IS THE CANONICAL ONE, bound to this person. It re-reads the
    // run and refuses one they do not own, so the release cannot start a run
    // this person could not have started themselves.
    const dispatchRunStart = deps.dispatchRunStart ?? (await loadRunStartDispatcher());
    const dispatch = async ({ runId, templateSlug }: { runId: string; templateSlug: string }) =>
      dispatchRunStart(
        { runId, templateSlug },
        { via: "session", userId: actorCtx.actor.userId ?? frame.userId },
      );
    if (control === "skip") {
      const skip = deps.skipHold ?? core!.skipRecommendationForActor;
      const outcome = await skip({
        runId: bound.runId,
        who,
        holdRef: bound.holdRef,
        dispatch,
      });
      return say({ ok: outcome.ok === true, outcome });
    }
    if (control !== "confirm") return refuseCardUnavailable();
    // THE KEPT SET IS BOUNDED BY WHAT THE CARD OFFERED, AND AN ID THE CARD NEVER
    // OFFERED IS A REFUSAL — not a silent drop (convergence round 1, finding 3).
    //
    // The ids come back from gate 5's own resolve, under this person's access,
    // so a model naming a skill the card never showed cannot add one. Filtering
    // it away QUIETLY was the defect: it turned "keep the SEO skill" into "keep
    // nothing" and confirmed that, which is a decision nobody made. A call that
    // names an id this card is not offering now presses nothing at all, and the
    // person's own chips are still there.
    //
    // A call with NO `keep` confirms exactly what the card offered, which is what
    // pressing Confirm without touching a chip does.
    //
    // THE RESIDUAL, NAMED WITHOUT ROUNDING IT DOWN (convergence round 2): WHICH
    // subset a `keep` names is the assistant's reading of the person's words, so
    // an induced call can confirm a DIFFERENT subset of the same offered skills.
    // And a confirm is not a small act — it settles the hold and may dispatch
    // the run, which is the card's own Confirm doing what it does. What the
    // bound really gives is narrower and is worth stating exactly: the call
    // cannot add a skill the card never offered, cannot reach another hold or
    // another run, and cannot happen at all unless the person's own message
    // named a confirm.
    const offered = bound.offered.map((s) => s.skillId);
    const asked = parsed.data.keep;
    if (asked && asked.some((id) => !offered.includes(id))) {
      return refuseCardUnavailable();
    }
    const confirmedSkillIds = asked ?? offered;
    const confirm = deps.confirmHold ?? core!.confirmRecommendationForActor;
    const write = deps.writeSelection ?? core!.writeRunSkillSelectionForActor;
    const outcome = await confirm({
      runId: bound.runId,
      agentPackageName: bound.agentPackageName,
      confirmedSkillIds,
      who,
      // The SAME execute-tier write the cookie action delegates to, resolved
      // from this person's own credential — the broker route's construction.
      writeSelection: (input) => write({ ...input, who }),
      // The kept set the person settled by asking, so §V's third settled mark is
      // reachable from the typed road exactly as it is from the chip's panel.
      ...(asked ? { adjustedSkillIds: confirmedSkillIds } : {}),
      holdRef: bound.holdRef,
      dispatch,
    });
    return say({ ok: outcome.ok === true, outcome });
  }

  // THE SCHEDULE CARD (cinatra#2853). Adjust and Confirm, through the ONE entry
  // every host's schedule card operates through — `decideTriggerScheduleProposal`
  // — with this person's own identity. `text` is deliberately unused: this card
  // places no words anywhere, so the person's message steers nothing but the
  // assistant's own reading of it.
  if (bound.kind === "schedule_proposal") {
    if (control !== "adjust" && control !== "confirm") return refuseCardUnavailable();
    const decide = deps.decideSchedule ?? (await loadDecideSchedule());
    const role =
      actorCtx.roleHints?.platformRole === "platform_admin" ? "admin" : null;
    const who = {
      userId: actorCtx.actor.userId ?? frame.userId,
      orgId: actorCtx.orgId ?? frame.orgId,
      role,
      access: { actor: actorCtx.actor, roles: actorCtx.roleHints },
    };
    // ONE SPEND, ONE CONTROL — AND A CONFIRM NEVER CARRIES AN ADJUSTMENT
    // (convergence round 1, finding 2).
    //
    // An earlier draft ran the card's `adjust` op and then its `confirm` op
    // under a single spend, on the reading that "make it 8 in the morning on
    // weekdays and confirm" is one act. It is not, and the difference is exactly
    // the safety property: `adjust` mints a NEW card ref, so the confirm would
    // have run against a ref that was never fingerprinted into the grant and
    // never passed gate 5 — and the rows it armed would be rows the person never
    // saw, supplied by the model, on the strength of the word "confirm" alone.
    // Two controls under one spend also contradicts the one thing this whole
    // road promises.
    //
    // So a described change is an ADJUST and stops there: the new rows are drawn
    // in front of the person, and the Confirm is theirs — the card's own button,
    // or a second message. That is the plan's own model for values the assistant
    // places ("the values appear in the form in front of them and they press the
    // form's own button"), applied to the one card that can re-propose.
    if (control === "confirm" && parsed.data.schedule !== undefined) {
      return refuseCardUnavailable();
    }
    if (control === "adjust") {
      // An adjust with no rows to place has nothing to re-propose.
      if (parsed.data.schedule === undefined) return refuseCardUnavailable();
      const adjusted = await decide({
        ...who,
        ref: bound.ref,
        op: "adjust",
        schedule: parsed.data.schedule,
      });
      return say({ ok: adjusted.kind === "reproposed", outcome: adjusted });
    }
    const outcome = await decide({ ...who, ref: bound.ref, op: "confirm" });
    return say({ ok: outcome.kind === "confirmed", outcome });
  }

  // ONLY A HITL SCREEN HAS A CONTINUE (cinatra#2934, repaired after the picture
  // leg). The scheduler form is a bound screen too, and its button is the
  // person's: gate 5 above already refuses it — it lends `fill` and no pressable
  // control — and this states the same thing where the effect is, so a card kind
  // added later cannot fall into a resume path that was never written for it.
  if (bound.kind !== "hitl_screen") return refuseCardUnavailable();

  // The HITL screen's Continue. `approveReviewTaskInternal` is the gate's own
  // actor-checked resume entry — the door the plan says the submit side already
  // has — and it enforces run execute + approveHitl against the run it resolves
  // before any write.
  //
  // WHAT IS SENT IS WHAT THE SCREEN WAS SHOWN HOLDING (cinatra#2934, lifecycle-b
  // W5c). The plan: "the assistant submits through the same checked, server-side
  // action the button uses — one road for the press and for the ask — and the
  // fields still show what was sent." So the values come from the FILL ROW this
  // run recorded for THIS screen, read back here on the server, and the files
  // attached beside the person's own message come from their own row: the model
  // supplies neither, and neither is left behind by the press. A screen nobody
  // filled submits exactly what it submitted before this slice — the form as it
  // stands.
  const approve = deps.approveScreen ?? (await loadApproveScreen());
  const readers = deps.readFills && deps.readAttachments
    ? null
    : await loadRunWindowFillReaders();
  const readFills = deps.readFills ?? readers!.readRunWindowFillsForMessage;
  const readAttachments =
    deps.readAttachments ?? readers!.readRunWindowAttachmentsForMessage;
  const fills = await readFills(bound.runId, parsed.data.ref, claims.messageId).catch(
    () => [] as { ref: string; values: Record<string, unknown> }[],
  );

  // A PRESS SENDS WHAT THIS MESSAGE PLACED — and a message that placed nothing
  // presses nothing (convergence round 1, finding 2).
  //
  // THE PLAN'S OWN SENTENCE IS WHY. "When you plainly ask, IN THE SAME MESSAGE,
  // for it to be submitted, the assistant submits through the same checked,
  // server-side action the button uses — one road for the press and for the ask
  // — AND THE FIELDS STILL SHOW WHAT WAS SENT." The press the plan describes is
  // the second half of a fill: the person said what the form should say and
  // asked for it to go. A press with nothing placed in this message has no
  // "what was sent" to show — the person's own browser edits are not on the
  // server — and would resume a run on values nobody was shown.
  //
  // IT IS ALSO WHAT BOUNDS THE RESIDUAL. Whether a sentence ASKED for the press
  // is the model's judgement, so text reaching the model — the run's own content
  // included — can induce a call. Requiring a fill from the SAME message means
  // an induced bare press does nothing at all, and the fill it would have to
  // make first is itself visible to the person in their own fields.
  //
  // The person presses the screen's own button for everything else, which is
  // what the refusal tells the assistant to say.
  if (fills.length === 0) return refuseCardUnavailable();

  const attachments = await readAttachments(bound.runId, claims.messageId).catch(
    () => null,
  );
  const submitValues = await buildScreenSubmitValues({
    reviewTaskId: bound.screenRef,
    fieldName: bound.form.fieldName,
    // THE SCREEN'S OWN CURRENT VALUES FIRST, then every fill this message placed
    // in order (finding 4). A turn that filled the subject and then the body
    // left BOTH in the fields, and a field the person never mentioned still
    // holds what the screen already had — so what is sent is what the screen
    // shows, not the last thing the assistant said.
    current: bound.form.values,
    fills: fills.map((f) => f.values),
    attachments: attachments ?? [],
    buildPayload: deps.buildPayload,
  });
  try {
    await approve(
      bound.screenRef,
      actorCtx.actor.userId ?? frame.userId,
      submitValues,
      bound.form.fieldName,
      null,
      actorCtx.actor,
      actorCtx.roleHints,
    );
    return say({
      ok: true,
      outcome: { kind: "submitted", placed: Object.keys(Object.assign({}, ...fills.map((f) => f.values))) },
    });
  } catch {
    // The gate's own refusal shape is not a message this surface may invent, and
    // the grant is already spent, so the honest answer is that nothing landed.
    return say({ ok: false, outcome: { kind: "error" }, message: LENT_ACTION_CARD_UNAVAILABLE });
  }
}

type BuildChatGateSubmitPayload = typeof import(
  "@cinatra-ai/agents/hitl-gate-submit"
)["buildChatGateSubmitPayload"];

async function loadRunWindowFillReaders() {
  return import("@cinatra-ai/agents/run-window-conversation-store");
}

async function loadBuildChatGateSubmitPayload(): Promise<BuildChatGateSubmitPayload> {
  const mod = await import("@cinatra-ai/agents/hitl-gate-submit");
  return mod.buildChatGateSubmitPayload;
}

/**
 * The resume payload for a screen submitted by asking.
 *
 * It is the SAME pure builder the browser's own Continue uses — the setup-loop
 * wrap, the grouped-setup merge and the WayFlow approve/userResponse envelope
 * with its attachment wrap all come from there, so a submit that was asked for
 * and a submit that was pressed produce the same shape. `undefined` when there
 * is nothing to say: the gate's own default then applies, byte-identically to
 * the press this road replaces for a screen nobody filled and nobody attached
 * anything to.
 */
export async function buildScreenSubmitValues(input: {
  readonly reviewTaskId: string;
  readonly fieldName: string | undefined;
  /** The screen's OWN current values — what the fields held before this turn. */
  readonly current: Record<string, unknown>;
  /** Every fill this message placed, oldest first. */
  readonly fills: ReadonlyArray<Record<string, unknown>>;
  readonly attachments: readonly Record<string, unknown>[];
  readonly buildPayload?: BuildChatGateSubmitPayload;
}): Promise<Record<string, unknown> | undefined> {
  // WHAT THE SCREEN SHOWS: its own values, with every fill applied over them in
  // the order they were placed.
  const shown: Record<string, unknown> = { ...input.current };
  for (const fill of input.fills) Object.assign(shown, fill);
  if (Object.keys(shown).length === 0 && input.attachments.length === 0) {
    return undefined;
  }
  const build = input.buildPayload ?? (await loadBuildChatGateSubmitPayload());
  const { payload } = build({
    reviewTaskId: input.reviewTaskId,
    ...(input.fieldName ? { fieldName: input.fieldName } : {}),
    value: shown,
    buffered: {},
    pendingAttachments: input.attachments as never,
  });
  return payload;
}

/** The review card's three buttons, as the decision core names them. */
function reviewDisposition(
  control: LentActionControl,
): "approve" | "reject" | "comment" | null {
  if (control === "approve") return "approve";
  if (control === "reject") return "reject";
  if (control === "comment") return "comment";
  return null;
}

export function registerLentActionPrimitive(server: McpRuntimeToolServer): void {
  // REGISTERED UNDER ITS LITERAL NAME, not the constant above, and that is not
  // a style choice: `scripts/build-authz-inventory.mjs` machine-scans
  // `server.registerTool("…")` string arguments to build the authz inventory,
  // and the structural rule test (lifecycle-no-decide-primitives) reads THAT
  // inventory. A constant here would keep the one decision primitive in the
  // tree OUT of the machine-scanned record — the exact opposite of naming the
  // exception where it is enforced. The constant and this literal are pinned
  // equal by the rule test, which asserts the inventory contains it.
  server.registerTool(
    "lifecycle_bound_card_decide",
    {
      title: LENT_ACTION_PRIMITIVE,
      description: LENT_ACTION_TOOL_DESCRIPTION,
      inputSchema,
    },
    (async (input: unknown) => handleLentAction(input)) as never,
  );
}

export function createLentActionMcpModule() {
  return { registerCapabilities: registerLentActionPrimitive };
}
