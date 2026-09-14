// ---------------------------------------------------------------------------
// The REVIEW-TARGET and DECISION-FLOOR surfaces of the artifact-review drawing
// (cinatra#3163, epic #3155 W7).
//
// One row per manifest surface this wave covers, carrying exactly what the
// ratified drawing declares for it — the fields and their sources, the actions
// and their outcomes, the state variants — plus the two parameters the family
// factory is built around (the gate state §VII names, and the provenance tier §V
// draws) and, where the surface is not on the default branch yet, what it is
// waiting for.
//
// WHY THE ROWS LIVE IN THEIR OWN FILE. contract.ts is a Playwright module: it
// cannot be read by the ordinary node unit tier. These rows are the wave's
// COVERAGE RECORD as much as they are driver input — "every surface listed in
// the wave has a driver, the two the branch actually draws are driven for real,
// and the rest say what they wait for" is a claim a unit test has to be able to
// check without opening a browser
// (scripts/design/__tests__/conformance-review-decision-wave.test.mjs). So the
// rows are pure data here, with no Playwright import, and contract.ts builds the
// driver map FROM them — being in this list IS being in the map.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR AND NO ASSERTION. It carries the
// drawing's own declarations, keyed by the manifest surface they belong to. The
// assertions are contract.ts's; the manifest is the contract they are reconciled
// against by the suite itself.
// ---------------------------------------------------------------------------

/** The manifest surfaces this wave covers. */
export const REVIEW_DECISION_FLOOR_SURFACES = [
  "review-target",
  "review-provenance-native",
  "review-provenance-marketplace",
  "review-target-floor",
  "review-decision-bar",
  "review-prompt-window",
  "review-decision-disabled",
  "review-gate-loading",
  "review-gate-blocked",
  "per-run-conversation",
  "per-run-conversation-pending",
  "per-run-conversation-empty",
  "prompt-window-readings",
  "promotion-confirm",
  "promoted-row-state",
] as const;

export type ReviewDecisionFloorSurfaceId = (typeof REVIEW_DECISION_FLOOR_SURFACES)[number];

export type ReviewDecisionFloorField = { readonly name: string; readonly source: string };
export type ReviewDecisionFloorAction = { readonly name: string; readonly outcome: string };

/** The three readings §VII names for a gate that cannot simply be decided. */
export type ReviewDecisionFloorGateState = "loading" | "blocked" | "disabled";

/** The three readings §V draws for how a target's renderer resolved. */
export type ReviewDecisionFloorProvenance = "native" | "marketplace" | "floor";

export type ReviewDecisionFloorRow = {
  /** The manifest surface id — and the harness mount's `data-surface-id`. */
  readonly surface: ReviewDecisionFloorSurfaceId;
  /** The section of the drawing this surface is drawn in. */
  readonly section: string;
  /**
   * The conformance id the surface's own panel carries, or `null` where the
   * drawing's reading of the surface is an ABSENCE rather than a drawn region.
   *
   * §V is the reason the second case exists: a build-time renderer and a runtime
   * one "are drawn the same way, because nothing on either target says which
   * resolved it", so a drawn anchor of their own would be the provenance line
   * the drawing forbids in the same sentence. Those two surfaces are read on the
   * target they render, and what is asserted about them is what is NOT there.
   */
  readonly anchor: string | null;
  /** Which gate reading this surface is, for the family factory's first
   *  parameter. `null` for every surface §VII does not name. */
  readonly gateState: ReviewDecisionFloorGateState | null;
  /** Which provenance reading this surface is, for the family factory's second
   *  parameter. `null` for every surface outside §V's three. */
  readonly provenance: ReviewDecisionFloorProvenance | null;
  /**
   * TRUE where this wave's harness mount draws the surface with the SHIPPED
   * component, so its driver runs for real on every boot. FALSE where the
   * surface is not drawable on the default branch — those drivers are written in
   * full and SKIP with `readiness` until a mount exists.
   */
  readonly mounted: boolean;
  /** The fields the manifest binds on this surface, in the manifest's order. */
  readonly fields: readonly ReviewDecisionFloorField[];
  /** The actions the manifest declares, in the manifest's order. */
  readonly actions: readonly ReviewDecisionFloorAction[];
  /** The state variants the manifest declares, in the manifest's own order. */
  readonly states: readonly string[];
  /**
   * The open pull request that lands the affordances this surface declares and
   * the default branch does not have. `null` everywhere else — a surface waiting
   * on work nobody has opened may not borrow another surface's landing.
   */
  readonly awaitingPullRequest: number | null;
  /**
   * What this surface is waiting for on the default branch, named on every
   * skipped test. Grounded by reading the shipped tree, never assumed. `null`
   * exactly where `mounted` is true — a surface that is drawn waits for nothing.
   */
  readonly readiness: string | null;
};

export const REVIEW_DECISION_FLOOR: Readonly<
  Record<ReviewDecisionFloorSurfaceId, ReviewDecisionFloorRow>
> = {
  "review-target": {
    surface: "review-target",
    section: "IV",
    anchor: "review-target",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [{ name: "name", source: "type.displayName" }],
    actions: [],
    states: ["error", "loading"],
    awaitingPullRequest: null,
    readiness:
      "the panel that carries this anchor and this binding IS on the default branch, but it is a server-only module whose representation slot mounts a real type renderer through the shared target mount: a core fixture drawing it would name a real extension instance, which the core/extension instance-coupling ban exists to stop. Its two declared readings are drawn by the gate around it rather than by the panel, so the mount this driver waits for is a target mount the harness may draw without an extension instance",
  },
  "review-provenance-native": {
    surface: "review-provenance-native",
    section: "V",
    anchor: null,
    gateState: null,
    provenance: "native",
    mounted: false,
    fields: [],
    actions: [],
    states: ["error", "loading"],
    awaitingPullRequest: null,
    readiness:
      "the shipped surface model resolves a build-time renderer to NO region at all, which is exactly what the drawing requires — the resolution is not put on screen, and a build-time renderer and a runtime one are drawn the same way — so what this surface claims is an absence on a rendered target, and the target it must be read on is the one the review-target row is waiting for",
  },
  "review-provenance-marketplace": {
    surface: "review-provenance-marketplace",
    section: "V",
    anchor: null,
    gateState: null,
    provenance: "marketplace",
    mounted: false,
    fields: [],
    actions: [],
    states: ["error", "loading"],
    awaitingPullRequest: null,
    readiness:
      "the shipped surface model resolves a runtime, marketplace-installed renderer to NO region either, for the same sentence of the drawing, so this surface is the same absence read on the other tier — and it needs the same target mount before an absence read on it means anything",
  },
  "review-target-floor": {
    surface: "review-target-floor",
    section: "V",
    anchor: "review-target-floor",
    gateState: null,
    provenance: "floor",
    mounted: false,
    fields: [],
    actions: [],
    states: ["error"],
    awaitingPullRequest: null,
    readiness:
      "the floor's region ships and is the ONE region the drawing keeps on screen, but it is drawn inline inside the server-only target panel and only for the floor mount kind — it is not separately exported, so it cannot be drawn without that panel and the extension-instance coupling the panel brings",
  },
  "review-decision-bar": {
    surface: "review-decision-bar",
    section: "VI",
    anchor: "review-decision-bar",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [
      { name: "comment-review", outcome: "annotated" },
      { name: "regenerate-review", outcome: "successor-gate-opened" },
      { name: "continue-review", outcome: "resolved" },
    ],
    states: [],
    awaitingPullRequest: 3100,
    readiness:
      "the bar ships and carries this anchor, and one of its three affordances ships under the drawing's own name (comment-review to annotated); the other two do not — the default branch draws reject-review and approve-review where the drawing draws Regenerate and Continue, and those two land with open pull request 3100. The mount is refused for a second reason that does not expire with that landing: the repository's one-card gate bans composing the decision bar anywhere but the card and the bar's own module, and a conformance harness is exactly such a second place — the foundational wave of this epic moved its own proof off the floor for that reason",
  },
  "review-prompt-window": {
    surface: "review-prompt-window",
    section: "VI",
    anchor: "review-prompt-window",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [{ name: "request-changes", outcome: "changes-requested" }],
    states: ["loading"],
    awaitingPullRequest: null,
    readiness:
      "the window ships on the default branch and carries this anchor together with the drawing's own action and outcome, since the change that moved it into the review gate card landed. It is drawn INSIDE that card: mounting it composes the decision floor the one-card gate keeps to one place, and its submit is a server action on a fenced gate that a harness would have to stand in for — a transport substitution this road forbids",
  },
  "review-decision-disabled": {
    surface: "review-decision-disabled",
    section: "VII",
    anchor: "review-decision-disabled",
    gateState: "disabled",
    provenance: null,
    mounted: false,
    fields: [],
    actions: [],
    states: ["loading"],
    awaitingPullRequest: null,
    readiness:
      "the one-line reason ships and carries this anchor, but it is drawn inside the decision bar's own module and only beneath its affordances, so it cannot be drawn without composing the bar — which the one-card gate keeps to the card and to that module",
  },
  "review-gate-loading": {
    surface: "review-gate-loading",
    section: "VII",
    anchor: "review-gate-loading",
    gateState: "loading",
    provenance: null,
    mounted: true,
    fields: [],
    actions: [],
    states: ["loading"],
    awaitingPullRequest: null,
    readiness: null,
  },
  "review-gate-blocked": {
    surface: "review-gate-blocked",
    section: "VII",
    anchor: "review-gate-blocked",
    gateState: "blocked",
    provenance: null,
    mounted: true,
    fields: [],
    actions: [],
    states: ["error"],
    awaitingPullRequest: null,
    readiness: null,
  },
  "per-run-conversation": {
    surface: "per-run-conversation",
    section: "IX",
    anchor: "per-run-conversation",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [],
    states: ["empty", "loading"],
    awaitingPullRequest: null,
    readiness:
      "the panel that draws the exchange ships and draws it as turns, but it carries no conformance anchor for this surface at all; it portals into the page's own main element, and its parent owns both the exchange and the request that fills it, so a harness mount would have to stand in for that transport",
  },
  "per-run-conversation-pending": {
    surface: "per-run-conversation-pending",
    section: "IX",
    anchor: "per-run-conversation-pending",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [],
    states: [],
    awaitingPullRequest: null,
    readiness:
      "the shipped panel does draw the waiting turn the drawing describes — the word beneath the last bubble, on the assistant's side, and not a bubble — but carries no anchor for it, and the reading exists only while a request its parent owns is in flight",
  },
  "per-run-conversation-empty": {
    surface: "per-run-conversation-empty",
    section: "IX",
    anchor: "per-run-conversation-empty",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [],
    states: [],
    awaitingPullRequest: null,
    readiness:
      "the drawing's empty reading is the field alone with no panel above it, and the shipped panel behaves that way — so what has to be addressed is an absence, and there is no anchor on the branch to read it against on a mount whose parent owns the exchange",
  },
  "prompt-window-readings": {
    surface: "prompt-window-readings",
    section: "X",
    anchor: "prompt-window-readings",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [],
    states: [],
    awaitingPullRequest: null,
    readiness:
      "the five sentences ship, one per surface, resolved in the window's own module from the surface a mount declares — but nothing carries an anchor for this surface, and the review reading is drawn inside the gate card the one-card gate keeps to one place",
  },
  "promotion-confirm": {
    surface: "promotion-confirm",
    section: "XI.10",
    anchor: "promotion-confirm",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [],
    actions: [{ name: "confirm-promotion", outcome: "row-promoted" }],
    states: ["error", "kind:artifact", "loading"],
    awaitingPullRequest: null,
    readiness:
      "no confirmation that promotes a matched upload exists in the tree: nothing declares this action and this outcome, and no matcher assertion reaches a person's confirmation on any surface, so there is nothing yet on which to prove that nothing is re-typed without one",
  },
  "promoted-row-state": {
    surface: "promoted-row-state",
    section: "XI.10",
    anchor: "promoted-row-state",
    gateState: null,
    provenance: null,
    mounted: false,
    fields: [{ name: "type", source: "representation.claiming-type" }],
    actions: [],
    states: ["error", "kind:artifact", "loading"],
    awaitingPullRequest: null,
    readiness:
      "no row draws the Promoted reading and nothing binds a claiming type anywhere in the tree — promotion itself is not shipped, so the row that would say what happened, and the base it came from, cannot be drawn",
  },
};

/** The rows, in the wave's own declared order. */
export const REVIEW_DECISION_FLOOR_ROWS: readonly ReviewDecisionFloorRow[] =
  REVIEW_DECISION_FLOOR_SURFACES.map((id) => REVIEW_DECISION_FLOOR[id]);
