// ---------------------------------------------------------------------------
// WHAT THE READER'S WORDS ASK THE ACTIVE CARD FOR (cinatra#2853; plan §2.2 "the
// prompt window acts on the active card").
//
// Plan §2.2: "the signed-in person can state in words any action that card
// already offers, under the same authorization and the same confirm-on-decide as
// the card's own controls … The assistant interprets the words; it never
// originates the decision, and no card gains an action its controls do not
// already have."
//
// THIS MODULE IS THE INTERPRETING, AND IT IS DETERMINISTIC ON PURPOSE. There is
// no model anywhere in the decision path — not as a fallback, not as a
// tie-breaker. A model in this seam would be the assistant ORIGINATING a
// terminal decision the moment it read a sentence generously, which is the one
// thing §2.2 forbids and the one thing a decision path can never take back. The
// field-gate ladder next door may ask a model to extract a VALUE (a wrong
// extraction leaves a form field wrong and a person fixes it); a resolved review
// gate has no such second chance.
//
// SO THE READING IS NARROW, AND SILENCE FALLS BACK TO TEXT. A message becomes a
// terminal decision only when the WHOLE message is the decision — the verb, an
// optional object pronoun, an optional rationale after a colon, nothing else.
// Everything else stays what it already was before this slice: the card's
// comment, verbatim. That asymmetry is deliberate and it is the safe one:
// misreading a decision as a comment leaves the gate open and the reader able to
// press the button, while misreading a comment as a decision resolves a gate
// nobody chose to resolve.
//
// WHY NOT SIMPLY "APPROVE APPEARS IN THE MESSAGE". Because "should I approve
// it?", "I would approve it if the intro were shorter" and "don't approve this
// yet" all contain the verb and none of them is a decision. Anchoring the match
// to the whole trimmed message is what makes those three impossible to
// misread — there is no substring search here to be fooled.
// ---------------------------------------------------------------------------

import type { ComposerDecision } from "@cinatra-ai/agents/lifecycle-card-runtime";

/** What one typed message asks the bound card to do. */
export type ComposerCardIntent =
  /** The words are the message: the card's own comment path takes them. */
  | { kind: "comment"; text: string }
  /** The words state one of the card's own terminal verbs, and its rationale. */
  | { kind: "decision"; decision: ComposerDecision; note: string | null };

/**
 * An explicit comment directive — plan §2.2's own example, "add a comment: the
 * second paragraph overstates the result". It runs FIRST, so a reader who says
 * "comment: approve it" comments the words "approve it" rather than approving.
 */
const COMMENT_DIRECTIVE =
  /^(?:add(?:\s+a)?\s+comment|leave(?:\s+a)?\s+comment|comment)\s*:\s*(\S[\s\S]*)$/i;

/** The verb, an optional object, and a rationale after the colon. */
const DECISION_WITH_NOTE =
  /^(approve|reject)(?:\s+(?:it|this|this one|the review|the card))?\s*:\s*(\S[\s\S]*)$/i;

/** The verb and an optional object, and NOTHING else but sentence punctuation. */
const DECISION_ALONE =
  /^(approve|reject)(?:\s+(?:it|this|this one|the review|the card))?[.!]*$/i;

function asDecision(verb: string): ComposerDecision {
  return verb.toLowerCase() === "approve" ? "approve" : "reject";
}

/**
 * Read ONE typed message against the active card's controls.
 *
 * PURE, and the whole reading is here rather than spread across the send
 * handler, because "did the person decide, or did they remark?" is the question
 * a resolved gate hangs on — and a rule that cannot be read in one place cannot
 * be shown to be the rule.
 */
export function interpretComposerMessage(message: string): ComposerCardIntent {
  const trimmed = message.trim();

  const directive = COMMENT_DIRECTIVE.exec(trimmed);
  if (directive) return { kind: "comment", text: directive[1]!.trim() };

  const withNote = DECISION_WITH_NOTE.exec(trimmed);
  if (withNote) {
    return {
      kind: "decision",
      decision: asDecision(withNote[1]!),
      note: withNote[2]!.trim(),
    };
  }

  const alone = DECISION_ALONE.exec(trimmed);
  if (alone) return { kind: "decision", decision: asDecision(alone[1]!), note: null };

  // Not a decision the reader stated whole — so it is what it has always been.
  return { kind: "comment", text: trimmed };
}
