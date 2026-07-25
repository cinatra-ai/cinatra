/**
 * Server-side CANDIDATE GENERATION + request-aware scoring entry (cinatra#2041,
 * epic #2037 S3, Point R).
 *
 * The one server-side seam that turns an (agent, run-intent) into a ranked
 * recommendation set: it generates candidates from `skill_matches` (the
 * agent-centric base scores) + the installed catalog, pins each to its immutable
 * active skill revision, and hands them to the PURE request-aware scorer. Every
 * request-aware consumer — the run-start interception (chip-row / headless
 * auto-apply) and the MCP "what skills fit this task" primitive — calls THIS, so
 * they share one scoring implementation (no parallel scorer; AC-5).
 *
 * server-only: reads the DB. The scoring itself is the pure
 * `@cinatra-ai/skills/recommendation` core.
 */
import "server-only";

import { readSkillMatchesByAgent } from "../llm-matching/skill-matches-store";
import type { SkillMatchRow } from "../llm-matching/types";
import { listInstalledSkills, type SkillManifest } from "../skills-registry";
import { readSkillActiveRevisionFromDatabase } from "@/lib/skill-lifecycle-store";
import {
  scoreSkillRecommendations,
  type RankedRecommendation,
  type RecommendationCandidate,
  type RunIntent,
} from "./request-aware-scorer";

export interface RecommendSkillsForAgentInput {
  agentId: string;
  intent: RunIntent;
  /** Restrict candidates to these skill ids (e.g. the agent's assigned set).
   * When omitted, candidates are the skills the agent has a `skill_matches`
   * row for (never the whole catalog). */
  restrictToSkillIds?: string[];
  /** Cap on candidates scored — bounds the per-skill revision reads. */
  maxCandidates?: number;
}

export const DEFAULT_MAX_CANDIDATES = 50;

/** How long a content cue we tokenize per candidate (keeps the token surface
 * bounded regardless of SKILL.md length). */
const CUE_CHARS = 400;

/** Resolve a skill's immutable pinned revision, best-effort. Prefers the active
 * lifecycle revision; falls back to a content-addressed pin, then an explicit
 * unpinned marker (never guesses). */
function resolvePinnedRevision(skillId: string): string {
  try {
    const head = readSkillActiveRevisionFromDatabase(skillId);
    if (head?.activeRevisionId) return head.activeRevisionId;
    if (head?.contentDigest) return `content:${head.contentDigest}`;
  } catch {
    // best-effort — a revision read must never break candidate generation.
  }
  return `unpinned:${skillId}`;
}

/**
 * Generate the candidate set for (agent, intent). Candidates are the catalog
 * skills that either carry a `skill_matches` row for the agent OR are named in
 * `restrictToSkillIds`. Deterministic order (skill id ascending) before the
 * `maxCandidates` cap so the scored set is a pure function of DB state.
 */
export async function buildRecommendationCandidatesForAgent(
  input: RecommendSkillsForAgentInput,
): Promise<RecommendationCandidate[]> {
  const [matches, skills] = await Promise.all([
    readSkillMatchesByAgent(input.agentId).catch((): SkillMatchRow[] => []),
    listInstalledSkills().catch((): SkillManifest[] => []),
  ]);

  const matchBySkill = new Map<string, SkillMatchRow>(
    matches.map((m) => [m.skillId, m] as const),
  );
  const restrict = input.restrictToSkillIds ? new Set(input.restrictToSkillIds) : null;

  // When `restrictToSkillIds` is supplied it is a TRUE RESTRICTION (intersection),
  // not an additive union: candidates are the installed skills WHOSE ID IS IN the
  // restrict set (e.g. the agent's assigned, deliverable set). Without it,
  // candidates are the skills the agent has a `skill_matches` row for. Either way
  // an installed-catalog membership is required, so an uninstalled id is dropped.
  // Tie-break uses code-unit order (locale-independent) so the pre-cap candidate
  // set is identical across runtime locales (AC-1 determinism).
  const candidateSkills = skills
    .filter((s) => (restrict ? restrict.has(s.id) : matchBySkill.has(s.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, input.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

  return candidateSkills.map((skill) => {
    const match = matchBySkill.get(skill.id);
    return {
      skillId: skill.id,
      skillRevisionId: resolvePinnedRevision(skill.id),
      name: skill.name,
      description: skill.description ?? "",
      cueText: (skill.content ?? "").slice(0, CUE_CHARS),
      level: skill.level as string | undefined,
      baseMatchScore: typeof match?.score === "number" ? match.score : null,
      baseMatched: match?.matched ?? false,
    };
  });
}

/**
 * Generate candidates + score them against the run intent. The single
 * server-side recommendation entry both the run-start interception and the MCP
 * primitive call.
 */
export async function recommendSkillsForAgentTask(
  input: RecommendSkillsForAgentInput,
): Promise<RankedRecommendation[]> {
  const candidates = await buildRecommendationCandidatesForAgent(input);
  return scoreSkillRecommendations({ intent: input.intent, candidates });
}
