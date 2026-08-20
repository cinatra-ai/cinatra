// §V's settled per-chip evidence reading — a PURE module, deliberately outside
// the "use server" boundary: the server-actions compiler requires every export
// of an actions file to be async, and this helper is synchronous by nature.
import { SELECTION_SOURCES } from "@cinatra-ai/skills/recommendation";
import type {
  RunRejectedRecommendation,
  RunSelectedSkillRevision,
} from "@/lib/run-selected-skill-revisions";

/**
 * What ONE chip recorded, for the SETTLED reading the ratified drawing fixes
 * (design `specs/app-lifecycle-cards.html` §V at 60b27dfbb8a2: "one chip per
 * skill, each showing what it recorded"). Derived from the run's OWN durable
 * evidence — nothing new is written to represent it:
 *
 *   confirmed — a selection row whose source is `recommended_confirmed`
 *               (the reader took the skill as scored);
 *   adjusted  — a selection row whose source is `user_forced` (the reader
 *               edited that skill's selection onto the run);
 *   skipped   — a rejected-recommendation row (`recommended_not_kept` from a
 *               confirm that left it out, or `user_skipped` from a skip).
 */
export type RunRecommendationDecidedSkill = {
  skillId: string;
  mark: "confirmed" | "adjusted" | "skipped";
};

/**
 * Build §V's settled per-chip reading out of the two durable halves the run
 * already writes. A selection row wins over a rejected row for the same skill
 * (a skill that is IN the run's authoritative set was kept, whatever else was
 * recorded on the way), and the order is by skill id so the settled row is
 * stable across reads.
 */
export function decidedSkillsFromEvidence(
  selected: Pick<RunSelectedSkillRevision, "skillId" | "selectionSource">[],
  rejected: Pick<RunRejectedRecommendation, "skillId">[],
): RunRecommendationDecidedSkill[] {
  const marks = new Map<string, RunRecommendationDecidedSkill["mark"]>();
  for (const row of selected) {
    marks.set(
      row.skillId,
      row.selectionSource === SELECTION_SOURCES.userForced ? "adjusted" : "confirmed",
    );
  }
  for (const row of rejected) {
    if (!marks.has(row.skillId)) marks.set(row.skillId, "skipped");
  }
  return [...marks.entries()]
    .map(([skillId, mark]) => ({ skillId, mark }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}
