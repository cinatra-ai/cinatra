// ---------------------------------------------------------------------------
// Fixture data for the RECOMMENDATION family (cinatra#3160, epic #3155 W4).
//
// The in-conversation lifecycle drawing draws ONE recommendation row and gives
// it THREE READINGS — the row while the question is open (the assistant's turn,
// and the reader who comes back to it before the run starts), the same row once
// the run has started, and the reader who may see the proposal but may not shape
// it.
//
// WHAT THIS FILE NAMES, AFTER THE ONE-CARD CORRECTION (see the harness module's
// header). It no longer names PROPS for the row: the row has exactly one
// composer in the product, `RecommendationHoldCard`, and that card takes no
// state from its host — it RESOLVES the run's authoritative hold state itself
// and derives every prop the row is given from that answer. So what a reading
// needs is a RUN whose resolved state is that reading, and this file names the
// run identities plus, for the harness unit tier, the authoritative answer each
// one stands for — in the shipped `RunRecommendationHoldState` type, so a change
// to what the resolver returns is a typecheck failure here rather than a fixture
// that quietly stops resembling what the product is handed.
//
// WHY MOUNTS AND NOT MANIFEST SURFACE IDS. Same reason as the suggestion chips
// (see lifecycle-card-fixture-data.ts): the shipped row carries ONE conformance
// id for the row and identifies a chip by its SKILL ID, because one component
// serves every host that draws `recommendation_hold` and a per-surface anchor
// would have to be invented for the harness.
//
// THIS FILE CARRIES NO DRAWN STATE. It names the run, the reader's rights, the
// proposed skills in the protocol's own shape, and — for the reading where the
// run has already started — the run's DURABLE EVIDENCE (which skills ended up
// with a selection row). Which mark each chip then draws, whether a chip is
// pressable and what the row says with no candidate at all are all computed by
// the shipped card and the shipped row: the third chip of the started reading is
// drawn `skipped` because the shipped `settledChipsForRow` derives it from an
// offer with no decision row, never because this file says so.
// ---------------------------------------------------------------------------

import type { ComponentProps } from "react";

import type {
  RunRecommendationChipRow,
  RunRecommendationHoldState,
} from "@cinatra-ai/agents/run-recommendation-chip-row";

type RunRecommendationChipRowProps = ComponentProps<typeof RunRecommendationChipRow>;

/**
 * One proposed skill, in the SHIPPED ROW'S OWN PROP TYPE — so a change to what a
 * candidate carries is a typecheck failure here rather than a fixture that
 * quietly stops resembling what the product is handed.
 */
export type LifecycleRecommendationCandidate = NonNullable<
  RunRecommendationChipRowProps["initialRecommendations"]
>[number];

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

/** The agent that was dispatched for every run below. */
export const LIFECYCLE_RECOMMENDATION_AGENT = "@cinatra-test/outreach-fixture-agent";

export const LIFECYCLE_RECOMMENDATION_CANDIDATES: readonly LifecycleRecommendationCandidate[] =
  LIFECYCLE_RECOMMENDATION_CHIP_KINDS.map((kind, index) => ({
    skillId: LIFECYCLE_RECOMMENDATION_SKILL_ID[kind],
    skillRevisionId: `rev-${kind}`,
    name: LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind],
    vendorName: null,
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

/**
 * THE RUNS THE HARNESS MOUNTS A CARD FOR, one per reading the drawing draws.
 *
 * Distinct identities on purpose: the card files its resolved answer under the
 * run id it asked about, so two readings on one page must be two runs or the
 * second would read back the first one's answer.
 *
 * `before-start` deliberately REUSES the held run: the drawing draws that
 * reading twice (once as the assistant's turn, once inside the three-readings
 * example) and it is ONE product reading — a live parked hold — so inventing a
 * second run for it would be inventing a second product state.
 */
export const LIFECYCLE_RECOMMENDATION_RUN = {
  held: "run-conformance-3160-held",
  empty: "run-conformance-3160-empty",
  decided: "run-conformance-3160-decided",
  restricted: "run-conformance-3160-restricted",
} as const;

export type LifecycleRecommendationRunKey = keyof typeof LIFECYCLE_RECOMMENDATION_RUN;

/**
 * THE AUTHORITATIVE ANSWER each run stands for, in the resolver's own shipped
 * type. This is what `getRunRecommendationHoldStateAction` returns for a reader
 * who may see that run — it is NOT a drawn reading and NOT a prop: the card
 * derives every prop the row receives from it, and the row derives every mark,
 * line and affordance from those.
 *
 * The harness unit tier answers the card's own resolve from this map, which is
 * the one tier that can: the conformance harness route is a dev-only PUBLIC path
 * with no session, so the card's cookie-bound resolve there answers "no row for
 * this reader" and the card draws nothing. See the harness module's header.
 */
export const LIFECYCLE_RECOMMENDATION_HOLD_STATE: Readonly<
  Record<string, RunRecommendationHoldState>
> = {
  [LIFECYCLE_RECOMMENDATION_RUN.held]: {
    state: "held",
    agentPackageName: LIFECYCLE_RECOMMENDATION_AGENT,
    promptText: "Draft the outreach follow-ups for this week.",
    recommendations: [...LIFECYCLE_RECOMMENDATION_CANDIDATES],
    holdRef: "",
    canDecide: true,
  },
  [LIFECYCLE_RECOMMENDATION_RUN.empty]: {
    state: "held",
    agentPackageName: LIFECYCLE_RECOMMENDATION_AGENT,
    promptText: "Draft the outreach follow-ups for this week.",
    recommendations: [],
    holdRef: "",
    canDecide: true,
  },
  [LIFECYCLE_RECOMMENDATION_RUN.decided]: {
    state: "confirmed",
    skillNames: LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.map(
      (kind) => LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind],
    ),
    decided: LIFECYCLE_RECOMMENDATION_APPLIED_KINDS.map((kind) => ({
      skillId: LIFECYCLE_RECOMMENDATION_SKILL_ID[kind],
      name: LIFECYCLE_RECOMMENDATION_SKILL_NAME[kind],
      mark: "confirmed" as const,
    })),
    candidates: LIFECYCLE_RECOMMENDATION_CANDIDATES.map((candidate) => ({
      skillId: candidate.skillId,
      name: candidate.name,
      vendorName: candidate.vendorName,
      skillRevisionId: candidate.skillRevisionId,
      recommended: candidate.recommended,
    })),
    holdRef: "",
    runStarted: true,
    canDecide: false,
  },
  [LIFECYCLE_RECOMMENDATION_RUN.restricted]: {
    state: "held",
    agentPackageName: LIFECYCLE_RECOMMENDATION_AGENT,
    promptText: "Draft the outreach follow-ups for this week.",
    recommendations: [...LIFECYCLE_RECOMMENDATION_CANDIDATES],
    holdRef: "",
    canDecide: false,
  },
};

/** The harness mounts this family draws. */
export const LIFECYCLE_RECOMMENDATION_MOUNTS = [
  /** The card in the assistant's turn, on a run held at the recommendation gate. */
  "recommendation-paused",
  /** The same card on a held run that was offered no candidate at all. */
  "recommendation-empty",
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

/** The run whose resolved state IS each of the side-by-side readings. */
export const LIFECYCLE_RECOMMENDATION_READING_RUN: Readonly<
  Record<LifecycleRecommendationReading, string>
> = {
  "before-start": LIFECYCLE_RECOMMENDATION_RUN.held,
  running: LIFECYCLE_RECOMMENDATION_RUN.decided,
  restricted: LIFECYCLE_RECOMMENDATION_RUN.restricted,
};
