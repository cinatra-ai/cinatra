// ---------------------------------------------------------------------------
// IS THERE A RECOMMENDATION ENTRY ON THE RUN SURFACE'S RAIL, AND HOW DOES IT
// READ? (cinatra#2790, epic #2784 S9f)
//
// The ratified run-surface drawing (`design-run-surface-rail-and-gate.png`):
// "A resolved gate stays on the rail as read-only history — its entry keeps its
// place and records how it was settled."
//
// WHY THIS IS ITS OWN MODULE, with no imports at all. The answer is read by the
// run screen (a server module reaching the database) and rendered by the rail
// row (a client component), and it is pinned by tests in BOTH environments. A
// predicate living in either of those files can only be exercised through that
// file's whole import graph; here it is the plain function it actually is.
//
// THE DEFECT THIS CLOSES. The entry's existence used to be `park !== null &&
// the screen hosts the card`. That second half is the right question about the
// step's SURFACE — a step must never open onto a card another module draws —
// and the wrong question about the ENTRY. On the branch whose panel draws the
// card (`agentic`), a held run that was DECIDED leaves `pending_input`, the
// screen stops hosting the card, and the entry disappeared from the rail
// altogether — taking the two-column frame with it, since the recommendation
// was the run's only gate step. The settled history row the drawing requires
// was then drawn nowhere.
// ---------------------------------------------------------------------------

/**
 * The three readings the recommendation can have on the rail.
 *
 * - `none`   — no entry at all.
 * - `live`   — the step the run is paused on; it opens the gate's own surface.
 * - `settled` — the resolved-gate history row: the completed circle in place of
 *   the numeral and the title unhighlighted. What it OPENS is the branch's
 *   answer, not this one's: where the screen hosts the card the settled row
 *   opens that read-only card; where the panel draws it the row has no surface
 *   of its own and the run detail stays put.
 */
export type RecommendationRailEntry = "none" | "live" | "settled";

/**
 * Does the run's rail carry a recommendation entry, and how does it read?
 *
 * - `hasPark` — the run has a `recommendation_hold` park row. That row IS the
 *   run's own evidence that this question was ever asked; a run without one
 *   never held and has no step (its card draws no DOM at all).
 * - `held` — the park is still `parked`, i.e. the question is open.
 * - `hostsCard` — does the SCREEN mount the one `recommendation_hold` card, or
 *   does the run-detail panel mount it (`screenHostsRecommendationCard`)?
 *
 * A LIVE hold is a step only where the screen owns the surface it opens onto;
 * elsewhere the step would open onto nothing, so there is no entry. (That case
 * is unreachable in practice — a held run is `pending_input`, which is the
 * branch where no panel renders — and it is answered here rather than assumed.)
 *
 * A SETTLED hold is an entry on EVERY branch, because a history row needs no
 * surface to justify its place — which is exactly what the old rule got wrong.
 * It does NOT follow that a settled row opens nothing: where the screen hosts
 * the card, the row still opens that card's read-only summary, unchanged. It is
 * on the PANEL-hosted branch that it opens nothing, and there the run detail
 * keeps what the panel draws — where the decided summary already is.
 */
export function recommendationRailEntry(params: {
  hasPark: boolean;
  held: boolean;
  hostsCard: boolean;
}): RecommendationRailEntry {
  if (!params.hasPark) return "none";
  if (params.held) return params.hostsCard ? "live" : "none";
  return "settled";
}

/**
 * CAN THE ROW BE OPENED — on a page that has nothing to fall back to?
 *
 * The entry above answers whether the row EXISTS. That is the right question
 * for the run page, where a settled row deliberately opens nothing and the run
 * detail beside it stays put. It is not enough for the setup run page
 * (cinatra#2970), which composes no run detail at all: there a row that opens
 * nothing opens an EMPTY COLUMN, which the ruling on that issue forbids.
 *
 * `parkStatus` is the park's own row status, and the third value is why this
 * function exists. `parked` is a live hold and `released` is a decision a human
 * took — the card draws in both. `policy_unresolved` is what the TTL sweeper
 * leaves behind when a hold expires undecided: the park is terminal, so the
 * entry above reads it as `settled`, and yet NOBODY DECIDED — there are no
 * selected revisions and no skip on file, so `resolveRecommendationHoldStateForActor`
 * answers `none` and the card renders no DOM at all.
 *
 * The row still stands on the rail for such a run, named and numbered; it is
 * simply closed and muted, which is what the rail says about a step that has
 * nothing to show.
 *
 * WHY THE STATUS AND NOT THE EVIDENCE. The decision's evidence — the run's
 * selected revisions, its skip record — belongs to the card, which is the one
 * authority on this interaction (cinatra#2573). A screen that read it back to
 * draw around it is the parallel derivation the one-renderer rule retired. The
 * park's own status is a fact about the RAIL's entry, and it is the same read
 * that decides the entry exists at all.
 */
export function recommendationRailStepOpens(params: {
  entry: RecommendationRailEntry;
  parkStatus: string | null | undefined;
}): boolean {
  if (params.entry === "live") return true;
  if (params.entry !== "settled") return false;
  return params.parkStatus === "released";
}
