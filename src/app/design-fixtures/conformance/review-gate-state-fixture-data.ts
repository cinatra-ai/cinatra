// ---------------------------------------------------------------------------
// Fixture data for the REVIEW GATE STATES this wave draws (cinatra#3163, epic
// #3155 W7).
//
// Two of the fifteen surfaces in the review-target / decision-floor family are
// drawable on the default branch exactly as the product draws them: the gate's
// LOADING skeleton and its BLOCKED panel. Both are props-only components of the
// one review renderer, and neither is the decision floor — the repository's
// one-card gate bans composing the decision BAR outside the card and its own
// module, and says in the same place that the blocked panel is deliberately NOT
// banned, because the review page already uses the shipped component for its own
// route-level absence. So these two, and only these two, get a real mount here.
//
// A ROW NAMES A SURFACE AND A READING, AND NOTHING ELSE. No title, no body, no
// reason copy: what a blocked gate says, and which words it says it in, are
// resolved by the product from the closed blocked axis. If a row ever grew a
// string, the harness would be drawing the surface instead of mounting it.
// ---------------------------------------------------------------------------

import type { ReviewBlockedReason } from "@/lib/artifacts/review-surface-model";

/**
 * The blocked reading this harness draws, from the CLOSED SET the surface model
 * owns. The drawing's own worked example for section VII is the "no longer
 * pending" one ("The gate was already decided or the run moved on"), so that is
 * the reason drawn here; the driver asserts membership of the closed set rather
 * than this one value, because the drawing fixes the set and not the pick.
 */
export const REVIEW_GATE_BLOCKED_FIXTURE_REASON: ReviewBlockedReason = "no-longer-pending";

/** The manifest surfaces this wave's harness mount draws. */
export const REVIEW_GATE_STATE_SURFACES = ["review-gate-loading", "review-gate-blocked"] as const;

export type ReviewGateStateSurface = (typeof REVIEW_GATE_STATE_SURFACES)[number];

export type ReviewGateStateFixture = {
  /** The manifest surface id, carried as `data-surface-id`. */
  surface: ReviewGateStateSurface;
  /**
   * The reading this mount draws, carried as `data-variant`. "populated" is the
   * surface's own root (what the driver's `present` reads); the other value is
   * the state variant the manifest declares for it.
   */
  variant: string;
};

/**
 * One mount per (surface, reading). The manifest gives the loading skeleton one
 * state ("loading") and the blocked panel one ("error"), and each of the two
 * surfaces is ITSELF that reading — the component has no second face — so the
 * populated root and the state variant draw the same shipped component. That is
 * the honest shape here: inventing a second face to make the two mounts differ
 * would be the harness drawing something the product does not.
 */
export const REVIEW_GATE_STATE_FIXTURES: readonly ReviewGateStateFixture[] = [
  { surface: "review-gate-loading", variant: "populated" },
  { surface: "review-gate-loading", variant: "loading" },
  { surface: "review-gate-blocked", variant: "populated" },
  { surface: "review-gate-blocked", variant: "error" },
];
