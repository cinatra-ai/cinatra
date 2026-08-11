// ---------------------------------------------------------------------------
// The UNTRUSTED-TEXT surfaces of the hosted confirmation window (cinatra#2575,
// epic #2564 S8b — the horizontal residual of codex round 2).
//
// WHAT THIS MODULE IS. Two paragraphs of the confirmation window carry text that
// somebody other than the reader chose: the SUBJECT (built from artifact titles)
// and the RATIONALE (the message being confirmed). Both live here, behind one
// layout contract, because both fail the same way and the assertion that pins
// them should not have to be written twice.
//
// WHAT ROUND 2 FIXED AND WHAT IT LEFT. Round 2 removed the inner
// `max-h-56 overflow-y-auto` box, so a long message can no longer hide its
// ending BELOW the fold: the message occupies the page and Confirm sits after it
// in document order, so reaching the button means scrolling past the whole
// thing. That closed the vertical axis and only the vertical axis.
//
// THE HORIZONTAL AXIS WAS STILL OPEN. `whitespace-pre-wrap` wraps at ordinary
// soft-wrap opportunities — spaces, newlines. A single unbroken run offers none,
// so the line extends as far as it likes; the app's global
// `html { overflow-x: hidden }` then CLIPS the overflowing suffix rather than
// letting the page scroll to it, and Confirm stays perfectly reachable. That is
// round 2's exploit rotated ninety degrees: a benign opening, the consequential
// ending pushed somewhere the person will not read, and a click that authorizes
// text nobody saw.
//
// THE SUBJECT IS THE WORSE HALF, which is why it is here and not only the
// rationale (codex wrap-round 1, finding 1). The window's whole answer to
// substitution is that it NAMES what is being decided — the site holds the
// widget bearer, so it can open this window on any gate the person may read, and
// the subject line plus the reference code are what let them notice. That label
// is assembled from artifact TITLES, which the requester chose, and capped at
// `SUBJECT_MAX_CHARS` (400) rather than sanitized for wrappability. An unbroken
// 400-character title whose distinguishing suffix is clipped defeats exactly the
// affordance the subject exists to provide, so it wraps for the same reason and
// under the same contract.
//
// WHY `wrap-anywhere` AND NOT `break-words`. They are not interchangeable here.
// `break-words` (`overflow-wrap: break-word`) introduces break opportunities for
// PAINTING only — per CSS Text, the breaks it creates are explicitly NOT
// considered when computing min-content intrinsic size. These paragraphs are
// grid items, whose default `min-width: auto` floors them at min-content, so an
// unbroken run still widens the track and still overflows. `wrap-anywhere`
// (`overflow-wrap: anywhere`) is the one whose breaks DO count toward
// min-content, so the track can shrink and the text wraps for real. The
// distinction is the whole fix; a future edit that "simplifies" this to
// `break-words` reopens the defect, which is why the structural assertion names
// the utility rather than merely forbidding overflow.
//
// THE CONTRACT THIS MODULE OWES, enforced in
// `widget-decision-confinement.test.ts` and re-checked at render in
// `__tests__/widget-decision-text.test.tsx`:
//
//   · EVERY element here wraps (`wrap-anywhere`) — which keeps the module
//     leaf-only, since a layout wrapper could not honestly claim it;
//   · NO element carries anything that hides characters, in either axis: no
//     scroll or clip region, no height or width cap, no clamp, no ellipsis, no
//     `nowrap`;
//   · NO inline `style` and NO `dangerouslySetInnerHTML`, so the class contract
//     above cannot be sidestepped by a route the class assertion cannot see
//     (codex wrap-round 1, finding 2).
//
// NOTHING HERE IS A SECRET. Both strings are things the deciding person is being
// asked to stand behind; the window's job is to show all of both.
// ---------------------------------------------------------------------------

/**
 * WHAT is being decided — titles and type, assembled server-side.
 *
 * Attacker-influenceable (the requester chose the titles) and the window's
 * primary defence against a substituted gate, so it must be shown in full.
 */
export function WidgetDecisionSubject({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-6 wrap-anywhere text-foreground">
      {text}
    </p>
  );
}

/**
 * The WHOLE decision rationale, never an excerpt and never truncated.
 *
 * `text` is rendered as a text child, so React escapes it — the message is
 * shown, never interpreted.
 */
export function WidgetDecisionRationale({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
      {text}
    </p>
  );
}
