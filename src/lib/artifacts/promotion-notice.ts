// WHAT THE PERSON IS TOLD WHEN A CONFIRMATION COULD NOT RETYPE THE ROW
// (cinatra#3091, wave 3 of #3087 — the resolution fix leg, convergence round).
//
// The typed promotion road already answers a confirmation with a NAMED refusal
// rather than silence. That answer travelled as far as the server action's
// result and stopped there: the picker read `ok` and said "Meaning set." for
// every outcome, so a refusal the road took care to name was still silence AT
// THE ONE PLACE IT IS OWED — the surface the person is looking at.
//
// This leaf is the whole of the translation: one refusal name in, one sentence
// out, no branching on anything else. It is pure so the sentences can be pinned
// by a unit test instead of by driving the dialog.
//
// THE MEANING IS ALWAYS SET. A promotion rides a confirmation that has already
// landed, so every sentence here is a note ON TOP of a success, never a failure
// message: it says what did NOT additionally happen and, where the person can
// act, what would change it.

/** The road's refusal names, as the server action hands them out (a plain
 *  string on the wire — an unknown name is answered generically rather than
 *  dropped, so a road that grows a refusal is never silent here). */
const NOTICES: Record<string, string> = {
  "extension-owns-no-type":
    "The file kind was not changed: this pack has no type of its own to use. Report it to the pack's publisher.",
  "no-matcher-assertion":
    "The file kind was not changed: nothing has recognised this file as that kind yet.",
  "below-threshold":
    "The file kind was not changed: the recognition of this file was not confident enough.",
  "form-not-accepted":
    "The file kind was not changed: this pack's type does not accept this file's form.",
  "no-content": "The file kind was not changed: this file has no content to carry over.",
  "row-not-found": "The file kind was not changed: this file is no longer available.",
  "not-confirmed": "The file kind was not changed: the confirmation did not reach the road.",
};

/**
 * The note to show beside "Meaning set.", or null when there is nothing to add.
 *
 * Null for a promotion that ran, for `already-promoted` (the row is ALREADY in
 * the type the person confirmed — there is nothing the person needs to know),
 * and for the absent promotion of a row the road never applied to.
 */
export function promotionRefusalNotice(
  promotion: { promoted: true } | { promoted: false; reason: string } | undefined,
): string | null {
  if (!promotion || promotion.promoted) return null;
  if (promotion.reason === "already-promoted") return null;
  return (
    NOTICES[promotion.reason] ??
    "The file kind was not changed. The meaning you chose is set."
  );
}
