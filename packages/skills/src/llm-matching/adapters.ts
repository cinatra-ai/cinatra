/**
 * Shared adapters used by every entry point into the skill-matching evaluator.
 *
 * Inline, batch, and admin evaluation must use the same adapter shape.
 * Keeping these helpers centralized prevents transport-specific divergence:
 * `matchWhenRaw` must be present so the admin "Re-evaluate" handler uses the
 * rule short-circuit and computes the same `skillInputHash` as the inline and
 * batch transports for the same (agent, skill) pair.
 *
 * Lifting both helpers here forces every entry point through the same shape:
 * the same hash, the same rule short-circuit, and no entry-point-specific
 * behavior.
 *
 * NOTE: kept tree-shake-friendly — no side effects, no imports of stores /
 * registries / orchestration; only the static types from ./types.
 */

import { readMatchWhenRaw } from "../frontmatter";
import type { AgentForMatching, SkillForMatching } from "./types";

/**
 * Extract the raw `match_when:` block (or inline value) from a SKILL.md body.
 * Delegates to the shared, YAML-aware reader in `../frontmatter`, which reads
 * `metadata.match_when` PREFERRED and falls back to the legacy top-level
 * `match_when:` (Skills cluster Wave-0 dual-read). The shared reader returns the
 * raw YAML text the downstream `match-when-parser.ts` re-parses, so the shared
 * evaluator core sees the same declaration as the declarative rule path in
 * `packages/skills/src/matching.ts`.
 *
 * Returns `undefined` when no `match_when` is declared in either location —
 * `evaluatePair` treats this as "no rules, route to LLM".
 */
export function extractMatchWhenRaw(skillContent: string): string | undefined {
  return readMatchWhenRaw(skillContent);
}

/**
 * Adapt a catalog agent row into the SkillForMatching-counterpart shape used
 * by the evaluator. version is intentionally omitted — absence is a stable
 * hash input.
 */
export function adaptAgentForMatching(a: {
  packageId: string;
  humanReadableName?: string;
  packageName: string;
  description: string;
  keywords: string[];
}): AgentForMatching {
  return {
    packageId: a.packageId,
    name: a.humanReadableName ?? a.packageName,
    description: a.description ?? "",
    tags: Array.isArray(a.keywords) ? a.keywords : [],
  };
}

/**
 * Adapt an installed skill / custom skill row into the SkillForMatching
 * shape used by the evaluator.
 *
 * `matchWhenRaw` MUST be extracted here so:
 *   1. evaluateRuleShortCircuit sees the rule text and can short-circuit,
 *   2. computeSkillInputHash hashes the same bytes regardless of entry point.
 *
 * Omitting `matchWhenRaw` causes the admin handler to:
 *   - skip rule short-circuit (forcing a paid LLM call for free rule matches)
 *   - compute a different skillInputHash than inline/batch transports for
 *     the same skill content (breaking the hash consistency invariant).
 */
export function adaptSkillForMatching(s: {
  id: string;
  name: string;
  level?: string;
  content: string;
  agentId?: string | undefined;
}): SkillForMatching {
  return {
    skillId: s.id,
    name: s.name,
    // Custom skill rows without a level fall back to "system" so downstream
    // readers see a value that's still in the SkillLevel union.
    level: s.level ?? "system",
    agentId: s.agentId,
    content: s.content ?? "",
    matchWhenRaw: extractMatchWhenRaw(s.content ?? ""),
  };
}
