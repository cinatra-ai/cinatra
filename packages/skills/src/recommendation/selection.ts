/**
 * Per-run skill SELECTION pure core (cinatra#2041, epic #2037 S3, Point R).
 *
 * The authoritative per-run selected-revision set is an IMMUTABLE set of pinned
 * skill revisions every delivery path consumes (S0 landed the table
 * `run_selected_skill_revisions` + the `SelectedSkillRevision` contract). This
 * module is the PURE core that:
 *
 *   - decides the run-start CONTINUATION (AC-3): human-present → surface the
 *     chip-row for confirm/adjust; headless + fired (e.g. an org-`required`
 *     recommendation bound) → auto-apply the top recommendations; NEVER parks.
 *   - turns a scored recommendation set + a human's confirm/adjust choice into
 *     the immutable selection entries the store persists, stamping the
 *     `selection_source` that is the acceptance signal the efficacy surface
 *     consumes (AC-6).
 *   - resolves what a delivery path (execution snapshot, llm-bridge) actually
 *     delivers: the selected set when one exists, else today's computed
 *     assignment (AC-2 fallback) — so the bridge never recomputes when a set
 *     exists.
 *
 * Leaf-safe: only `import type` from the sibling scorer. No server-only, no DB,
 * no clock — reachable via `@cinatra-ai/skills/recommendation`.
 */

import type { RankedRecommendation } from "./request-aware-scorer";

// ---------------------------------------------------------------------------
// Selection sources — the acceptance signal stamped on every persisted row.
// `selection_source` is free text in the S0 column; S3 enumerates it here.
// ---------------------------------------------------------------------------

export const SELECTION_SOURCES = {
  /** A human confirmed a recommended skill in the chip-row. */
  recommendedConfirmed: "recommended_confirmed",
  /** A headless run auto-applied a top recommendation (no human, no park). */
  recommendedAutoApplied: "recommended_auto_applied",
  /** A human forced a NON-recommended skill on (elevation-style adjust). */
  userForced: "user_forced",
} as const;

export type SelectionSource =
  (typeof SELECTION_SOURCES)[keyof typeof SELECTION_SOURCES];

/** One immutable per-run selection the store persists (the id PK is generated
 * at write time — S0's table carries `id text PRIMARY KEY`). */
export interface RunSkillSelectionEntry {
  skillId: string;
  /** The EXACT pinned immutable skill revision selected. */
  skillRevisionId: string;
  selectionSource: SelectionSource;
}

// ---------------------------------------------------------------------------
// Run-start continuation (AC-3: headless never parks).
// ---------------------------------------------------------------------------

export const DEFAULT_AUTO_APPLY_LIMIT = 8;

export type RecommendationContinuation =
  /** The recommendation checkpoint did not fire — no selection, run proceeds
   * with today's computed assignment (fallback). */
  | { mode: "skipped"; reason: string; selection: RunSkillSelectionEntry[] }
  /** A human is present — surface the chip-row; the selection is written only
   * once the human confirms (via `deriveConfirmedSelection`). */
  | {
      mode: "await_confirmation";
      reason: string;
      recommendations: RankedRecommendation[];
    }
  /** Headless + fired — auto-apply the top recommendations immediately. The
   * run NEVER pauses/parks for input (epic decision 6). */
  | { mode: "auto_applied"; reason: string; selection: RunSkillSelectionEntry[] };

/**
 * Decide the run-start continuation. Total + deterministic — the policy `fired`
 * boolean is computed by the lattice (`evaluatePolicy`, checkpoint
 * "recommendation") at the wiring site and passed in, so this core stays
 * leaf-safe and DB-free.
 *
 *   !fired               → skipped (no selection; fallback to computed).
 *   fired & humanPresent → await_confirmation (chip-row; selection on confirm).
 *   fired & headless     → auto_applied (top-N recommended; NEVER parks).
 */
export function decideRecommendationContinuation(input: {
  policyFired: boolean;
  humanPresent: boolean;
  recommendations: RankedRecommendation[];
  autoApplyLimit?: number;
}): RecommendationContinuation {
  if (!input.policyFired) {
    return {
      mode: "skipped",
      reason: "recommendation checkpoint did not fire — using computed assignment",
      selection: [],
    };
  }
  if (input.humanPresent) {
    return {
      mode: "await_confirmation",
      reason: "human present — surface the recommendation chip-row",
      recommendations: input.recommendations,
    };
  }
  // Headless + fired (e.g. an org-`required` recommendation bound). Auto-apply
  // the top recommended candidates; a headless run must never pause for input.
  const limit = input.autoApplyLimit ?? DEFAULT_AUTO_APPLY_LIMIT;
  const selection = input.recommendations
    .filter((r) => r.recommended)
    .slice(0, limit)
    .map((r) => ({
      skillId: r.skillId,
      skillRevisionId: r.skillRevisionId,
      selectionSource: SELECTION_SOURCES.recommendedAutoApplied,
    }));
  return {
    mode: "auto_applied",
    reason: "headless run auto-applied top recommendations (no park)",
    selection,
  };
}

// ---------------------------------------------------------------------------
// Human confirm/adjust → immutable selection entries.
// ---------------------------------------------------------------------------

/**
 * Turn a human's confirm/adjust choice into the immutable selection entries.
 * `confirmedSkillIds` names which recommended skills the human kept; a skill
 * present in the recommendation set is stamped `recommended_confirmed`, a skill
 * the human added that was NOT recommended is `user_forced` (its pinned
 * revision must be supplied via `forcedRevisions`). Unknown ids are dropped
 * (never guessed). Order is stable (confirmed order preserved).
 */
export function deriveConfirmedSelection(input: {
  recommendations: RankedRecommendation[];
  confirmedSkillIds: string[];
  /** Pinned revision id for a forced (non-recommended) skill: skillId → revId. */
  forcedRevisions?: Record<string, string>;
}): RunSkillSelectionEntry[] {
  const recById = new Map(input.recommendations.map((r) => [r.skillId, r]));
  const seen = new Set<string>();
  const out: RunSkillSelectionEntry[] = [];
  for (const skillId of input.confirmedSkillIds) {
    if (seen.has(skillId)) continue;
    const rec = recById.get(skillId);
    if (rec) {
      seen.add(skillId);
      out.push({
        skillId,
        skillRevisionId: rec.skillRevisionId,
        selectionSource: SELECTION_SOURCES.recommendedConfirmed,
      });
      continue;
    }
    const forcedRev = input.forcedRevisions?.[skillId];
    if (forcedRev) {
      seen.add(skillId);
      out.push({
        skillId,
        skillRevisionId: forcedRev,
        selectionSource: SELECTION_SOURCES.userForced,
      });
    }
    // else: an id that is neither recommended nor supplied with a revision is
    // dropped — never guess a revision.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery resolution (AC-2: consumed end-to-end, fallback when no set).
// ---------------------------------------------------------------------------

export type DeliverySource = "selected_set" | "computed_fallback";

/**
 * Resolve the authoritative skill-id list a delivery path delivers:
 *   - a NON-EMPTY selected set → its skill ids (dedup, first-seen order). The
 *     delivery path consumes the set and does NOT recompute.
 *   - an EMPTY set → the caller's computed assignment (today's behavior).
 *
 * The single seam both the execution snapshot and the llm-bridge call so the
 * "confirmed set changes what BOTH deliver; no set ⇒ unchanged" contract holds
 * from one implementation.
 */
export function resolveRunSkillDelivery(input: {
  selectedSet: ReadonlyArray<{ skillId: string }>;
  computedAssignedIds: string[];
}): { skillIds: string[]; source: DeliverySource } {
  if (input.selectedSet.length > 0) {
    const seen = new Set<string>();
    const skillIds: string[] = [];
    for (const s of input.selectedSet) {
      if (seen.has(s.skillId)) continue;
      seen.add(s.skillId);
      skillIds.push(s.skillId);
    }
    return { skillIds, source: "selected_set" };
  }
  return { skillIds: input.computedAssignedIds, source: "computed_fallback" };
}

// ---------------------------------------------------------------------------
// Efficacy signal (AC-6): accepted vs rejected recommendations.
// ---------------------------------------------------------------------------

export interface RecommendationEfficacy {
  /** Recommended skill ids the human/headless run KEPT (accepted). */
  accepted: string[];
  /** Recommended skill ids the run did NOT keep (rejected/ignored). */
  rejected: string[];
}

/**
 * Summarize acceptance vs rejection for the efficacy surface (#1368 alignment —
 * consume, don't fork): of the skills that were RECOMMENDED, which the final
 * selection kept (accepted) and which it dropped (rejected). Deterministic;
 * order follows the recommendation ranking.
 */
export function summarizeRecommendationEfficacy(input: {
  recommendations: RankedRecommendation[];
  selectedSkillIds: string[];
}): RecommendationEfficacy {
  const selected = new Set(input.selectedSkillIds);
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const r of input.recommendations) {
    if (!r.recommended) continue; // only skills we actually recommended
    if (selected.has(r.skillId)) accepted.push(r.skillId);
    else rejected.push(r.skillId);
  }
  return { accepted, rejected };
}
