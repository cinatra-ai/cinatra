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
  resolveBoundReference,
  type BoundReferenceResolution,
  type LentCardControl,
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
import { readLatestDurableHitlGateArtifact } from "@cinatra-ai/agents/store";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
// The id table is the pure, dependency-free, environment-neutral constants
// module; importing the constant is what keeps this leaf and the gate emitter
// spelling the same string.
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "@cinatra-ai/agents/agent-builder-ids";
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
  /**
   * RUNS whose waiting SCREEN the box sits under (cinatra#2934, lifecycle-b W5c).
   *
   * A waiting HITL screen has no card ref on any client — one is minted at gate
   * emission only for the marked artifact-review gate — so a page cannot claim
   * a screen the way it claims a review. It names the RUN instead, and the
   * server mints the screen's own ref from the run's durable parked row under
   * the reader's own access. The page therefore still decides nothing: it says
   * which run its box sits under, which is the one thing it certainly knows.
   */
  readonly screenRunIds?: readonly string[];
};

/** How many runs one message may offer a waiting screen for. */
export const MAX_BOUND_SCREEN_RUNS = 4;

export type BoundCardBinding =
  /** Exactly one card is bound and these are the controls it lends. */
  | {
      readonly kind: "bound";
      readonly ref: string;
      readonly resolution: BoundReferenceResolution;
      readonly controls: readonly LentCardControl[];
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
  /** How a named run's waiting screen becomes a ref. Injectable for test. */
  readonly mintScreenRef?: (runId: string) => Promise<string | null>;
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
  // THE SERVER MINTS A WAITING SCREEN'S REF (cinatra#2934). The page named a
  // run; the ref comes from the run's own durable parked row, here, and the
  // resolve below re-checks it under the reader's access exactly like any other
  // candidate — a run the reader may not answer produces a ref that resolves to
  // `absent` and contributes nothing.
  const mintScreenRef = input.mintScreenRef ?? mintParkedScreenRef;
  const screenRuns = (input.claim.screenRunIds ?? []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  for (const runId of Array.from(new Set(screenRuns)).slice(0, MAX_BOUND_SCREEN_RUNS)) {
    const ref = await mintScreenRef(runId).catch(() => null);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    candidates.push(ref);
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
  // A LONE WAITING SCREEN BINDS ON ITS OWN, and the open-REVIEW count has no say
  // in it (cinatra#2934, lifecycle-b W5c). The count below exists because the
  // page could under-report how many REVIEWS were open to the reader; a screen
  // is not claimed by the page at all — the server minted its ref from the run
  // the box sits under — and the counter enumerates review gates only, so
  // consulting it here would refuse every screen with "1 cards are waiting".
  // With a review ALSO live the ordinary rule runs, because then two different
  // things really are open and the person must pick.
  if (chosen.resolution.kind === "hitl_screen") {
    return {
      kind: "bound",
      ref: chosen.ref,
      resolution: chosen.resolution,
      controls: controlsLentBy(chosen.resolution),
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
 * The primary control a binding lends for a TYPED message.
 *
 * `controlsLentBy` says what the card offers; this says which one a sentence
 * gets. Deliberately narrow — see the note above — and pure, so the choice is
 * one readable line rather than a condition buried in a mint.
 */
export function primaryControlFor(
  resolution: BoundReferenceResolution,
): LentActionControl | null {
  if (resolution.kind === "review") return "comment";
  // A WAITING SCREEN NOW MINTS `submit` (cinatra#2934, lifecycle-b W5c), and
  // W5a's reason for withholding it is answered rather than dropped.
  //
  // THE PLAN ASKS FOR IT IN SO MANY WORDS: "When you plainly ask, in the same
  // message, for it to be submitted, the assistant submits through the same
  // checked, server-side action the button uses — one road for the press and for
  // the ask", and §6 requires "an agent's HITL screen is filled and, when asked
  // in so many words, submitted by the assistant". W5a withheld it because its
  // replacement — the fill road — did not exist, so a message could only ever
  // have meant "submit"; with the fill road here, filling is what an ordinary
  // "make it say X" reaches, and the press is the separate thing the person has
  // to ask for.
  //
  // WHAT BOUNDS IT, exactly as it bounds a lent comment: the grant is minted
  // only for a message the PERSON sent with that screen bound, it names one
  // control, it lives two minutes, it is spent once, and the press runs the
  // gate's own actor-checked resume entry — `execute` AND `approveHitl` against
  // the responder — so no authority is added that the person does not have.
  // WHAT IS SENT is the values the person's own screen was shown holding, read
  // back on the server from the fill row; the model supplies none of it.
  //
  // THE RESIDUAL IS REAL AND IS NOT HIDDEN: whether a sentence ASKED for the
  // press is the model's judgement, so text reaching the model — the run's own
  // content included — can induce one. That is the same residual a lent comment
  // already carries, and telling a question from a request is cinatra#2853's
  // typed actions per card kind, which build on this substrate.
  //
  // WHAT BOUNDS IT HERE, structurally rather than by instruction (convergence
  // round 1, finding 2): the handler REFUSES a press unless THIS MESSAGE also
  // placed a fill on that screen. An induced bare press therefore does nothing,
  // and the fill an induced press would have to make first appears in the
  // person's own fields, in front of them, before anything is sent.
  if (resolution.kind === "hitl_screen") return "submit";
  return null;
}

/**
 * The screen a run is parked at, as a ref — minted here, on the server, from
 * the run's own durable row.
 *
 * WHAT THE ROW IS, said exactly (convergence round 1, finding 6): the durable
 * reader answers the screen the run LAST recorded, not proof that the run is
 * parked there now. So this mints a ref for "the screen this run last recorded",
 * and everything downstream re-checks: the resolver re-reads the row under the
 * reader's own access, the fill demands an unspent grant and the run's respond
 * access, and the gate's own resume entry re-checks the run before any effect.
 *
 * `null` when the reader answers nothing, for the artifact-review redirect
 * screen (that moment is a REVIEW card and is bound as one), and whenever the
 * codec cannot express a ref. It authorizes NOTHING.
 */
export async function mintParkedScreenRef(runId: string): Promise<string | null> {
  // STATICALLY IMPORTED, deliberately. A dynamic `import("@cinatra-ai/agents/store")`
  // is opaque to the org-write boundary analyser, which reads it as an
  // unreviewed new caller of a module inside the write perimeter. The module is
  // ALREADY in this file's graph — `bound-reference-resolver` imports the same
  // reader statically — so naming it at the top costs nothing and keeps the
  // boundary analysable, which is the point of the rule.
  const screen = await readLatestDurableHitlGateArtifact(runId).catch(() => null);
  if (!screen) return null;
  if (screen.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID) return null;
  return encodeLifecycleGateRef({ runId, reviewTaskId: screen.reviewTaskId });
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
  // A CLAIM CAN CARRY NO REFS AND STILL BE A BINDING (cinatra#2934, convergence
  // round 1, finding 1). The four windows outside the chat sit directly under
  // the run's own waiting screen, which has NO ref on any client — they name the
  // RUN and the server mints the ref. An early return on `candidateRefs` alone
  // would have refused every one of them a grant, so both roads would have
  // answered "not allowed" on the very screens this slice is for.
  if (!claim) return NOT_BOUND;
  if (claim.candidateRefs.length === 0 && (claim.screenRunIds ?? []).length === 0) {
    return NOT_BOUND;
  }
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

  const control = primaryControlFor(binding.resolution);
  if (!control) return NOT_BOUND;

  // WORD FOR WORD, OR NOT AT ALL (convergence round 2). The words that land are the
  // person's, so a message the card's own decision path would REFUSE as too long
  // must not be quietly shortened into one it accepts: that would turn "your
  // words" into "the first ten thousand characters of your words" without saying
  // so. An over-long message lends nothing and the person uses the card's own
  // button, which is the same answer the decision route gives them. An EMPTY
  // message lends nothing either — there is nothing to place.
  const words = input.messageText ?? "";
  if (words.trim().length === 0) return NOT_BOUND;
  // THE LENGTH BOUND IS THE COMMENT'S, not the screen's (cinatra#2934). What
  // lands on a REVIEW is the person's words, so a message the card's own path
  // would refuse as too long must lend nothing rather than be quietly
  // shortened. A SCREEN's submit sends the values its own fields were shown
  // holding — the message is never placed anywhere — so the same bound there
  // would take the fill road away from anyone who typed a long description.
  if (control !== "submit" && words.length > MAX_LENT_COMMENT_CHARS) return NOT_BOUND;

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

  if (binding.resolution.kind === "hitl_screen") {
    // TWO ROADS, NAMED APART (cinatra#2934). Filling is the ordinary thing a
    // described change reaches and presses nothing; the press is the separate
    // thing the person has to ask for in so many words.
    return {
      grant: minted.grant,
      systemContext:
        `\n\nBOUND SCREEN. This message was sent with the screen an agent is waiting on bound to ` +
        `the prompt window, ref "${binding.ref}".\n` +
        `· TO FILL ITS FIELDS — whenever the person describes what the form should say — call ` +
        `\`lifecycle_bound_screen_fill\` with that ref and the values. This SUBMITS NOTHING: the ` +
        `values appear in the fields in front of them and they press the screen's own button. ` +
        `Fields the form does not declare are dropped; ask the person about anything you cannot ` +
        `work out.\n` +
        `· TO SUBMIT IT — ONLY when the person asks for that in so many words in this same ` +
        `message — FILL IT FIRST, then call \`lifecycle_bound_card_decide\` with that ref and ` +
        `control "${control}", ONCE. A press with nothing filled in this message is refused by ` +
        `the server, so the order is not advice. What is sent is what their screen was shown ` +
        `holding; you supply no values. A question about the screen is answered as a question ` +
        `and presses nothing.\n` +
        `Report what comes back and add nothing to it; where your sentence and the screen ` +
        `disagree, the screen is right.`,
    };
  }
  return {
    grant: minted.grant,
    systemContext:
      `\n\nBOUND CARD. This message was sent with a review the person is looking at bound to the prompt window. ` +
      `You may press exactly ONE control on it, ONCE, by calling \`lifecycle_bound_card_decide\` ` +
      `with ref "${binding.ref}" and control "${control}". You supply NO text: what lands on ` +
      "the card is the person's own message, held on the server. Do this only when the person " +
      "is asking for it; a question about the card is answered as a question and presses " +
      "nothing. Report what comes back and add nothing to it; where your sentence and the card " +
      "disagree, the card is right.",
  };
}
