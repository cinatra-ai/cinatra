// ---------------------------------------------------------------------------
// THE PERSON'S OWN WORDS NAME THE MENU (cinatra#2853, lifecycle-a §2.2).
//
// From the plan (PLAN: Agents Lifecycle (A), §2.2):
//
//   "For the active card, the signed-in person can state in words any action
//    that card already offers … The assistant interprets the words; it never
//    originates the decision, and no card gains an action its controls do not
//    already have."
//
// TWO KEYS, AND NEITHER OF THEM ALONE CAN PRESS ANYTHING. W5a and W5c left one
// residual open and named it in so many words (`bound-card-binding.ts`, the note
// above `primaryControlFor`): "whether a sentence ASKED for the press is the
// model's judgement, so text reaching the model — the run's own content included
// — can induce one", which is why a send deliberately minted `comment` and
// nothing else. This module is the OTHER key:
//
//   · the SERVER reads the person's own message and answers which of the card's
//     own controls that message NAMES — this module, deterministic, on the send
//     path, before any model sees anything;
//   · the MODEL decides whether the sentence is an ask at all, and which item on
//     that menu it is — the plan's "the assistant interprets the words".
//
// A terminal control therefore needs BOTH: the person wrote the word, and the
// assistant read the sentence as asking for it. Content that reaches the model
// from a run cannot put `approve` on the menu, because only the person's own
// message is read here; and a message that says "approve it" still presses
// nothing on its own, because the menu is not a call.
//
// WHAT THIS KEY IS NOT, said plainly because it would otherwise be read as more
// than it is (convergence round 1, finding 1). This is WORD PRESENCE, not
// intent: "do not approve this", "why was this rejected?" and "what would
// confirming do?" all put the named control on the menu, because a lexical rule
// cannot read negation, quotation or a question and pretending otherwise would
// be worse than saying so. It is a NECESSARY condition and never a sufficient
// one — the assistant still has to read the sentence as an ask, and a message
// that never names the act cannot reach it at all. The disclosed residual is
// therefore exactly this: on a message that MENTIONS the act without asking for
// it, a model that is induced to call can press it. That is strictly narrower
// than the road before this slice, where such a message filed the person's words
// as a change request unconditionally, and it is the reason the word families
// below are kept high-precision — "yes", "looks good" and "set it" were dropped
// for being ordinary conversation rather than the naming of an act.
//
// IT CAN ONLY EVER NARROW, and that is the whole safety argument. It takes the
// card's OWN lent set and removes from it; it can add nothing, it routes
// nothing, it extracts no value and it acts on nothing. A word family that is
// too small costs a person one press of the card's own button; one that is too
// large costs nothing by itself, because the model still has to read the
// sentence as an ask and the grant is still one card, one message, one use.
//
// THIS IS NOT THE CLASSIFIER W5c RETIRED. `classifyPromptForGate` and
// `resolveComposerRouting`'s field-gate arm READ a sentence and ACTED on it
// before the assistant saw it — they routed messages and extracted form values
// with no model in the path. Nothing here routes, answers, refuses or fills. It
// answers one question about the person's own text — "did they write the word
// for this button?" — and the answer can only ever remove a button from a menu.
//
// PURE, and deliberately in its own module: the rule can then be read on its own
// and cannot drift into a mint.
// ---------------------------------------------------------------------------

import type { LentCardControl } from "@/lib/lifecycle/bound-reference-resolver";

/**
 * The words each DECIDING control answers to.
 *
 * Only the controls that DECIDE something are listed. A control that decides
 * nothing is not gated here at all — see `ALWAYS_ON_THE_MENU`.
 *
 * Every entry is matched on WORD BOUNDARIES over the person's own text, so
 * "unapproved" is not "approve" and "yesterday" is not "yes". Multi-word entries
 * match as a phrase over normalized whitespace.
 */
export const TYPED_DECISION_WORDS: Readonly<
  Record<"approve" | "reject" | "confirm" | "skip", readonly string[]>
> = {
  // The review card's Approve.
  approve: [
    "approve",
    "approves",
    "approved",
    "approving",
    "accept",
    "accepts",
    "accepted",
    "sign off",
    "signed off",
    "signoff",
    "lgtm",
    "ship it",
  ],
  // The review card's Reject.
  reject: [
    "reject",
    "rejects",
    "rejected",
    "rejecting",
    "decline",
    "declines",
    "declined",
    "refuse",
    "refused",
    "turn it down",
  ],
  // The skills card's Confirm and the schedule card's Confirm.
  confirm: [
    "confirm",
    "confirms",
    "confirmed",
    "confirming",
    "go ahead",
    "schedule it",
  ],
  // WHY "do it", "apply it" and "arm it" ARE NOT HERE (convergence round 2,
  // finding 2). They were, and they were wrong: none of them NAMES the act, so
  // an ordinary "do it" in a message that happens to have a skills or schedule
  // card bound put a terminal control on the menu on the strength of a phrase
  // that means nothing in particular. The families exist to be the half of the
  // key the PERSON holds, so an entry only earns its place by naming the button
  // the card draws. Dropping them costs at most one press of that button.
  // The skills card's Skip.
  skip: ["skip", "skips", "skipped", "skipping", "no skills", "none of them"],
};

/**
 * The controls the words never gate, and why each one is here.
 *
 *   `comment` — the words ARE the comment. A message with anything in it is a
 *               comment by construction, which is exactly what the review page's
 *               own box does with a typed sentence today; gating it on a word
 *               would take away the one road that already works. It is NOT a
 *               harmless control (convergence round 1, finding 1): on an active
 *               single-target lifecycle review a comment is filed as CHANGES
 *               REQUESTED and settles the gate. It is ungated here because that
 *               is precisely what the review page's own box already does with
 *               any typed sentence, so gating it would be a narrowing of a road
 *               this slice is not changing — not because it decides nothing.
 *   `fill`    — a fill presses nothing. It places values in the fields in front
 *               of the person and they press the button (W5c).
 *   `adjust`  — the schedule card's Adjust RE-PROPOSES: it writes nothing and
 *               arms nothing, so it is the schedule card's own fill and is
 *               bounded the same way. The handler STOPS after it — a spend that
 *               adjusts never goes on to confirm (convergence round 1, finding
 *               2) — which is what keeps this entry true.
 *   `submit`  — terminal, and deliberately left to its own structural bound
 *               rather than gated twice: the handler refuses it unless the SAME
 *               message also placed a fill on that screen (W5c). That bound is
 *               tighter than a word could be, and a second, weaker gate on top
 *               of it would only take the road away from someone who described
 *               their change without using the word.
 */
const ALWAYS_ON_THE_MENU: readonly LentCardControl[] = ["comment", "fill", "adjust", "submit"];

/** Lowercased, punctuation flattened to spaces, whitespace collapsed. */
function normalize(words: string): string {
  return ` ${words.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * Did the person's own message name this control's act?
 *
 * `false` for every control the words do not gate — ask
 * `controlsNamedByThePerson` for the menu; this answers only the narrow
 * question, and answering `true` for an ungated control would read as "the words
 * named it" when they did not.
 */
export function wordsNameControl(
  control: LentCardControl | string,
  words: string | null | undefined,
): boolean {
  const family = TYPED_DECISION_WORDS[control as keyof typeof TYPED_DECISION_WORDS];
  if (!family) return false;
  if (typeof words !== "string") return false;
  const haystack = normalize(words);
  if (haystack.trim().length === 0) return false;
  for (const phrase of family) {
    if (haystack.includes(` ${phrase} `)) return true;
  }
  return false;
}

/**
 * The card's own lent controls, narrowed to the ones this message may reach.
 *
 * ORDER IS THE CARD'S, not the sentence's: the result is a filter of `lent`, so
 * the first entry is stable per card kind and can be used as the ledger row's
 * anchor.
 */
export function controlsNamedByThePerson(
  lent: readonly LentCardControl[],
  words: string | null | undefined,
): readonly LentCardControl[] {
  return lent.filter(
    (control) => ALWAYS_ON_THE_MENU.includes(control) || wordsNameControl(control, words),
  );
}
