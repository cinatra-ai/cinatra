"use server";

// ---------------------------------------------------------------------------
// The run-start recommendation chip-row's SESSION ENTRY (cinatra#2067, epic
// #2037 C3; parameterized by cinatra#2790, epic #2784 S9f).
//
// WHAT THIS FILE IS NOW. A thin, cookie-bound entry: it resolves the signed-in
// session and its live standing, and hands that verified actor to the ONE hold
// core (`recommendation-hold.ts`). The ladder it used to contain — the run
// access door, the viewer-intersected candidate row, the hold-instance CAS, the
// verified release, the resume announcement and the dispatch — did not change;
// it moved, so that the site widget's broker entry
// (`src/app/api/lifecycle-views/recommendation-hold/**`) reaches exactly the
// same code with an actor built from its OWN `cwu_` credential instead of an
// ambient cookie.
//
// THE PUBLIC SHAPE IS UNCHANGED. The three actions below keep their names,
// their inputs and their answers, because the card on a cookie host calls them
// exactly as it did. Every export of this module is an async function, as a
// `"use server"` module requires — and, deliberately, none of them takes an
// actor: an exported action is a client-callable endpoint, so identity is
// resolved HERE from the session and can never be supplied by a caller.
//
// NOTE: this is NOT a review-gate decision. The chip-row's confirm/adjust/skip
// are skill-selection affordances, categorically distinct from the review
// decision floor (Approve/Reject/Comment) — no fourth floor affordance is added
// anywhere (issue #2067 AC-8).
// ---------------------------------------------------------------------------

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "./auth-policy";

import { RECOMMENDATION_DECISION_REFUSAL } from "./recommendation-hold";
import type { RecommendationHoldActor } from "./recommendation-hold";
import {
  confirmRecommendationForActor,
  resolveRecommendationHoldStateForActor,
  skipRecommendationForActor,
} from "./run-recommendation-core";
import { triggerAgentRun } from "./run-actions";
import { confirmRunSkillSelectionAction } from "./server-actions";

export type {
  RunRecommendationDecisionResult,
  RunRecommendationHoldState,
} from "./run-recommendation-core";

import type {
  RunRecommendationDecisionResult,
  RunRecommendationHoldState,
} from "./run-recommendation-core";

/**
 * The session caller, as the core's verified-actor shape.
 *
 * FAIL-CLOSED: a request with no session, or one whose kernel context cannot be
 * resolved, is not a narrower actor — it is no actor, and every caller below
 * turns it into the same silence an unauthorized reader gets.
 */
async function sessionActor(): Promise<RecommendationHoldActor | null> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return null;
  const viewer = await requireActorContext().catch(() => null);
  if (!viewer) return null;
  const roleHints: ActorRoleHints = {
    ...(viewer.platformRole ? { platformRole: viewer.platformRole } : {}),
    ...(viewer.orgRole ? { orgRole: viewer.orgRole } : {}),
    ...(viewer.teamRoles ? { teamRoles: viewer.teamRoles } : {}),
    ...(viewer.teamIds ? { teamIds: viewer.teamIds } : {}),
    ...(viewer.projectGrants ? { projectGrants: viewer.projectGrants } : {}),
    actorOrganizationId: viewer.organizationId ?? null,
  };
  const actor: PrimitiveActorContext = { actorType: "human", source: "ui", userId };
  return { actor, roleHints };
}

/**
 * The run-start recommendation hold state for a COOKIE host. Returns:
 *   held      → the interactive chip-row (prefetched candidates);
 *   confirmed → the read-only confirmed summary;
 *   skipped   → the read-only skipped summary;
 *   none      → no row (headless / policy-skipped / empty-candidate / no run /
 *               a reader who may not see the run).
 */
export async function getRunRecommendationHoldStateAction(input: {
  runId: string;
}): Promise<RunRecommendationHoldState> {
  const who = await sessionActor();
  if (!who) return { state: "none" };
  return resolveRecommendationHoldStateForActor({ runId: input.runId, who });
}

/**
 * CONFIRM / ADJUST: persist the human's confirmed selection set, then release the
 * run-start hold and dispatch. `confirmedSkillIds` is the FULL kept set — a plain
 * confirm keeps the recommended ids; an "adjust" passes the edited set (a removed
 * skill is absent; an added non-recommended skill rides `forcedRevisions`).
 */
export async function confirmRunRecommendationAction(input: {
  runId: string;
  agentPackageName: string;
  confirmedSkillIds: string[];
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
  /**
   * The kept skills the reader settled through the chip's ADJUST panel
   * (cinatra#2841). Written as `user_adjusted` selection rows, so §V's third
   * settled mark is reachable for a skill that IS in the scored set.
   */
  adjustedSkillIds?: string[];
  /** The hold this decision was taken against (cinatra#2568). */
  holdRef?: string;
}): Promise<RunRecommendationDecisionResult> {
  const who = await sessionActor();
  if (!who) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  return confirmRecommendationForActor({
    runId: input.runId,
    agentPackageName: input.agentPackageName,
    confirmedSkillIds: input.confirmedSkillIds,
    who,
    // The SESSION selection write — `confirmRunSkillSelectionAction`, which
    // resolves its own execute-tier gate from the cookie session and delegates
    // to the one actor-parameterized implementation.
    writeSelection: (write) =>
      confirmRunSkillSelectionAction({
        runId: write.runId,
        agentPackageName: write.agentPackageName ?? input.agentPackageName,
        confirmedSkillIds: write.confirmedSkillIds,
        ...(write.promptText !== undefined ? { promptText: write.promptText } : {}),
        ...(write.declaredProducedTypes
          ? { declaredProducedTypes: write.declaredProducedTypes }
          : {}),
        ...(write.targetArtifactKind ? { targetArtifactKind: write.targetArtifactKind } : {}),
        ...(write.forcedRevisions ? { forcedRevisions: write.forcedRevisions } : {}),
        ...(write.adjustedSkillIds ? { adjustedSkillIds: write.adjustedSkillIds } : {}),
      }),
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    ...(input.declaredProducedTypes ? { declaredProducedTypes: input.declaredProducedTypes } : {}),
    ...(input.targetArtifactKind ? { targetArtifactKind: input.targetArtifactKind } : {}),
    ...(input.forcedRevisions ? { forcedRevisions: input.forcedRevisions } : {}),
    ...(input.adjustedSkillIds ? { adjustedSkillIds: input.adjustedSkillIds } : {}),
    ...(input.holdRef !== undefined ? { holdRef: input.holdRef } : {}),
    dispatch: triggerAgentRun,
  });
}

/**
 * SKIP: persist durable skip evidence (a `user_skipped` rejected row per
 * recommended candidate — distinguishable from no-decision AND from confirm),
 * write NO selection row (the run falls back to the computed default set), then
 * release the hold and dispatch.
 */
export async function skipRunRecommendationAction(input: {
  runId: string;
  /** The hold this decision was taken against (cinatra#2568). */
  holdRef?: string;
}): Promise<RunRecommendationDecisionResult> {
  const who = await sessionActor();
  if (!who) return { ok: false, error: RECOMMENDATION_DECISION_REFUSAL };
  return skipRecommendationForActor({
    runId: input.runId,
    who,
    ...(input.holdRef !== undefined ? { holdRef: input.holdRef } : {}),
    dispatch: triggerAgentRun,
  });
}
