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
// and the wrong question about the ENTRY. On the branch whose panel drew the
// card (`agentic`), a held run that was DECIDED leaves `pending_input`, the
// screen stopped hosting the card, and the entry disappeared from the rail
// altogether — taking the two-column frame with it, since the recommendation
// was the run's only gate step. The settled history row the drawing requires
// was then drawn nowhere.
//
// AND WHY THE SECOND HALF IS GONE ENTIRELY (cinatra#3047). The question "does
// the screen host the card on this branch?" had an answer only while a SECOND
// module could draw it: the run panel mounted its own copy on the `agentic`
// branch, so the row moved between two placements as the run advanced. The
// panel's mount is deleted; the screen/frame owns the row on every branch, so
// the step's surface is always this screen's own mount and the entry reads off
// the park alone.
// ---------------------------------------------------------------------------

/**
 * The three readings the recommendation can have on the rail.
 *
 * - `none`   — no entry at all.
 * - `live`   — the step the run is paused on; it opens the gate's own surface.
 * - `settled` — the resolved-gate history row: the completed circle in place of
 *   the numeral and the title unhighlighted. It opens the same read-only card
 *   the live row opens, because one owner draws the row in one place
 *   (cinatra#3047).
 */
export type RecommendationRailEntry = "none" | "live" | "settled";

/**
 * Does the run's rail carry a recommendation entry, and how does it read?
 *
 * - `hasPark` — the run has a `recommendation_hold` park row. That row IS the
 *   run's own evidence that this question was ever asked; a run without one
 *   never held and has no step (its card draws no DOM at all).
 * - `held` — the park is still `parked`, i.e. the question is open.
 *
 * A LIVE hold is the step the run is paused on, and it opens the screen's own
 * mount of the card. A SETTLED hold is an entry too, because a history row needs
 * no surface to justify its place — which is exactly what the old rule got
 * wrong — and it opens the same mount's read-only summary.
 *
 * THERE IS NO THIRD INPUT (cinatra#3047). A `hostsCard` parameter used to
 * withhold the LIVE entry on the branch whose panel drew the card, because a
 * step must never open onto a card another module draws. No other module draws
 * it: the run page has ONE owner of this row on every branch, so the park is the
 * whole reading.
 */
export function recommendationRailEntry(params: {
  hasPark: boolean;
  held: boolean;
}): RecommendationRailEntry {
  if (!params.hasPark) return "none";
  return params.held ? "live" : "settled";
}

/**
 * CAN THE ROW BE OPENED — on a page that has nothing to fall back to?
 *
 * The entry above answers whether the row EXISTS. That is enough for the run
 * page, which composes a run detail the frame falls back to. It is not enough
 * for the setup run page (cinatra#2970), which composes no run detail at all:
 * there a row that opens onto a card drawing no DOM opens an EMPTY COLUMN,
 * which the ruling on that issue forbids.
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
 * WHY THE STATUS AND NOT THE EVIDENCE, AND WHERE THE STATUS IS NOT ENOUGH. The
 * decision's evidence — the run's selected revisions, its skip record — belongs
 * to the card, which is the one authority on this interaction (cinatra#2573),
 * and a screen that read it back to draw around it is the parallel derivation
 * the one-renderer rule retired. So the park's own status answers this for every
 * ordinary run, and it is the same read that decides the entry exists at all.
 *
 * THE ONE CASE THE STATUS GETS WRONG (cinatra#3047, convergence). A confirm or a
 * skip that RACES THE TTL SWEEPER leaves a `policy_unresolved` park with real
 * evidence behind it — the status and the evidence are not written atomically —
 * and the card reads that run as DECIDED and draws its settled row. A status-only
 * answer closes the step over a card that would have drawn, so the reader is
 * shown a settled history row on the rail whose press does nothing and whose
 * answer is nowhere on the page. `decided` is that run's own answer, and it has
 * exactly one definition: `recommendationDecidedForRun`, the same ladder the
 * card applies, asked by the SERVER caller that already holds the run id and has
 * cleared its access door. It is optional because a caller with no run id to ask
 * with states nothing, and stating nothing keeps the status-only reading.
 */
export function recommendationRailStepOpens(params: {
  entry: RecommendationRailEntry;
  parkStatus: string | null | undefined;
  /** Did this run's own evidence record an answer? `recommendationDecidedForRun`
   *  is the one definition; omit it to leave the status-only reading. */
  decided?: boolean;
}): boolean {
  if (params.entry === "live") return true;
  if (params.entry !== "settled") return false;
  return params.parkStatus === "released" || params.decided === true;
}
