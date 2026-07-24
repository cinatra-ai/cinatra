/**
 * Run-start RECOMMENDATION interception orchestration (cinatra#2041, epic #2037
 * S3, Point R).
 *
 * The server-side seam that ties the policy lattice (recommendation checkpoint)
 * + the request-aware scorer + the immutable per-run selection store into the
 * three run-start motions:
 *
 *   - HEADLESS auto-apply (`autoApplyHeadlessRecommendation`): the
 *     execution-worker path. A worker run has no present human, so the lattice
 *     default (`humanPresent:false ⇒ skip`) means this is a NO-OP unless an org
 *     `required` bound fires the checkpoint; when it fires, the top
 *     recommendations are auto-applied immediately. A headless run NEVER parks
 *     (epic decision 6).
 *   - HUMAN confirm (`confirmRunSkillSelection`): the chip-row path. A present
 *     human confirms/adjusts the recommendation set; the confirmed pinned
 *     revisions are written with `recommended_confirmed`/`user_forced`, and the
 *     accepted/rejected split is returned for the efficacy surface (#1368).
 *   - Chip-row READ (`getRunRecommendations`): the scored set the chip-row +
 *     the MCP primitive both surface (one scoring implementation).
 *
 * Lives in `@cinatra-ai/agents` because it needs BOTH the org-policy store
 * (agents) and the request-aware scorer (skills) — the direction the skills⇄
 * agents seam already flows (agents depends on skills).
 */
import "server-only";

import {
  recommendSkillsForAgentTask,
  type RecommendSkillsForAgentInput,
} from "@cinatra-ai/skills/recommendation-server";
import {
  decideRecommendationContinuation,
  deriveConfirmedSelection,
  summarizeRecommendationEfficacy,
  type RankedRecommendation,
  type RecommendationEfficacy,
  type RunIntent,
  type RunSkillSelectionEntry,
} from "@cinatra-ai/skills/recommendation";
import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import type { CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";

import { resolveOrgPolicyRule, POLICY_ARTIFACT_TYPE_WILDCARD } from "./lifecycle-policy-store";
import { writeRunSelectedSkillRevisions } from "@/lib/run-selected-skill-revisions";

/** Parse the compiled `agent_templates.lifecycle_config` JSON-as-text. Returns
 * null on absence / malformed JSON (never throws). */
export function parseLifecycleConfig(
  raw: string | null | undefined,
): CompiledManifestLifecycle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CompiledManifestLifecycle;
  } catch {
    // malformed compiled config — treat as absent.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chip-row / MCP read.
// ---------------------------------------------------------------------------

/** Score the agent's candidate skills against the run intent. The single scored
 * set the chip-row surfaces (and the MCP primitive returns). */
export async function getRunRecommendations(
  input: RecommendSkillsForAgentInput,
): Promise<RankedRecommendation[]> {
  return recommendSkillsForAgentTask(input);
}

// ---------------------------------------------------------------------------
// Headless auto-apply (execution-worker path).
// ---------------------------------------------------------------------------

export interface AutoApplyHeadlessInput {
  runId: string;
  orgId: string | null | undefined;
  agentId: string;
  intent: RunIntent;
  /** The compiled agent-manifest lifecycle declarations, if any. */
  manifest?: CompiledManifestLifecycle | null;
  /** Bound the candidate set to these skill ids — the agent's already-assigned,
   * runtime-deliverable skills. A headless auto-apply must never select a skill
   * the agent could not already deliver (an archived / excluded / unsynced skill
   * would fail delivery), so the execution worker passes the resolved assigned
   * set here and the selection is always a subset of it. */
  restrictToSkillIds?: string[];
  autoApplyLimit?: number;
}

export type AutoApplyHeadlessResult =
  | { mode: "skipped"; reason: string; written: 0 }
  | { mode: "auto_applied"; reason: string; written: number; selection: RunSkillSelectionEntry[] };

/**
 * Evaluate the recommendation checkpoint for a HEADLESS run and, if the lattice
 * fires it (org `required`), auto-apply the top recommendations into the
 * immutable per-run selection set. A no-op (no write) when the checkpoint does
 * not fire — so the run falls back to today's computed assignment, unchanged.
 * NEVER parks.
 *
 * Best-effort by contract: a recommendation write must never fail a run, so the
 * caller wraps this; here we only surface the outcome.
 */
export async function autoApplyHeadlessRecommendation(
  input: AutoApplyHeadlessInput,
): Promise<AutoApplyHeadlessResult> {
  // Resolve the org bound for the recommendation checkpoint. Without an orgId we
  // cannot resolve an org `required` bound, so the checkpoint stays silent →
  // headless default skip (unchanged behavior).
  const orgRule = input.orgId
    ? await resolveOrgPolicyRule(input.orgId, {
        checkpoint: "recommendation",
        // Recommendation is PRE-production: the produced type is not yet known,
        // so the org bound is resolved over the wildcard type (an org expresses
        // "require recommendation for all this agent's runs" via the `*` rule).
        artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
        destinationClass: "none",
        originKind: "agent_produced",
      })
    : { bound: "silent" as const };

  const decision = evaluatePolicy({
    checkpoint: "recommendation",
    artifactType: POLICY_ARTIFACT_TYPE_WILDCARD,
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: false,
    orgRule,
    manifest: input.manifest ?? undefined,
  });

  if (!decision.fired) {
    return { mode: "skipped", reason: decision.reason, written: 0 };
  }

  const recommendations = await recommendSkillsForAgentTask({
    agentId: input.agentId,
    intent: input.intent,
    // Candidates are bound to the agent's deliverable assigned set (safety) —
    // the auto-applied selection is always a subset of what the agent could
    // already deliver.
    restrictToSkillIds: input.restrictToSkillIds,
  });
  const continuation = decideRecommendationContinuation({
    policyFired: true,
    humanPresent: false,
    recommendations,
    autoApplyLimit: input.autoApplyLimit,
  });

  // Human-present modes never reach a headless worker; the only firing outcome
  // here is auto_applied.
  if (continuation.mode !== "auto_applied") {
    return { mode: "skipped", reason: continuation.reason, written: 0 };
  }

  writeRunSelectedSkillRevisions({ runId: input.runId, selections: continuation.selection });
  return {
    mode: "auto_applied",
    reason: continuation.reason,
    written: continuation.selection.length,
    selection: continuation.selection,
  };
}

// ---------------------------------------------------------------------------
// Human confirm (chip-row path).
// ---------------------------------------------------------------------------

export interface ConfirmRunSkillSelectionInput {
  runId: string;
  agentId: string;
  intent: RunIntent;
  /** The skill ids the human kept from the recommendation chip-row. */
  confirmedSkillIds: string[];
  /** Pinned revision for any forced (non-recommended) skill: skillId → revId. */
  forcedRevisions?: Record<string, string>;
  restrictToSkillIds?: string[];
}

export interface ConfirmRunSkillSelectionResult {
  written: number;
  selection: RunSkillSelectionEntry[];
  efficacy: RecommendationEfficacy;
}

/**
 * Persist a human's confirmed/adjusted selection as the immutable per-run set,
 * and return the accepted/rejected efficacy split. Re-scores the SAME candidate
 * set (so the confirmed revisions are pinned exactly as recommended) and writes
 * idempotently (first write per (run, skill) wins).
 */
export async function confirmRunSkillSelection(
  input: ConfirmRunSkillSelectionInput,
): Promise<ConfirmRunSkillSelectionResult> {
  const recommendations = await recommendSkillsForAgentTask({
    agentId: input.agentId,
    intent: input.intent,
    restrictToSkillIds: input.restrictToSkillIds,
  });
  const selection = deriveConfirmedSelection({
    recommendations,
    confirmedSkillIds: input.confirmedSkillIds,
    forcedRevisions: input.forcedRevisions,
  });
  writeRunSelectedSkillRevisions({ runId: input.runId, selections: selection });
  const efficacy = summarizeRecommendationEfficacy({
    recommendations,
    selectedSkillIds: selection.map((s) => s.skillId),
  });
  return { written: selection.length, selection, efficacy };
}
