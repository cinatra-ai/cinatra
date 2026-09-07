// ---------------------------------------------------------------------------
// WHAT A RUN-SURFACE RAIL STEP IS, AND WHETHER IT CAN BE OPENED — a plain
// module, deliberately NOT "use client" (cinatra#2970).
//
// The rail's components live in `run-surface-rail.tsx`, which is a client
// module. This is the part of the rail that the SERVER screen has to evaluate:
// `instance-screens.tsx` composes the setup run page's steps and has to know,
// while it is still on the server, which of them can be opened — the row it
// draws for a closed step is a different row, and its `data-action` names a
// different thing.
//
// A NON-COMPONENT EXPORT OF A `"use client"` MODULE CANNOT BE EVALUATED ON THE
// SERVER. Turbopack compiles such a module, for the server graph, into one
// `registerClientReference(stub, id, exportName)` per export; calling that stub
// is not calling the function. `instance-screens-client-boundary.test.ts` is the
// gate that keeps every such evaluation out of the run page's server graph, and
// this module is how the predicate stays on the right side of it: no directive,
// no boundary to cross, one definition that the server screen, the client frame
// and the suites all read.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

/**
 * WHICH step the run detail is showing: one of the steps that head the rail, or
 * the run's own detail (its steps and their progress, the gate the review page
 * opened on).
 */
/**
 * A step that the rail NAMES with a word of its own: the three the ratified
 * drawing's rail carries, whose labels live in `run-surface-rail-labels.ts`.
 */
export type RunSurfaceRailLabelledKey = "recommendation" | "schedule" | "review";

/**
 * THE RUN'S OWN INPUT FORM, AS A STEP (cinatra#3068).
 *
 * Indexed rather than named, because an agent may ask several input forms in
 * sequence and each one is its own step; the label is the form's own declared
 * title, so it is carried by the step rather than looked up from the three
 * fixed words above.
 */
export type RunInputStepKey = `input:${number}`;

/**
 * A GATE THE RUN IS PAUSED ON, ARRIVING AS A TRAILING ENTRY (cinatra#3221).
 *
 * The ratified drawing, the agent run surface, the step rail: the rail lists
 * "the ordinary work steps, and -- inline at the point the run reached it -- a
 * gate entry (a Skills step to answer, a list to pick one thing from, a review
 * to decide). The step the run is paused on is highlighted."
 *
 * Three of those gates already head the rail under a word of their own: the
 * skills question, the schedule, the review. THE FOURTH DOES NOT. A run stopped
 * at a human-in-the-loop screen the agent opened mid-run -- the context
 * selection the drawing names "a list to pick one thing from" -- had no entry on
 * the rail at all, so the election below had nothing to elect and the first
 * proof round photographed a paused run with ZERO highlighted entries in both
 * palettes. It arrives at the run's live tip, which is the END of the rail, so
 * it is one key rather than one per gate: the rail carries at most one open
 * gate, because a run is stopped at one place.
 *
 * SINGULAR, AND CARRIED BY THE STEP LIKE AN INPUT FORM'S. It takes no word from
 * `run-surface-rail-labels.ts`, because the gate's own screen names it -- the
 * rail says what the step SHOWS, and the row and the card must not say two
 * different things.
 */
export type RunParkedGateStepKey = "gate";

export type RunStepSelection =
  | RunSurfaceRailLabelledKey
  | RunInputStepKey
  | RunParkedGateStepKey
  | "detail";

/** A step that HEADS the rail — every selection but the run's own detail. */
export type RunSurfaceRailStepKey = Exclude<RunStepSelection, "detail">;

/**
 * DOES THIS STEP'S ROW DRAW A GLYPH IN PLACE OF A NUMERAL? (cinatra#3047, the
 * re-shoot's third defect.)
 *
 * The ratified drawing at the capture contract's pin gives the SKILLS entry its
 * own fixed glyph on the reading where the question is still open — never a
 * numeral — and starts the rail's numerals on the step after it. Its own rail
 * illustration beside the Skills page reads `[glyph] Skills · 1 Fetch cohort ·
 * 2 Draft email`, and the fuller one reads `[glyph] Skills · 1 Fetch cohort ·
 * 2 Draft email · 3 Review · 4 Send sequence`.
 *
 * THE SCHEDULE ENTRY IS NOT ONE OF THEM, and that is measured rather than
 * assumed: every schedule illustration in the same drawing draws "1 Schedule"
 * with the run's own steps numbered under it. So exactly one step is unnumbered,
 * and the rule says which.
 */
export function runSurfaceStepDrawsGlyph(key: RunSurfaceRailStepKey): boolean {
  return key === "recommendation";
}

/**
 * THE NUMERALS A RAIL'S STEPS CARRY, in the order the page lists them: `null`
 * for a step that draws its own glyph, and 1, 2, 3 … for the rest.
 *
 * WHY THIS IS A FUNCTION RATHER THAN THREE INLINE SUMS. Three rails draw this
 * series — the run page's, the setup run page's and the review page's — and each
 * computed its own `displayStep` and its own work-step `stepOffset` from the
 * LENGTH of the gate-step list. A step that takes no numeral cannot be expressed
 * that way without all three subtracting it again, which is three places for one
 * rule and one of them to miss; the re-shoot photographed exactly that failure
 * mode from the other direction, with the Skills entry numbered "1" and the
 * run's first work step pushed to "2". There is one rule now and the three read
 * it.
 */
export function runSurfaceRailNumerals(
  keys: readonly RunSurfaceRailStepKey[],
): (number | null)[] {
  let next = 0;
  return keys.map((key) => (runSurfaceStepDrawsGlyph(key) ? null : (next += 1)));
}

/**
 * HOW MANY NUMERALS THE GATE STEPS CONSUMED — the offset the run's own work
 * steps start after. A rail whose only gate step is the Skills entry offsets its
 * work steps by NOTHING, so the first of them reads "1", which is what the
 * drawing shows and what the re-shoot did not.
 */
export function runSurfaceRailNumberedCount(
  keys: readonly RunSurfaceRailStepKey[],
): number {
  return keys.filter((key) => !runSurfaceStepDrawsGlyph(key)).length;
}

/** A step that heads the rail: its row, and the surface it opens onto. */
export type RunSurfaceRailStep = {
  /** The selection value this step answers to. */
  key: RunSurfaceRailStepKey;
  /** The rail ROW. Drawn inside the rail column, above the page's own rows. */
  row: ReactNode;
  /**
   * The step's own surface, drawn in the run detail while this step is open.
   *
   * NULLISH (`null` or `undefined`) means this step HAS no surface of its own,
   * and the run detail stays as the page composed it. `ReactNode` already admits
   * both, which is why the sentinel is stated as nullish rather than narrowed to
   * `null` — a narrower type here would be a claim the type system does not make.
   *
   * It was the settled recommendation on the branch whose PANEL drew the card
   * (cinatra#2790, S9f) that first needed it: the entry kept its place on the
   * rail as read-only history while the reading it would open onto was already
   * inside the run detail beside it, so handing it the card a second time would
   * have been a second mount of the one renderer. That branch is gone — the row
   * has one owner and one place, so every recommendation step now carries its own
   * surface (cinatra#3047) — and the sentinel stands for the steps that still
   * need it. The fallback is why the run detail EMPTIES into nothing: a row
   * resolving to what is already on screen would blank the column instead.
   *
   * Where there IS no fallback — a page that composes no run detail of its own,
   * which is the setup run page — a nullish surface has nothing left to fall
   * back to, and the step is closed instead of opening an empty column. That is
   * `isRunSurfaceStepSelectable`, and it is why this field alone is not the
   * whole answer.
   */
  surface: ReactNode;
  /**
   * Has the run REACHED this step? Drives the row's reached/upcoming reading,
   * and closes the row when it is explicitly `false`.
   *
   * `undefined` is a THIRD answer and not a synonym for either: the page has not
   * read it, so it claims nothing and the row is drawn plainly and stays
   * openable. Turning silence into "still ahead" would close a row on a guess.
   */
  reached?: boolean;
  /**
   * HAS THIS STEP'S GATE BEEN ANSWERED? Drives the row's resolved-gate history
   * reading (cinatra#2975): the completed circle in place of the numeral, the
   * title unhighlighted.
   *
   * The ratified drawing: "A resolved gate stays on the rail as read-only
   * history — its entry keeps its place and records how it was settled." Named
   * as `recommendation-rail-entry.ts` names it, because it IS that module's
   * `settled` reading arriving at the row the setup page draws.
   *
   * It says nothing about whether the row can be OPENED — a settled row opens
   * exactly what the page gave it — and it is not implied by `reached`: a hold
   * that expired undecided is terminal without anybody having answered it, and a
   * completed circle there would record a decision that was never taken.
   */
  settled?: boolean;
  /**
   * Can this step be opened at all, whatever the two fields above say? The
   * page's own override, for a step whose openability it reads from something
   * neither of them carries. Defaults to unstated, which is not "no".
   */
  selectable?: boolean;
};

/**
 * IS THIS STEP SELECTABLE? (cinatra#2970.)
 *
 * A step with nothing to open can only produce an empty run detail, and
 * cinatra#2970 rules that out: "the right column never shows an empty step
 * surface." Three facts decide it, and nothing is inferred beyond them:
 *
 *   • the page did not close the row itself (`selectable: false`);
 *   • and, WHERE THE PAGE READ IT, the run has reached the step
 *     (`reached: false` closes it; unstated claims nothing and leaves it open);
 *   • and there is something to draw — the step's OWN surface, or, failing
 *     that, the run detail the page composed for the frame to fall back to.
 *
 * THE FALLBACK IS WHY THE THIRD CLAUSE IS NOT JUST "has a surface". A step may
 * legitimately carry NO surface where its reading is already inside the run
 * detail beside it, so opening that row falls back to the run detail and shows
 * exactly the right thing. (The case this was written for — the settled
 * recommendation on the branch whose panel drew the card, cinatra#2790 — is gone
 * with that panel's mount, cinatra#3047.) It is the page with no run detail at
 * all — the setup run page — where a nullish surface has nothing behind it, and
 * there the row closes.
 *
 * WHAT THIS CANNOT SEE, stated rather than assumed. "Something to draw" is as
 * far as a frame can look. A surface that is a component ELEMENT is a non-null
 * value however the component itself later resolves, so a step whose surface
 * renders nothing on the client can still open an empty column. That is why the
 * setup page reads the run's own rows for the recommendation and the review and
 * hands the frame `reached` — the frame refuses what it can see, and the page
 * answers what only the page can.
 */
export function isRunSurfaceStepSelectable(
  step: Pick<RunSurfaceRailStep, "surface" | "reached" | "selectable">,
  detail: ReactNode,
): boolean {
  if (step.selectable === false) return false;
  if (step.reached === false) return false;
  return runSurfaceNodeExists(step.surface) || runSurfaceNodeExists(detail);
}

/** Nullish (and `false`) is "nothing drawn"; every other ReactNode is something. */
export function runSurfaceNodeExists(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false;
}

/**
 * The selection a wanted one resolves to: the wanted one when it can be opened,
 * otherwise the first row of the rail that can be, otherwise the run detail.
 * Kept beside the predicate so first paint, the server's answer and every press
 * ask the same question the same way.
 */
export function resolveRunSurfaceSelection(
  steps: readonly RunSurfaceRailStep[],
  detail: ReactNode,
  want: RunStepSelection,
): RunStepSelection {
  if (want === "detail") return "detail";
  const named = steps.find((step) => step.key === want);
  if (named && isRunSurfaceStepSelectable(named, detail)) return want;
  return steps.find((step) => isRunSurfaceStepSelectable(step, detail))?.key ?? "detail";
}
