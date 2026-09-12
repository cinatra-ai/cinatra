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
import {
  buildSkillIdDisplayNames,
  buildSkillIdVendorNames,
  scanSkillExtensions,
} from "../extension-skill-resolver";
import { readSkillActiveRevisionFromDatabase } from "@/lib/skill-lifecycle-store";
import {
  scoreSkillRecommendations,
  type RankedRecommendation,
  type RecommendationCandidate,
  type RunIntent,
  buildRecommendationTruncation,
  orderRankAuthoritative,
  type RecommendationTruncationV1,
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
  /** cinatra#2815 S3 part (4): the ELIGIBLE pool size, written back for the
   *  RecommendationOrderingV1 truncation record. Optional so every landed
   *  caller is untouched. */
  poolOut?: { eligibleCount: number },
): Promise<RecommendationCandidate[]> {
  let eligiblePoolCount = 0;
  try {
    return await buildCandidates();
  } finally {
    if (poolOut) poolOut.eligibleCount = eligiblePoolCount;
  }

  async function buildCandidates(): Promise<RecommendationCandidate[]> {
  const [matches, skills, labels] = await Promise.all([
    readSkillMatchesByAgent(input.agentId).catch((): SkillMatchRow[] => []),
    listInstalledSkills().catch((): SkillManifest[] => []),
    // THE LABEL EVERY SURFACE PRINTS (cinatra#2841). A catalog row's `name` is
    // the SKILL.md frontmatter name — the slug — while the human title is the
    // owning extension's manifest `cinatra.displayName`. It is resolved HERE,
    // once, server-side, beside the rest of the candidate's metadata, so the
    // chip-row, its ADJUST panel, the settled row and the read-only reading all
    // print one resolved label and no client ever re-derives one.
    //
    // BEST-EFFORT: a failed scan costs LABELS, never candidates. Every skill
    // then falls back to its catalog name, which is exactly what shipped before.
    //
    // THE VENDOR RIDES THE SAME SCAN (cinatra#3047). The Skills step's pill
    // reads "<Skill name> by <vendor>", and both halves come from the owning
    // extension's manifest — so they are read from ONE scan, joined here, and
    // can never be resolved from two different packages. The vendor half is
    // resolved by the platform's own vendor resolver; a package that declares
    // no vendor gets none, and the pill prints the name alone.
    scanSkillExtensions()
      .then((descriptors) => ({
        displayNames: buildSkillIdDisplayNames(descriptors),
        vendorNames: buildSkillIdVendorNames(descriptors),
      }))
      .catch(() => ({
        displayNames: new Map<string, string>(),
        vendorNames: new Map<string, string>(),
      })),
  ]);
  const declaredDisplayNames = labels.displayNames;
  const declaredVendorNames = labels.vendorNames;

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
  //
  // TRUNCATION HAPPENS AFTER ELIGIBILITY (cinatra#2815 S3 part 4, bound by
  // RecommendationOrderingV1). `eligible` IS the pool the record counts: the
  // installed catalog intersected with the restriction. Only then is the cap
  // applied — cutting first would let an ineligible id consume a slot a
  // deliverable skill should have had.
  const eligible = skills
    .filter((s) => (restrict ? restrict.has(s.id) : matchBySkill.has(s.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const candidateSkills = eligible.slice(
    0,
    input.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  );
  eligiblePoolCount = eligible.length;

  return candidateSkills.map((skill) => {
    const match = matchBySkill.get(skill.id);
    return {
      skillId: skill.id,
      skillRevisionId: resolvePinnedRevision(skill.id),
      name: skill.name,
      // Undefined when the owning extension declares no title (or owns no
      // manifest at all — a user-authored custom skill): the scorer's own
      // fallback then keeps `name` as the label. Never a guess, never a map.
      displayName: declaredDisplayNames.get(skill.id),
      // Undefined when the owning extension declares no vendor identity and no
      // npm author — the pill then prints the skill's name with no "by".
      vendorName: declaredVendorNames.get(skill.id),
      description: skill.description ?? "",
      cueText: (skill.content ?? "").slice(0, CUE_CHARS),
      level: skill.level as string | undefined,
      baseMatchScore: typeof match?.score === "number" ? match.score : null,
      baseMatched: match?.matched ?? false,
    };
  });
  }
}

/**
 * THE RANK-AUTHORITATIVE ENTRY (cinatra#2815 S3 part 4).
 *
 * Same scoring as `recommendSkillsForAgentTask`, plus the two things a
 * PERSISTED decision needs and an advisory one does not: the ordering applied
 * explicitly under RecommendationOrderingV1 (so the stored boundary is the
 * bound one, not whatever order a caller happened to iterate), and the
 * truncation record that says how big the eligible pool was and how much of it
 * the cap removed.
 *
 * The caller's `restrictToSkillIds` is what makes the ranking authoritative:
 * the ranks are ranks WITHIN the restricted pool, which is exactly the set the
 * persistence path is allowed to write.
 */
export async function recommendSkillsForAgentTaskOrderedV1(
  input: RecommendSkillsForAgentInput,
): Promise<{
  recommendations: RankedRecommendation[];
  truncation: RecommendationTruncationV1;
}> {
  const pool = { eligibleCount: 0 };
  const candidates = await buildRecommendationCandidatesForAgent(input, pool);
  const scored = scoreSkillRecommendations({ intent: input.intent, candidates });
  return {
    recommendations: orderRankAuthoritative(scored),
    truncation: buildRecommendationTruncation({
      eligibleCount: pool.eligibleCount,
      keptCount: candidates.length,
    }),
  };
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
