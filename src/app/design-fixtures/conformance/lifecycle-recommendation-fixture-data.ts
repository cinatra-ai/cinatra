// ---------------------------------------------------------------------------
// Fixture data for the RECOMMENDATION family (cinatra#3160, epic #3155 W4).
//
// The in-conversation lifecycle drawing draws ONE recommendation row and gives
// it THREE READINGS — the row while the question is open (the assistant's turn,
// and the reader who comes back to it before the run starts), the same row once
// the run has started, and the reader who may see the proposal but may not shape
// it. Thirteen manifest surfaces stand on those three readings: the row itself
// three times over, one chip per proposed skill in each reading, and the
// side-by-side example that draws all three at once. That is why the family is
// driven by ONE factory parameterised by READING and CHIP KIND
// (`recommendationChipDriver` / `recommendationRowDriver`,
// tests/e2e/design/conformance/contract.ts) over this data, exactly as the six
// extension listing cards are driven by `cardDriver` over
// CONFORMANCE_CARD_FIXTURES and the suggestion chips by `suggestionChipDriver`.
//
// WHY MOUNTS AND NOT MANIFEST SURFACE IDS. Same reason as the suggestion chips
// (see lifecycle-card-fixture-data.ts): the shipped row carries ONE conformance
// id for the row and identifies a chip by its SKILL ID, because one component
// serves every host that draws `recommendation_hold` and a per-surface anchor
// would have to be invented for the harness. A mount is therefore named here and
// the binding from mount+kind to manifest surface lives on the test side, in the
// driver map.
//
// THIS FILE CARRIES NO DRAWN STATE. It names the run, the reader's rights, the
// proposed skills in the protocol's own shape, and — for the reading where the
// run has already started — the run's DURABLE EVIDENCE (which skills ended up
// with a selection row). Which mark each chip then draws, whether a chip is
// pressable, what the row says while its candidates load and what it says with
// none at all are all computed by the shipped component: the third chip of the
// started reading is drawn `skipped` because the shipped `settledChipsForRow`
// derives it from an offer with no decision row, never because this file says so.
// ---------------------------------------------------------------------------

import type { ComponentProps } from "react";

import type { RunRecommendationChipRow } from "@cinatra-ai/agents/run-recommendation-chip-row";

type RunRecommendationChipRowProps = ComponentProps<typeof RunRecommendationChipRow>;

/**
 * One proposed skill, in the SHIPPED ROW'S OWN PROP TYPE — so a change to what a
 * candidate carries is a typecheck failure here rather than a fixture that
 * quietly stops resembling what the product is handed.
 */
export type LifecycleRecommendationCandidate = NonNullable<
  RunRecommendationChipRowProps["initialRecommendations"]
>[number];

/** The run's settled answer, again in the shipped row's own prop type. */
export type LifecycleRecommendationDecision = RunRecommendationChipRowProps["decision"];

/**
 * The three proposed skills the drawing names, in its own order.
 * The manifest's three chip surfaces are these three, per reading.
 */
export const LIFECYCLE_RECOMMENDATION_CHIP_KINDS = ["enrich", "draft", "schedule"] as const;

export type LifecycleRecommendationChipKind =
  (typeof LIFECYCLE_RECOMMENDATION_CHIP_KINDS)[number];

/**
 * FICTIONAL skill ids (the same discipline the rest of this harness keeps): a
 * core file may not name a real extension instance, and the row only needs a
 * plausible package-qualified id — it is what `data-skill-id` carries and what
 * the driver addresses a chip by.
 */
export const LIFECYCLE_RECOMMENDATION_SKILL_ID: Readonly<
  Record<LifecycleRecommendationChipKind, string>
> = {
  enrich: "@cinatra-test/outreach-fixture.enrich-contacts",
  draft: "@cinatra-test/outreach-fixture.draft-email",
  schedule: "@cinatra-test/outreach-fixture.schedule-send",
};

/**
 * The label each pill prints. This is the RESOLVED display name the run hands
 * the row (`RecommendedSkillForChip.name`), which is the only label that crosses
 * that boundary — the drawing's second half of the pill label, the vendor line
 * after "by", is not part of what the shipped row is given, so nothing here
 * pretends it is. See the wave's readiness note.
 */
export const LIFECYCLE_RECOMMENDATION_SKILL_NAME: Readonly<
  Record<LifecycleRecommendationChipKind, string>
> = {
  enrich: "Enrich contacts",
  draft: "Draft email",
  schedule: "Schedule send",
};

/** The run the harness rows are drawn for, and the agent that was dispatched. */
export const LIFECYCLE_RECOMMENDATION_RUN_ID = "run-conformance-3160";
export const LIFECYCLE_RECOMMENDATION_AGENT = "@cinatra-test/outreach-fixture-agent";

export const LIFECYCLE_RECOMMENDATION_CANDIDATES: readonly LifecycleRecommendationCandidate[] =
  LIFECYCLE_RECOMMENDATION_CHIP_KINDS.map((kind, index) => ({
    skillId: LIFECYCLE_RECOMMENDATION_SKILL_ID[kind],
    skillRevisionId: `rev-${kind}`,
    name: LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind],
    score: 0.9 - index * 0.1,
    rank: index + 1,
    recommended: true,
    scoredFeatures: [],
  }));

/**
 * THE RUN'S DURABLE EVIDENCE for the reading where the run has already started:
 * the skills that ended with a selection row on the run. It is an INPUT the
 * resolver reads, not a drawn state — the third skill has no row, and what the
 * row DRAWS for it is the shipped `settledChipsForRow`'s to decide.
 */
export const LIFECYCLE_RECOMMENDATION_APPLIED_KINDS: readonly LifecycleRecommendationChipKind[] = [
  "enrich",
  "draft",
];

/** The harness mounts this family draws. */
export const LIFECYCLE_RECOMMENDATION_MOUNTS = [
  /** The row in the assistant's turn, on a run held at the recommendation gate. */
  "recommendation-paused",
  /** The same live row with no candidate at all. */
  "recommendation-empty",
  /** The same live row before its candidates have been read. */
  "recommendation-loading",
  /** The drawing's side-by-side example: three readings of one row. */
  "recommendation-readings",
] as const;

export type LifecycleRecommendationMount = (typeof LIFECYCLE_RECOMMENDATION_MOUNTS)[number];

/**
 * The three readings the side-by-side mount draws, each on its own block so a
 * driver can address one of them. The names are the drawing's own.
 */
export const LIFECYCLE_RECOMMENDATION_READINGS = [
  "before-start",
  "running",
  "restricted",
] as const;

export type LifecycleRecommendationReading = (typeof LIFECYCLE_RECOMMENDATION_READINGS)[number];
