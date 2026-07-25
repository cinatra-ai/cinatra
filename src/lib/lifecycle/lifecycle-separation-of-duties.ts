/**
 * SEPARATION-OF-DUTIES for lifecycle review gates (cinatra#2038, epic #2037 S0).
 *
 * On an ORG-`required` gate the PRODUCING actor cannot be the SOLE approver
 * (self-approval is allowed on OPTIONAL gates, or by explicit org opt-in). This is
 * evaluated at DECISION SUBMIT (the point that already re-validates the acting
 * actor), and repair dispatch + CMS apply are defined as LIVE re-authorization
 * points — captured context is provenance, never reusable authority.
 *
 * PURE: the eligibility rule is a total function the decision-submit re-check
 * calls with the LIVE acting actor. This module OWNS only the rule; the live
 * actor resolution is the store's job.
 */

import type { PolicyDecision } from "./lifecycle-policy";

export interface SodEvaluationInput {
  /** The lattice verdict for the gate — `separationOfDutiesRequired` is the
   * org-required-without-opt-in signal. */
  decision: Pick<PolicyDecision, "outcome" | "separationOfDutiesRequired">;
  /** The actor that PRODUCED the artifact under review. */
  producingActorId: string;
  /** The actor SUBMITTING the approval decision (the LIVE acting actor — never a
   * captured/replayed identity). */
  reviewingActorId: string;
  /** Distinct actor ids that have ALREADY approved this gate (a co-approver makes
   * the producer no longer the SOLE approver). */
  priorApproverIds?: readonly string[];
}

export type SodOutcome =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Decide whether `reviewingActorId` may submit an APPROVAL on the gate under SoD.
 *
 *   - Not an org-required gate (or org opted into self-approval) → always eligible
 *     (optional gates allow self-approval).
 *   - Org-required, reviewer ≠ producer → eligible (a distinct reviewer).
 *   - Org-required, reviewer = producer → eligible ONLY if a DISTINCT prior
 *     approver exists (the producer is then NOT the sole approver); otherwise
 *     DENIED (the producer would be the sole approver on a required gate).
 *
 * Pure + total.
 */
export function evaluateSeparationOfDuties(input: SodEvaluationInput): SodOutcome {
  if (!input.decision.separationOfDutiesRequired) {
    return { eligible: true };
  }
  if (input.reviewingActorId !== input.producingActorId) {
    return { eligible: true };
  }
  // Reviewer IS the producer on an org-required gate — eligible only if another
  // distinct actor has already approved (so the producer is not the sole approver).
  const distinctOthers = new Set(
    (input.priorApproverIds ?? []).filter((id) => id && id !== input.producingActorId),
  );
  if (distinctOthers.size > 0) {
    return { eligible: true };
  }
  return {
    eligible: false,
    reason:
      "separation of duties: the producing actor cannot be the sole approver on an org-required gate",
  };
}
