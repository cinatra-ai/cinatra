import "server-only";

// ---------------------------------------------------------------------------
// Run-start recommendation HOLD/RELEASE (cinatra#2067, epic #2037 C3).
//
// The pre-execution hold that finishes the #2041 S3 chip-row surface: a
// HUMAN-PRESENT run PARKS at the run-start recommendation interception (reusing
// the S0 parked-continuation machinery) until the human confirms / adjusts /
// skips the recommended skill set; the decision RELEASES the park and the run
// dispatches. A HEADLESS run NEVER reaches here (the interactive run-start seams
// are the only callers, and `run.humanPresent` gates it a second time), so the
// S3 headless auto-apply path stays byte-identical.
//
//   maybeHoldRunForRecommendation — the pre-dispatch decision. Evaluates the
//     recommendation checkpoint with the SAME lattice the headless path uses
//     (`evaluatePolicy`, humanPresent:true) + the org rule + the agent manifest.
//     Parks ONLY when the checkpoint fires AND the request-aware scorer returns
//     at least one candidate; a policy-forbidden / policy-skipped / empty-
//     candidate run returns `held:false` and the caller dispatches normally
//     (issue #2067 item 3 — the row appears only when the checkpoint fires).
//   readRecommendationParkForRun — the run's recommendation park (parked or
//     released), the chip-row's appearance discriminator in the run view.
//   releaseRecommendationParkForRun — release the park via the S0 sweeper when
//     the human decides (confirm/adjust/skip); a no-op when no live park exists.
//
// The park's protected effect is `none`: this holds the RUN's own execution
// (pre-dispatch), not a downstream external effect, so there is nothing to
// fail-closed-block — an abandoned held run simply stays an un-dispatched
// pending_input run (exactly today's abandoned-setup behavior).
// ---------------------------------------------------------------------------

import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import { evaluateThenPark } from "@/lib/lifecycle/lifecycle-continuation";
import { isRecommendationChipRowHoldActive } from "@/lib/lifecycle/lifecycle-activation";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";

import { resolveOrgPolicyRule, POLICY_ARTIFACT_TYPE_WILDCARD } from "./lifecycle-policy-store";
import { getRunRecommendations, parseLifecycleConfig } from "./recommendation-interception";
import {
  maybeParkCheckpoint,
  sweepParks,
  readContinuationParksForRun,
  type ParkRow,
} from "./lifecycle-continuation-park-store";
import type { AgentRunRecord, AgentTemplateRecord } from "./store";

/** The lifecycle checkpoint the run-start chip-row hold parks on. */
export const RECOMMENDATION_CHECKPOINT = "recommendation" as const;

/** The event id the recommendation park is keyed on. ONE recommendation park
 * per run (the park is unique on (run_id, event_id, checkpoint)), so a per-run
 * constant is correct and makes the park idempotent across retried holds. */
export function recommendationHoldEventId(runId: string): string {
  return `recommendation:run-start:${runId}`;
}

export type MaybeHoldResult =
  | { held: false; reason: string }
  | { held: true; parkId: string; reason: string };

/**
 * Decide whether a human-present run PARKS at the run-start recommendation
 * interception. Best-effort by contract — a recommendation write must never
 * fail a run — so the caller wraps this and, on ANY throw, dispatches normally
 * (fail-OPEN to today's behavior: no hold).
 *
 * Parks IFF: the run is human-present AND the recommendation checkpoint FIRES
 * (org rule + manifest, humanPresent:true) AND the request-aware scorer returns
 * at least one candidate. Otherwise returns `held:false` and the caller
 * dispatches the run unchanged.
 */
export async function maybeHoldRunForRecommendation(input: {
  run: Pick<AgentRunRecord, "id" | "orgId" | "humanPresent" | "inputParams">;
  template: Pick<AgentTemplateRecord, "packageName"> & {
    lifecycleConfig?: string | null;
  };
}): Promise<MaybeHoldResult> {
  const { run, template } = input;

  // Global activation fence (DEFAULT OFF). On origin/main the chip-row hold is
  // inert — every run dispatches exactly as today (the S3 headless auto-apply
  // stays byte-identical) — until an operator flips the fence on.
  if (!isRecommendationChipRowHoldActive()) return { held: false, reason: "fence off" };

  // Only an interactively-started, present-human run may park. A headless origin
  // (null/false) proceeds exactly as the S3 engine does today.
  if (run.humanPresent !== true) return { held: false, reason: "headless" };

  const packageName = template.packageName;
  if (!packageName) return { held: false, reason: "no package name" };

  // Idempotency + re-entry guard: if a recommendation park ALREADY exists for
  // this run — still parked (a concurrent hold) OR already released (the human
  // has decided and we are on the post-decision dispatch) — never create a new
  // hold. Without this, `maybeParkCheckpoint`'s (run,event,checkpoint) conflict
  // would return the EXISTING released park as `held:true`, re-holding a run
  // the human already released. A decided run dispatches through here unheld.
  const existing = await readRecommendationParkForRun(run.id);
  if (existing) return { held: false, reason: `recommendation ${existing.status}` };

  // Resolve the org bound for the recommendation checkpoint (PRE-production, so
  // resolved over the wildcard artifact type — an org expresses "require
  // recommendation for all this agent's runs" via the `*` rule). Without an
  // orgId the checkpoint stays silent → the humanPresent lattice default.
  const orgRule = run.orgId
    ? await resolveOrgPolicyRule(run.orgId, {
        checkpoint: RECOMMENDATION_CHECKPOINT,
        artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
        destinationClass: "none",
        originKind: "agent_produced",
      })
    : { bound: "silent" as const };

  const decision = evaluatePolicy({
    checkpoint: RECOMMENDATION_CHECKPOINT,
    artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: true,
    orgRule,
    manifest: parseLifecycleConfig(template.lifecycleConfig) ?? undefined,
  });

  const outcome = evaluateThenPark(decision, {
    checkpoint: RECOMMENDATION_CHECKPOINT,
    destinationClass: "none",
  });

  // Policy-forbidden / policy-skipped → the checkpoint does not fire; no row,
  // dispatch normally (issue #2067 AC-4).
  if (outcome.kind === "proceed") {
    return { held: false, reason: outcome.reason };
  }

  // The checkpoint fired — but only PARK if the request-aware scorer actually
  // returns a candidate to confirm. Empty candidates → no row, dispatch
  // normally (issue #2067 AC-4). Candidates are bounded to the agent's
  // already-assigned deliverable set (sessionless — the same set the headless
  // delivery resolves), so the chip-row can never surface a skill the run could
  // not deliver.
  let assignedSkillIds: string[] = [];
  try {
    assignedSkillIds = await getAssignedSkillIdsForAgent(packageName);
  } catch {
    assignedSkillIds = [];
  }
  let intentPromptText = "";
  try {
    intentPromptText = JSON.stringify(run.inputParams ?? {});
  } catch {
    intentPromptText = "";
  }
  const recommendations = await getRunRecommendations({
    agentId: packageName,
    intent: { promptText: intentPromptText },
    restrictToSkillIds: assignedSkillIds,
  });
  const hasCandidate = recommendations.some((r) => r.recommended) || recommendations.length > 0;
  if (!hasCandidate) {
    return { held: false, reason: "no recommendation candidates" };
  }

  const parked = await maybeParkCheckpoint(outcome, {
    runId: run.id,
    eventId: recommendationHoldEventId(run.id),
    policyDecisionId: null,
  });
  if (!parked.parked) {
    // evaluateThenPark said `park` but the store declined — treat as no hold
    // (fail-open to normal dispatch).
    return { held: false, reason: parked.reason };
  }
  return { held: true, parkId: parked.parkId, reason: outcome.reason };
}

/** The run's recommendation park (parked or released), or null if none. The
 * chip-row appearance discriminator: a `parked` row ⇒ the interactive chip-row;
 * a `released` row ⇒ the read-only decided summary; null ⇒ no row. */
export async function readRecommendationParkForRun(runId: string): Promise<ParkRow | null> {
  const parks = await readContinuationParksForRun(runId);
  // A run holds at most ONE recommendation park (per-run constant event id).
  return parks.find((p) => p.checkpoint === RECOMMENDATION_CHECKPOINT) ?? null;
}

/**
 * Release the run's LIVE recommendation park (the human decided). Idempotent and
 * best-effort: a no-op when no park exists or it is already released. Returns
 * whether a live park was released.
 */
export async function releaseRecommendationParkForRun(runId: string): Promise<boolean> {
  const park = await readRecommendationParkForRun(runId);
  if (!park || park.status !== "parked") return false;
  const { released } = await sweepParks({ releasedParkIds: [park.id] });
  return released > 0;
}
