"use server";

// ---------------------------------------------------------------------------
// Run-start recommendation chip-row DECISION actions (cinatra#2067, epic #2037
// C3). The three affordances the shared chip-row surfaces — CONFIRM (keep the
// recommended set), ADJUST (confirm a different set — same action, different
// ids) and SKIP (proceed with the computed default) — each write their durable
// decision AND release the run-start hold so the parked run dispatches.
//
// These are the ONLY callers that release a recommendation park + dispatch a
// held run. Both:
//   1. write the decision (confirm → the authoritative per-run selection via the
//      existing execute-tier-authorized `confirmRunSkillSelectionAction`; skip →
//      durable `user_skipped` evidence);
//   2. release the run-start recommendation park (the S0 sweeper);
//   3. dispatch the run through the canonical `triggerAgentRun` — which, seeing
//      the park now RELEASED (not parked) and a decision on record, re-holds
//      nothing and performs the normal pending_input→queued transition + enqueue
//      (connector/LLM preflight included).
//
// NOTE: this is NOT a review-gate decision. The chip-row's confirm/adjust/skip
// are skill-selection affordances, categorically distinct from the review
// decision floor (Approve/Reject/Comment) — no fourth floor affordance is added
// anywhere (issue #2067 AC-8).
// ---------------------------------------------------------------------------

import { requireAuthSession } from "@/lib/auth-session";
import {
  writeRunRejectedRecommendations,
  SKIP_RECOMMENDATION_SOURCE,
} from "@/lib/run-selected-skill-revisions";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";

import {
  readRunSelectedSkillRevisions,
  hasRunRecommendationSkip,
} from "@/lib/run-selected-skill-revisions";

import { readAgentRunById, readAgentTemplateById } from "./store";
import { getRunRecommendations } from "./recommendation-interception";
import { readRecommendationParkForRun, releaseRecommendationParkForRun } from "./recommendation-hold";
import { triggerAgentRun } from "./run-actions";
import { confirmRunSkillSelectionAction } from "./server-actions";
import type { RecommendedSkillForChip } from "./server-actions";

export type RunRecommendationDecisionResult =
  | { ok: true; dispatched: boolean }
  | { ok: false; error: string; code?: string; settingsHref?: string };

export type RunRecommendationHoldState =
  | { state: "none" }
  | { state: "held"; agentPackageName: string; promptText: string; recommendations: RecommendedSkillForChip[] }
  | { state: "confirmed"; skillNames: string[] }
  | { state: "skipped" };

/**
 * The run-start recommendation hold state for the chat-mounted run panel
 * (cinatra#2067 item 5 — the SAME shared chip-row serves chat). Returns:
 *   held      → the interactive chip-row (prefetched candidates);
 *   confirmed → the read-only confirmed summary;
 *   skipped   → the read-only skipped summary;
 *   none      → no row (headless / policy-skipped / empty-candidate / no run).
 * Read-only + session-guarded via the run access door (`readAgentRunById`).
 */
export async function getRunRecommendationHoldStateAction(input: {
  runId: string;
}): Promise<RunRecommendationHoldState> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { state: "none" };
  if (!input.runId) return { state: "none" };

  const park = await readRecommendationParkForRun(input.runId).catch(() => null);
  if (!park) return { state: "none" };

  if (park.status !== "parked") {
    const selected = readRunSelectedSkillRevisions(input.runId);
    if (selected.length > 0) return { state: "confirmed", skillNames: selected.map((s) => s.skillId) };
    if (hasRunRecommendationSkip(input.runId)) return { state: "skipped" };
    return { state: "none" };
  }

  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return { state: "none" };
  const template = await readAgentTemplateById(run.templateId).catch(() => null);
  const packageName = template?.packageName;
  if (!packageName) return { state: "none" };

  let assignedSkillIds: string[] = [];
  try {
    assignedSkillIds = await getAssignedSkillIdsForAgent(packageName);
  } catch {
    assignedSkillIds = [];
  }
  let promptText = "";
  try {
    promptText = JSON.stringify(run.inputParams ?? {});
  } catch {
    promptText = "";
  }
  const recs = await getRunRecommendations({
    agentId: packageName,
    intent: { promptText },
    restrictToSkillIds: assignedSkillIds,
  }).catch(() => []);
  return {
    state: "held",
    agentPackageName: packageName,
    promptText,
    recommendations: recs.map((r) => ({
      skillId: r.skillId,
      skillRevisionId: r.skillRevisionId,
      name: r.name,
      score: r.score,
      rank: r.rank,
      recommended: r.recommended,
      scoredFeatures: r.scoredFeatures,
    })),
  };
}

/**
 * CONFIRM / ADJUST: persist the human's confirmed selection set (execute-tier
 * authorized by `confirmRunSkillSelectionAction`), then release the run-start
 * hold and dispatch. `confirmedSkillIds` is the FULL kept set — a plain confirm
 * keeps the recommended ids; an "adjust" passes the edited set (a removed skill
 * is absent; an added non-recommended skill rides `forcedRevisions`).
 */
export async function confirmRunRecommendationAction(input: {
  runId: string;
  agentPackageName: string;
  confirmedSkillIds: string[];
  promptText?: string;
  declaredProducedTypes?: string[];
  targetArtifactKind?: string;
  forcedRevisions?: Record<string, string>;
}): Promise<RunRecommendationDecisionResult> {
  const session = await requireAuthSession().catch(() => null);
  if (!session?.user?.id) return { ok: false, error: "unauthorized" };
  if (!input.runId) return { ok: false, error: "run not found" };

  // 1. Write the authoritative per-run selection (does its own execute-tier
  //    run authorization + assigned-set bounding).
  const written = await confirmRunSkillSelectionAction({
    runId: input.runId,
    agentPackageName: input.agentPackageName,
    confirmedSkillIds: input.confirmedSkillIds,
    promptText: input.promptText,
    declaredProducedTypes: input.declaredProducedTypes,
    targetArtifactKind: input.targetArtifactKind,
    forcedRevisions: input.forcedRevisions,
  });
  if (!written.ok) return { ok: false, error: "selection not authorized" };

  // 2 + 3. Release the hold and dispatch.
  return releaseAndDispatch(input.runId);
}

/**
 * SKIP: persist durable skip evidence (a `user_skipped` rejected row per
 * recommended candidate — distinguishable from no-decision AND from confirm),
 * write NO selection row (the run falls back to the computed default set), then
 * release the hold and dispatch.
 */
export async function skipRunRecommendationAction(input: {
  runId: string;
}): Promise<RunRecommendationDecisionResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };
  if (!input.runId) return { ok: false, error: "run not found" };

  const run = await readAgentRunById(input.runId).catch(() => null);
  if (!run) return { ok: false, error: "run not found" };
  // Ownership check — the same gate `triggerAgentRun` (the dispatch, below)
  // enforces. A run with no owner (runBy null) is triggerable by any session,
  // matching the existing trigger semantics.
  if (run.runBy && run.runBy !== userId) return { ok: false, error: "forbidden" };

  // Persist durable skip evidence: mark every recommended candidate `user_skipped`.
  // Best-effort — a telemetry write must never block the dispatch.
  try {
    const template = await readAgentTemplateById(run.templateId).catch(() => null);
    const packageName = template?.packageName;
    if (packageName) {
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
      const rejectedRows = recommendations
        .filter((r) => r.recommended)
        .map((r) => ({
          skillId: r.skillId,
          skillRevisionId: r.skillRevisionId,
          recommendationSource: SKIP_RECOMMENDATION_SOURCE,
          recommendedRank: r.rank,
        }));
      writeRunRejectedRecommendations({ runId: input.runId, rejected: rejectedRows });
    }
  } catch (err) {
    // The run id is a request-controlled value; keep it OUT of the console
    // format-string position (pass it as a discrete argument) so a `%`-bearing
    // id can never be interpreted as a util.format specifier (CodeQL
    // js/tainted-format-string).
    console.warn(
      "[skipRunRecommendationAction] skip-evidence write failed for run",
      input.runId,
      "— continuing:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return releaseAndDispatch(input.runId);
}

/**
 * Shared release + dispatch. Releases the run-start recommendation park (S0
 * sweeper) then dispatches through the canonical `triggerAgentRun` (ownership +
 * connector/LLM preflight + pending_input→queued CAS + enqueue). Because the
 * park is now RELEASED, `triggerAgentRun`'s hold re-check finds no live park and
 * `maybeHoldRunForRecommendation` sees a decided run — so the run dispatches
 * instead of re-holding.
 */
async function releaseAndDispatch(runId: string): Promise<RunRecommendationDecisionResult> {
  await releaseRecommendationParkForRun(runId).catch(() => false);

  const run = await readAgentRunById(runId).catch(() => null);
  if (!run) return { ok: false, error: "run not found" };

  // A held run is pending_input; if it already advanced (a concurrent decision
  // won the dispatch race), report success without re-dispatching.
  if (run.status !== "pending_input") return { ok: true, dispatched: false };

  const result = await triggerAgentRun({ runId, templateSlug: run.templateId });
  if (!result.ok) {
    return { ok: false, error: result.error, code: result.code, settingsHref: result.settingsHref };
  }
  return { ok: true, dispatched: true };
}
