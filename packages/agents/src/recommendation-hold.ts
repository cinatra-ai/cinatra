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
//   resolveRecommendationCandidateSkillIds — the ONE candidate-set seam every
//     chip-row surface resolves through (cinatra#2148 finding 1), actor-scoped
//     to the RUN's own owner/org.
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
import { resolveAssignedSkillsActorForRun } from "@/lib/agent-run-actor-resolve";

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

/** The run projection the candidate resolver needs to derive the run's own
 * actor. A structural subset of `AgentRunRecord`, so every caller can pass its
 * run row directly. */
export type RunForRecommendationCandidates = Pick<AgentRunRecord, "id" | "runBy" | "orgId"> & {
  sourceType?: string | null;
  dependentInstallId?: string | null;
};

/** The actor-scope filter shape `getAssignedSkillIdsForAgent` consumes. Kept to
 * the fields `confirmRunSkillSelectionAction` bounds its authoritative write
 * with — deliberately NO `platformRole` (see below). */
export type RecommendationCandidateActorFilter = {
  principalId: string;
  teamIds: string[];
  projectIds: string[];
  organizationId?: string;
};

/**
 * The ONE candidate-set seam every run-start recommendation surface resolves
 * through (cinatra#2148 finding 1): the hold decision, the run-view chip-row
 * prefetch, the chat-mounted chip-row state, and the skip-evidence writer.
 *
 * Actor-scoped by the RUN's own owner/org — `getAssignedSkillIdsForAgent`
 * deliberately treats an actor-FREE call as the most restrictive non-admin
 * caller, so the previous actor-less calls filtered EVERY scoped
 * (org / workspace / team / project / personal) assignment out of the candidate
 * set and the chip row under-recommended (only platform `system` skills and the
 * agent's own self-match survived).
 *
 * The actor is derived by the canonical, FAIL-CLOSED run→actor resolver
 * (`resolveAssignedSkillsActorForRun`, cinatra#1401) — the same authority the
 * llm-bridge already uses to resolve THIS run's delivered skill set. It expands
 * the owner's LIVE team/project/org membership and then re-gates on the freshest
 * `member` read, so a revoked/demoted owner resolves to `undefined` and we fall
 * back to EXACTLY today's actor-less call — never more.
 *
 * DELIBERATELY drops `platformRole`: the resolved filter carries only
 * `principalId / teamIds / projectIds / organizationId`, the SAME bounding shape
 * `confirmRunSkillSelectionAction` uses for the authoritative write. The
 * candidate set is therefore a subset of what the human's confirm can write
 * (never offering a chip the write would silently drop) and a subset of what the
 * bridge delivers (which does carry the admin short-circuit) — this seam widens
 * reads to the run owner's OWN membership scopes only, never past them via the
 * platform-admin bypass.
 *
 * PRESENTATION surfaces additionally pass `viewer` — the actor whose SCREEN the
 * chips land on. The returned set is then the INTERSECTION of the run's
 * capability and the viewer's own entitlement, which keeps two properties the
 * run-actor set alone cannot give:
 *   - a reader who holds run-READ but is not the run owner can never learn the
 *     owner's personal/team/project-scoped skill NAMES off this surface (the
 *     actor threading must not widen what a viewer can read);
 *   - every offered chip is a chip the viewer's own confirm write would accept
 *     (`confirmRunSkillSelectionAction` bounds with the SAME filter shape), so
 *     a confirm can never silently drop a chip the row offered.
 * For the run owner — the only actor with the execute standing the chip-row's
 * decision requires — the two sets are identical, so the org/workspace
 * assignments AC-a is about appear in full.
 *
 * Best-effort by contract: ANY resolution failure degrades to the actor-less
 * set, and a catalog failure to `[]` — a recommendation read must never fail a
 * run.
 */
export async function resolveRecommendationCandidateSkillIds(input: {
  run: RunForRecommendationCandidates;
  packageName: string;
  /** Present on PRESENTATION surfaces only — see the intersection note above. */
  viewer?: RecommendationCandidateActorFilter;
}): Promise<string[]> {
  const { run, packageName, viewer } = input;
  if (!packageName) return [];

  let actorFilter: RecommendationCandidateActorFilter | undefined;
  try {
    const runActor = await resolveAssignedSkillsActorForRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
      sourceType: run.sourceType ?? null,
      dependentInstallId: run.dependentInstallId ?? null,
    });
    if (runActor) {
      actorFilter = {
        principalId: runActor.principalId,
        teamIds: runActor.teamIds ?? [],
        projectIds: runActor.projectIds ?? [],
        organizationId: runActor.organizationId ?? undefined,
      };
    }
  } catch {
    actorFilter = undefined;
  }

  let runCapabilityIds: string[];
  try {
    runCapabilityIds = actorFilter
      ? await getAssignedSkillIdsForAgent(packageName, actorFilter)
      : await getAssignedSkillIdsForAgent(packageName);
  } catch {
    return [];
  }
  if (!viewer || runCapabilityIds.length === 0) return runCapabilityIds;

  // Presentation intersection. Fail-CLOSED to the viewer's own entitlement: an
  // unreadable viewer set yields no chips rather than falling back to the wider
  // run-capability set.
  let viewerIds: string[];
  try {
    viewerIds = await getAssignedSkillIdsForAgent(packageName, viewer);
  } catch {
    return [];
  }
  const viewerSet = new Set(viewerIds);
  // Order is preserved from the run-capability resolve, which is itself a pure
  // function of DB state — so the rendered chip order stays deterministic.
  return runCapabilityIds.filter((id) => viewerSet.has(id));
}

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
 *
 * `held` answers "IS this run held?", NOT "did I just create a park" — a run
 * that is ALREADY parked answers `held:true` with the existing park id and
 * creates no second park (cinatra#2148). Answering `held:false` there made the
 * result unsafe for any caller without its own live-park pre-check: a RETRIED
 * run-start (a second immediate trigger, a double-clicked Run) would sail past
 * the live park and dispatch the very run the human is still deciding on.
 */
export async function maybeHoldRunForRecommendation(input: {
  run: Pick<AgentRunRecord, "id" | "orgId" | "humanPresent" | "inputParams" | "runBy"> & {
    sourceType?: string | null;
    dependentInstallId?: string | null;
  };
  template: Pick<AgentTemplateRecord, "packageName"> & {
    lifecycleConfig?: string | null;
  };
}): Promise<MaybeHoldResult> {
  const { run, template } = input;

  // Global activation switch (DEFAULT ON per the #2047 ruling). A deployment
  // that sets CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=off gets the pre-flip
  // posture: the chip-row hold is inert and every run dispatches unheld (the S3
  // headless auto-apply stays byte-identical either way).
  if (!isRecommendationChipRowHoldActive()) return { held: false, reason: "fence off" };

  // Only an interactively-started, present-human run may park. A headless origin
  // (null/false) proceeds exactly as the S3 engine does today.
  if (run.humanPresent !== true) return { held: false, reason: "headless" };

  const packageName = template.packageName;
  if (!packageName) return { held: false, reason: "no package name" };

  // Idempotency + re-entry guard: if a recommendation park ALREADY exists for
  // this run, never create a new one. Two cases, and they answer DIFFERENTLY:
  //   parked  → the human has NOT decided yet. The run is held; say so, with the
  //             existing park id, so a retried run-start (a second immediate
  //             trigger, a double-clicked Run) cannot dispatch past a live park
  //             (cinatra#2148). No second park row is written.
  //   released / policy_unresolved → terminal. The human decided (or the TTL
  //             sweeper fail-closed the park), so the run dispatches. Without
  //             this branch `maybeParkCheckpoint`'s (run,event,checkpoint)
  //             conflict would hand back the TERMINAL park as a fresh hold and
  //             re-hold a run that is already done deciding.
  const existing = await readRecommendationParkForRun(run.id);
  if (existing) {
    return existing.status === "parked"
      ? { held: true, parkId: existing.id, reason: "recommendation already parked" }
      : { held: false, reason: `recommendation ${existing.status}` };
  }

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
  // already-assigned deliverable set — resolved through the SHARED, run-actor-
  // scoped seam (cinatra#2148 finding 1) so an org/workspace-assigned skill is
  // part of the candidate set instead of being filtered out by an actor-free
  // resolve — so the chip-row can never surface a skill the run could not
  // deliver.
  const assignedSkillIds = await resolveRecommendationCandidateSkillIds({
    run,
    packageName,
  });
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
