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
  /**
   * A human opened ADJUST on a skill the scorer DID recommend and settled it
   * there (cinatra#2841). It is neither `recommended_confirmed` — the reader did
   * not take the scored offer as it stood, they inspected and shaped it — nor
   * `user_forced`, which asserts the scorer never recommended the skill at all
   * and would misreport the acceptance signal the efficacy surface reads. §V's
   * settled row draws exactly this distinction as its `Adjusted` mark.
   */
  userAdjusted: "user_adjusted",
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
 *
 * IN-SET ADJUSTMENT (cinatra#2841). `adjustedSkillIds` names the kept skills the
 * reader settled through the chip's ADJUST panel rather than by taking the
 * scored offer. For a skill that IS in the recommendation set that is stamped
 * `user_adjusted`, so §V's third settled mark is reachable for the set the row
 * actually offers. It changes nothing about WHICH revision is pinned — an
 * adjusted in-set skill still rides the exact revision it was recommended at —
 * and a skill that was never recommended stays `user_forced`, because forcing it
 * on IS its adjustment and re-labelling it would lose that fact.
 */
export function deriveConfirmedSelection(input: {
  recommendations: RankedRecommendation[];
  confirmedSkillIds: string[];
  /** Pinned revision id for a forced (non-recommended) skill: skillId → revId. */
  forcedRevisions?: Record<string, string>;
  /** Kept skills the reader settled through ADJUST — see the note above. */
  adjustedSkillIds?: string[];
}): RunSkillSelectionEntry[] {
  const recById = new Map(input.recommendations.map((r) => [r.skillId, r]));
  const adjusted = new Set(input.adjustedSkillIds ?? []);
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
        selectionSource: adjusted.has(skillId)
          ? SELECTION_SOURCES.userAdjusted
          : SELECTION_SOURCES.recommendedConfirmed,
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
// The OFFERED SET (cinatra#2906): a confirm resolves against what was SHOWN.
// ---------------------------------------------------------------------------

/**
 * ONE entry of the set a card actually offered — the four fields that decide an
 * outcome, recorded when the card was drawn: which skill, at which pinned
 * revision, whether it was offered AS a recommendation, and at which rank.
 *
 * Deliberately NOT the presentation fields (label, score, feature breakdown):
 * those describe how a chip looked, and nothing about how a chip looked may
 * change what a run executes.
 */
export interface OfferedSkill {
  skillId: string;
  /** The EXACT revision the chip was drawn at — the pin the confirm honours. */
  skillRevisionId: string;
  /** Whether the scorer recommended it AT DRAW TIME. */
  recommended: boolean;
  /** Its 1-based rank in the offered ordering at draw time. */
  rank: number;
}

/** A confirm resolved against the offered set, or the ids that stopped it. */
export type OfferedSetSelection =
  | { ok: true; selection: RunSkillSelectionEntry[] }
  | { ok: false; staleSkillIds: string[] };

/**
 * Turn a human's confirm/adjust choice into the immutable selection entries
 * USING THE OFFERED SET AS THE AUTHORITY (cinatra#2906).
 *
 * The sibling `deriveConfirmedSelection` resolves the reader's ids against a
 * recommendation set the CALLER scored, so whatever drifted between the draw and
 * the press decides what is pinned. This one resolves them against the set that
 * was drawn, so:
 *
 *   · a kept id present in the offered set is pinned to ITS offered revision,
 *     whatever has been published since;
 *   · a kept id that the offered set never contained, or that the caller reports
 *     can no longer be honoured (no longer assigned, no longer installed), makes
 *     the WHOLE confirm refuse. It is never dropped, because a dropped skill is
 *     a decision the reader took and the run did not record — and dropping the
 *     last one leaves an empty set that delivery reads as "no set" and replaces
 *     with the agent's computed assignment.
 *
 * The refusal is all-or-nothing on purpose: a partially-honoured confirm is a
 * set nobody chose. Order is stable (confirmed order preserved) and the answer
 * is a pure function of its inputs, so a retry against the same offered set
 * produces byte-identical rows.
 *
 * The SOURCE stamp keeps the shipped meanings: a skill the scorer did NOT
 * recommend at draw time is `user_forced` (forcing it on IS its adjustment), a
 * recommended one settled through ADJUST is `user_adjusted`, and a recommended
 * one taken as scored is `recommended_confirmed`.
 */
export function deriveSelectionFromOfferedSet(input: {
  offered: ReadonlyArray<OfferedSkill>;
  confirmedSkillIds: string[];
  /** Kept skills the reader settled through ADJUST — see the note above. */
  adjustedSkillIds?: string[];
  /**
   * The offered ids that can STILL be honoured — resolved by the caller, which
   * is the only layer that can see the live assignment + installed catalogue.
   * An offered id absent from this list is stale, never silently dropped.
   */
  honourableSkillIds: ReadonlyArray<string>;
}): OfferedSetSelection {
  const offeredById = new Map(input.offered.map((o) => [o.skillId, o]));
  const honourable = new Set(input.honourableSkillIds);
  const adjusted = new Set(input.adjustedSkillIds ?? []);
  const seen = new Set<string>();
  const stale: string[] = [];
  const out: RunSkillSelectionEntry[] = [];
  for (const skillId of input.confirmedSkillIds) {
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    const offer = offeredById.get(skillId);
    if (!offer || !honourable.has(skillId)) {
      stale.push(skillId);
      continue;
    }
    out.push({
      skillId,
      // THE OFFERED PIN. Not a re-resolved one, not a client-supplied one.
      skillRevisionId: offer.skillRevisionId,
      selectionSource: !offer.recommended
        ? SELECTION_SOURCES.userForced
        : adjusted.has(skillId)
          ? SELECTION_SOURCES.userAdjusted
          : SELECTION_SOURCES.recommendedConfirmed,
    });
  }
  if (stale.length > 0) return { ok: false, staleSkillIds: stale };
  return { ok: true, selection: out };
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
  /**
   * The set the tally describes. Widened to the two fields it actually reads
   * (cinatra#2906) so the confirm path can pass the OFFERED set — the scored set
   * a reader was really shown — rather than a freshly scored one that may name
   * different skills.
   */
  recommendations: ReadonlyArray<Pick<RankedRecommendation, "skillId" | "recommended">>;
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
