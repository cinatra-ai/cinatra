// ---------------------------------------------------------------------------
// THE BOUND CARD, RE-CHECKED ON THE SERVER (cinatra#2932, lifecycle-b W5a).
//
// From the plan (PLAN: Agents Lifecycle (B), §4):
//
//   "The bound card travels with the message. When the box is bound to a card —
//    by the binding rules on PLAN: Agents Lifecycle (A) (section 2: one open
//    review binds on its own, a picked review wins, two or more unpicked bind
//    nothing), never by a guess — the message carries that fact as a reference
//    the server re-checks under your own identity."
//
//   "A refusal is the platform's own, relayed. Nothing bound, several cards
//    waiting, or a card you may read but not decide: the platform refuses in its
//    own words and the assistant says those words back. ... For the platform to
//    be able to say 'several things are waiting', the message must carry a
//    checked fact that more than one was open to you — so that state is confirmed
//    by the server, not decided by the page alone."
//
// WHAT THE CLIENT SENDS AND WHAT IT CANNOT DECIDE. The page sends what it can
// see: the refs of the cards it has on screen, and the one the reader pressed,
// if any. It decides NOTHING. This module re-resolves every ref under the
// reader's own access, drops the ones that are not really theirs, and applies
// the binding rule to what SURVIVED — so a page that offers ten refs the reader
// cannot see binds nothing, and a page that claims one card while two are open
// gets the ambiguous refusal anyway.
//
// THE REFUSAL IS A SENTENCE, HERE, ONCE. It is the platform's own words and the
// assistant relays them; keeping it beside the rule that produces it is what
// stops the refusal and the reason from drifting apart. It carries a COUNT and
// no identifiers, exactly like the composer refusal it replaces, because it is
// persisted into a transcript the model reads back.
//
// ORDER MATTERS AND IS THE RULE'S: an explicit pick wins outright; otherwise
// exactly one surviving card binds on its own; two or more bind nothing.
// ---------------------------------------------------------------------------

import "server-only";

import {
  controlsLentBy,
  typedControlFor,
  resolveBoundReference,
  type BoundReferenceResolution,
} from "@/lib/lifecycle/bound-reference-resolver";
import { mintLentActionGrant, type LentActionControl } from "@/lib/lifecycle/lent-action-grant";
import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";
import {
  recordLentActionGrant,
  sweepExpiredLentActionGrants,
} from "@/lib/lifecycle/lent-action-grant-store";
import {
  enforceReviewRunAccess,
  // The narrow, ids-only listing the conversational pull uses. Same table, same
  // org predicate, same oldest-first order — so "how many are open to you" has
  // one answer across the product.
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { listOpenReviewGateCandidates } from "@cinatra-ai/agents/lifecycle-policy-store";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

/** How many candidate refs one message may carry. A composer shows a handful of
 *  cards; a body offering more is a client bug or a prober, and either way the
 *  excess is dropped before any store is touched. */
export const MAX_BOUND_CANDIDATE_REFS = 10;

/** The longest message a lent comment can carry — the SAME bound the decision
 *  route puts on a comment, so a message this mint accepts is one the card's own
 *  path will accept whole. */
export const MAX_LENT_COMMENT_CHARS = 10_000;

/** What the page observed. Claims, not conclusions. */
export type BoundCardClaim = {
  /** Every card the composer had on screen, as its server-minted ref. */
  readonly candidateRefs: readonly string[];
  /** The ref the reader explicitly pressed, or null. */
  readonly focusedRef: string | null;
};

export type BoundCardBinding =
  /** Exactly one card is bound and these are the controls it lends. */
  | {
      readonly kind: "bound";
      readonly ref: string;
      readonly resolution: BoundReferenceResolution;
      readonly controls: readonly LentActionControl[];
    }
  /** Several cards are open to this reader and none was picked. Nothing binds. */
  | { readonly kind: "ambiguous"; readonly count: number; readonly refusal: string }
  /** Nothing is bound. The turn is ordinary conversation. */
  | { readonly kind: "none" };

/**
 * How many open review gates this reader really has.
 *
 * The same narrow candidate listing + per-row access check the conversational
 * pull uses, bounded the same way — this is a per-send cost, so it reads the
 * org's oldest open gates and stops. It COUNTS; it never returns a ref, so it
 * can widen nothing.
 *
 * TWO HONEST BOUNDS (convergence round 2):
 *
 *   · it enumerates REVIEW gates, which is the only card class a send currently
 *     mints a control for, so it is exactly as complete as the class it guards;
 *   · it reads a WINDOW of the organization's oldest open gates, so on a busy
 *     organization this reader's own card can sit outside it and the count comes
 *     back 0. That is why the caller treats anything other than a confirmed 1 as
 *     "cannot confirm" and lends nothing: the counter is allowed to be
 *     incomplete precisely because an incomplete answer refuses.
 */
async function countOpenReviewCardsForReader(
  actorCtx: ReviewActorContext,
): Promise<OpenCardCount> {
  const rows = await listOpenReviewGateCandidates({
    orgId: actorCtx.orgId,
    limit: OPEN_CARD_SCAN_WINDOW,
  });
  // THE SCAN HIT ITS WINDOW, so there may be more beyond it. Reported, not
  // hidden: an incomplete count cannot confirm anything.
  let complete = rows.length < OPEN_CARD_SCAN_WINDOW;
  let open = 0;
  for (const row of rows) {
    try {
      const access = await enforceReviewRunAccess(
        row.runId,
        actorCtx.actor,
        "read",
        actorCtx.roleHints,
      );
      if (access.ok) open += 1;
    } catch {
      // A row whose check THREW is a row we know nothing about, so the count is
      // no longer complete — dropping it silently is what made a "1" untrue.
      complete = false;
    }
    // Two is already the answer; stopping early is a real exhaustion of the
    // question this count asks, so completeness survives it.
    if (open > 1) return { count: open, complete: true };
  }
  return { count: open, complete };
}

/** How many of the org's oldest open gates the count reads. Matches the pull's
 *  own window, and for the same reason: a bounded per-send cost. */
const OPEN_CARD_SCAN_WINDOW = 25;

/**
 * What the count answers: how many, AND whether it could see everything.
 *
 * The completeness flag is what makes the number usable (convergence round 3). A count
 * of one from a scan that filled its window, or that dropped a row whose access
 * check threw, is not evidence that one is all there is — so the caller binds
 * only on a COMPLETE count of exactly one and asks the person to pick otherwise.
 */
export type OpenCardCount = { readonly count: number; readonly complete: boolean };

/**
 * The platform's own refusal when several cards are waiting.
 *
 * Identifier-free on purpose — it is persisted into an LLM-visible transcript —
 * and it names the way OUT, because a refusal that does not is just a wall.
 */
export function severalCardsWaitingRefusal(count: number): string {
  return (
    `${count} cards are waiting for you, so nothing was done to any of them. ` +
    `Choose the one you mean — press its “Reply from the chat box” control — and ` +
    `say it again.`
  );
}

/**
 * Re-check the page's claim under the reader's own access and apply the binding
 * rule to what survives.
 *
 * A ref that does not resolve contributes NOTHING and is not reported: the
 * reader learns about their own cards from the cards, not from a counting error
 * message. Duplicate refs collapse, so a client repeating one ref cannot
 * manufacture ambiguity.
 */
export async function resolveBoundCard(input: {
  readonly claim: BoundCardClaim;
  readonly actorCtx: ReviewActorContext;
  readonly resolve?: typeof resolveBoundReference;
  /**
   * The SERVER'S OWN count of the review gates open to this reader (convergence round
   * 1, finding 5).
   *
   * Without it the ambiguity fact was the page's: a client that sent only ONE of
   * two open refs would get an automatic binding the person never made, and the
   * plan's "the message must carry a checked fact that more than one was open to
   * you — so that state is confirmed by the server, not decided by the page
   * alone" would be a comment rather than a mechanism. The default enumerates
   * the reader's own open review gates and access-checks each, exactly as the
   * conversational pull's listing does.
   *
   * IT CAN ONLY EVER REFUSE. The count is used to turn a claimed single card
   * into an ambiguous refusal; it never binds a card the claim did not carry, so
   * an enumeration that fails or under-reports narrows nothing and widens
   * nothing.
   */
  readonly countOpenCards?: (
    actorCtx: ReviewActorContext,
  ) => Promise<OpenCardCount>;
}): Promise<BoundCardBinding> {
  const resolve = input.resolve ?? resolveBoundReference;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const ref of input.claim.candidateRefs) {
    if (typeof ref !== "string" || ref.length === 0) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    candidates.push(ref);
    if (candidates.length >= MAX_BOUND_CANDIDATE_REFS) break;
  }
  if (candidates.length === 0) return { kind: "none" };

  const resolved = await Promise.all(
    candidates.map(async (ref) => {
      try {
        return { ref, resolution: await resolve({ ref, actorCtx: input.actorCtx }) };
      } catch {
        return { ref, resolution: { kind: "absent" } as BoundReferenceResolution };
      }
    }),
  );
  // A card that lends NO control is not an open card for this purpose: it cannot
  // take an instruction, so counting it would produce an ambiguity the reader
  // cannot resolve by picking.
  const live = resolved.filter((r) => controlsLentBy(r.resolution).length > 0);
  if (live.length === 0) return { kind: "none" };

  // AN EXPLICIT PICK WINS OUTRIGHT — and a STALE ONE BINDS NOTHING AT ALL
  // (convergence round 1, finding 4).
  //
  // The page-side focus reducer lets a stale explicit pick fall through to the
  // single-card rule below it, and there that is harmless: the worst outcome is
  // a comment box pointing at the wrong card, which the reader can see. Here the
  // consequence is different in kind — a stale pick would MINT AN AUTHORITY over
  // a card the person did not choose, using the words they wrote for the one
  // they did. So the two rules deliberately differ, and this one refuses:
  // the person picked B, B is gone, and A is not a substitute for it.
  if (input.claim.focusedRef !== null) {
    const focused = live.find((r) => r.ref === input.claim.focusedRef);
    if (!focused) return { kind: "none" };
    return {
      kind: "bound",
      ref: focused.ref,
      resolution: focused.resolution,
      controls: controlsLentBy(focused.resolution),
    };
  }
  const chosen = live.length === 1 ? live[0] : undefined;
  if (!chosen) {
    return {
      kind: "ambiguous",
      count: live.length,
      refusal: severalCardsWaitingRefusal(live.length),
    };
  }
  // NOTHING WAS PICKED, so a single card may bind on its own — but ONLY if the
  // server can CONFIRM that a single card is all there is.
  //
  // AN INCONCLUSIVE COUNT REFUSES (convergence round 2). The counter reads a bounded
  // window of the organization's oldest open gates, so it can legitimately fail
  // to SEE this reader's card — and an earlier draft treated "saw nothing" and
  // "an enumeration that threw" as "one is open", which meant the automatic
  // binding could still be obtained by a client that under-reported. The rule is
  // now the plan's own: with nothing clearly bound, no control is lent at all.
  // Exactly one confirmed card binds; anything else — more than one, none
  // visible in the window, a count that could not run — binds nothing and asks
  // the person to pick. Pressing the card's own control always works, which is
  // what the refusal tells them to do.
  const countOpen = input.countOpenCards ?? countOpenReviewCardsForReader;
  let counted: OpenCardCount | null = null;
  try {
    counted = await countOpen(input.actorCtx);
  } catch {
    counted = null;
  }
  // COMPLETE, AND EXACTLY ONE (convergence round 3). A count of 1 from a scan that hit
  // its window, or one that dropped a row whose access check threw, is not
  // evidence that one is all there is — the missing rows are precisely the ones
  // it could not see. So the automatic binding requires a count that EXHAUSTED
  // its scan with nothing dropped and found exactly one.
  if (!counted || !counted.complete || counted.count !== 1) {
    const count = counted && counted.count > 1 ? counted.count : live.length;
    return {
      kind: "ambiguous",
      count,
      refusal: severalCardsWaitingRefusal(count),
    };
  }
  return {
    kind: "bound",
    ref: chosen.ref,
    resolution: chosen.resolution,
    controls: controlsLentBy(chosen.resolution),
  };
}

// ---------------------------------------------------------------------------
// SEND TIME: what the turn is bound to, and what it may press (cinatra#2932).
//
// One entry, called once per turn by `runAssistantTurn`, that does the whole of
// the plan's send-time half:
//
//   · resolve the person's own live standing (the bound-turn actor);
//   · re-check the page's claim under it;
//   · mint ONE grant for ONE control of the bound card and record its row;
//   · hand back the sentence the model is told — either what it may press, or
//     the platform's own refusal to relay.
//
// WHICH CONTROL IS GRANTED, AND WHY IT IS NOT THE MODEL'S CHOICE. A grant names
// exactly one control. The plan's line is "its choices are exactly what the
// card's own buttons offer", and WHICH button a sentence asks for is a reading
// of the person's words — which is cinatra#2853's typed actions per card kind,
// not this slice's. So a send mints exactly ONE control today: `comment` on a
// bound review.
//
// WHAT A LENT COMMENT ACTUALLY DOES, said exactly (convergence round 2). On an active
// single-target LIFECYCLE review, a non-empty comment is not an annotation: the
// card's own path files it as CHANGES REQUESTED — the gate resolves and the work
// goes back for repair (`submitReviewSurfaceChangesRequested`). That is not
// something this slice introduces; it is precisely what the review page's box
// does with any typed sentence TODAY, with no model in the path at all, and the
// plan opens on it as the defect being repaired. What changes here is that the
// filing now goes through the conversation's assistant, so a turn that is
// plainly a question can end without one — and what changes with cinatra#2853 is
// that telling a question from a request for changes becomes a decision the
// product makes rather than an accident of the box being typed in.
//
// THE RESIDUAL, NAMED: until #2853 lands, a model that calls the tool on a turn
// that was not asking files the person's own words as a change request. That is
// strictly narrower than today's unconditional filing and strictly wider than
// where #2853 leaves it. Approve, Reject and a waiting screen's Submit are
// implemented at the handler — they are the substrate #2853 builds on — and are
// deliberately NOT minted by a send, because handing one out on the strength of
// "the model chose to call the tool" would put a terminal decision or a run
// resumption behind text that can reach the model from the run's own content
// (convergence round 1, finding 1).
//
// AND THE WORDS ARE NOT THE MODEL'S EITHER. The person's message is stored with
// the grant and read back at the spend, so what lands on the card is what they
// wrote (finding 2).
//
// FAIL-CLOSED THROUGHOUT. No actor, nothing bound, a mint that cannot express
// itself, a ledger row that lost its race: every one of them yields NO grant.
// A turn with no grant is an ordinary turn; the tool is visible and does
// nothing, and says so when asked to act.
// ---------------------------------------------------------------------------

/** What the turn was granted, and what the model is told about it. */
export type TurnBoundCard = {
  /** The grant to carry on this turn's self-MCP reference, or null. */
  readonly grant: string | null;
  /**
   * The system fragment for this turn. Either names the bound card and the ONE
   * control the assistant may press, or carries the platform's refusal for the
   * assistant to relay. `""` when nothing is bound at all — an ordinary turn is
   * byte-identical to one that never had a composer binding.
   */
  readonly systemContext: string;
};

const NOT_BOUND: TurnBoundCard = { grant: null, systemContext: "" };

/**
 * The primary control a binding lends for a TYPED message, IGNORING the words.
 *
 * SUPERSEDED FOR REVIEWS by `typedControlFor` (cinatra#3080), which reads the
 * person's own message: an exact floor word reaches that control, "reject" is
 * answered, and every other sentence still lands here — on Comment. This
 * function remains the statement of the rule for the cards whose typed road has
 * NOT been built, and it is what `typedControlFor` falls back to for them.
 *
 * A WAITING SCREEN MINTS NOTHING YET (convergence round 1, finding 1). The
 * handler implements `submit` — it is the substrate the later slices build on —
 * but a SEND does not hand it out, because pressing Continue RESUMES A RUN and
 * the decision that a sentence asked for that is exactly what cinatra#2853's
 * typed actions per card kind exist to make. Minting `submit` on the strength of
 * "the model chose to call the tool" would put a run resumption behind text that
 * can reach the model from the run's own content.
 */
export function primaryControlFor(
  resolution: BoundReferenceResolution,
): LentActionControl | null {
  if (resolution.kind === "review") return "comment";
  return null;
}

export async function issueTurnLentActionGrant(input: {
  readonly claim: BoundCardClaim | null | undefined;
  readonly userId: string | null | undefined;
  readonly orgId: string | null | undefined;
  /** This turn's durable message identity — the grant's one-per-message key. */
  readonly messageId: string;
  /**
   * THE PERSON'S OWN WORDS — the message they just typed. Stored with the grant
   * and read back at the spend, so the comment that lands on the card is theirs
   * and the model supplies no text at all (convergence round 1, finding 2).
   */
  readonly messageText: string | null;
  readonly deps?: {
    readonly resolveActor?: typeof resolveBoundTurnActor;
    readonly resolveBinding?: typeof resolveBoundCard;
    readonly mint?: typeof mintLentActionGrant;
    readonly record?: typeof recordLentActionGrant;
    readonly sweep?: typeof sweepExpiredLentActionGrants;
  };
}): Promise<TurnBoundCard> {
  const claim = input.claim;
  if (!claim || claim.candidateRefs.length === 0) return NOT_BOUND;
  const d = input.deps ?? {};
  const actorCtx = await (d.resolveActor ?? resolveBoundTurnActor)({
    userId: input.userId,
    orgId: input.orgId,
  });
  if (!actorCtx) return NOT_BOUND;

  const binding = await (d.resolveBinding ?? resolveBoundCard)({ claim, actorCtx });
  if (binding.kind === "none") return NOT_BOUND;
  if (binding.kind === "ambiguous") {
    // THE PLATFORM'S OWN REFUSAL, RELAYED. No grant is minted, so the assistant
    // could not act even if it tried; it is told the words to say back and told
    // not to improve them.
    return {
      grant: null,
      systemContext:
        "\n\nBOUND CARD — NONE, AND THE PLATFORM HAS REFUSED. " +
        `Say this back to the person, word for word, and add nothing to it: "${binding.refusal}" ` +
        "You hold no authority to operate any card this turn; do not attempt one, and do not " +
        "offer to pick a card on their behalf.",
    };
  }

  // WHICH CONTROL THE SENTENCE ASKS FOR (cinatra#3080 item 6). The typed road is
  // one pure ladder in `typedControlFor`: an exact floor word reaches that
  // control, a retired word is answered rather than silently dropped, and every
  // other sentence is a Comment exactly as before.
  const asked = typedControlFor(binding.resolution, input.messageText);
  if (asked.kind === "retired") {
    // THE PLATFORM'S OWN REFUSAL, RELAYED — the same shape an ambiguous binding
    // gets, and for the same reason: no grant is minted, so the assistant could
    // not act even if it tried, and it is told the words to say back rather than
    // left to invent an answer about a control that no longer exists.
    return {
      grant: null,
      systemContext:
        "\n\nBOUND CARD — NO GRANT, AND THE PLATFORM HAS ANSWERED. " +
        `Say this back to the person, word for word, and add nothing to it: "${asked.reason}" ` +
        "You hold no authority to operate any card this turn; do not attempt one.",
    };
  }
  if (asked.kind === "none") return NOT_BOUND;
  const control = asked.control;

  // WORD FOR WORD, OR NOT AT ALL (convergence round 2). The words that land are the
  // person's, so a message the card's own decision path would REFUSE as too long
  // must not be quietly shortened into one it accepts: that would turn "your
  // words" into "the first ten thousand characters of your words" without saying
  // so. An over-long message lends nothing and the person uses the card's own
  // button, which is the same answer the decision route gives them. An EMPTY
  // message lends nothing either — there is nothing to place.
  const words = input.messageText ?? "";
  if (words.trim().length === 0) return NOT_BOUND;
  if (words.length > MAX_LENT_COMMENT_CHARS) return NOT_BOUND;

  const minted = (d.mint ?? mintLentActionGrant)({
    userId: actorCtx.actor.userId ?? "",
    orgId: actorCtx.orgId,
    messageId: input.messageId,
    cardRef: binding.ref,
    control,
  });
  if (!minted) return NOT_BOUND;

  // COLLECT BEFORE CREATING (convergence round 2). The sweep runs on the path that
  // creates the debt and is AWAITED, so an expired row — which carries the
  // person's message text — is removed by the next bound send rather than by a
  // best-effort call that may never be observed. Still never allowed to fail the
  // turn: a sweep that throws costs rows, never correctness, because an expired
  // grant is already unspendable by predicate.
  await (d.sweep ?? sweepExpiredLentActionGrants)().catch(() => undefined);

  const recorded = await (d.record ?? recordLentActionGrant)(
    minted.claims,
    input.messageText,
  ).catch(() => false);
  // A grant whose row did not land is an authority the ledger will refuse, so it
  // is not handed out at all — better no grant than one that fails at the call.
  if (!recorded) return NOT_BOUND;

  const what =
    binding.resolution.kind === "review"
      ? "a review the person is looking at"
      : "the screen an agent is waiting on";
  return {
    grant: minted.grant,
    systemContext:
      `\n\nBOUND CARD. This message was sent with ${what} bound to the prompt window. ` +
      `You may press exactly ONE control on it, ONCE, by calling \`lifecycle_bound_card_decide\` ` +
      `with ref "${binding.ref}" and control "${control}". You supply NO text: what lands on ` +
      "the card is the person's own message, held on the server. Do this only when the person " +
      "is asking for it; a question about the card is answered as a question and presses " +
      "nothing. Report what comes back and add nothing to it; where your sentence and the card " +
      "disagree, the card is right.",
  };
}
