/**
 * Rule short-circuit evaluator.
 *
 * Returns a non-null `source: "rule"` decision when the skill's `match_when`
 * explicitly resolves to true for the given agent. The caller (evaluate-pair.ts)
 * MUST NOT call the LLM in that case.
 *
 * Returns null when match_when is:
 *   - absent (caller goes to LLM)
 *   - malformed (caller goes to LLM with raw text as hint)
 *   - present but no clause resolves to true for this pair (caller goes to LLM)
 *
 * Clause grammar (mirrors packages/skills/src/matching.ts evaluateSkillMatchRules):
 *   - `always`              -> always true
 *   - `agent_id: <id>`      -> true iff clause.agent_id === agent.packageId
 *   - `agent_has_tag: <tag>` -> true iff agent.tags includes clause.agent_has_tag
 *
 * Multiple clauses combine with OR semantics (first true wins).
 */

import { RULE_MATCHER_VERSION } from "./constants";
import { computeInputHashes } from "./hashes";
import { parseMatchWhen, type MatchWhenClause } from "./match-when-parser";
import type { AgentForMatching, SkillForMatching, SkillMatchRow } from "./types";

export function evaluateRuleShortCircuit(
  agent: AgentForMatching,
  skill: SkillForMatching,
): Omit<SkillMatchRow, "evaluatedAt" | "jobStartedAt"> | null {
  const parsed = parseMatchWhen(skill.matchWhenRaw, skill.skillId);
  if (parsed.kind !== "ok") return null;
  if (parsed.clauses.length === 0) return null;

  for (const clause of parsed.clauses) {
    if (clauseMatches(clause, agent)) {
      const { agentInputHash, skillInputHash } = computeInputHashes(agent, skill);
      return {
        agentId: agent.packageId,
        skillId: skill.skillId,
        source: "rule",
        matched: true,
        score: 1.0,
        rationale: `Rule short-circuit: ${describeClause(clause)}`,
        evaluatorVersion: RULE_MATCHER_VERSION,
        agentInputHash,
        skillInputHash,
        status: "ok",
        errorCode: null,
        errorMessage: null,
      };
    }
  }
  return null;
}

function clauseMatches(clause: MatchWhenClause, agent: AgentForMatching): boolean {
  if ("always" in clause && clause.always === true) return true;
  if ("agent_id" in clause && typeof (clause as { agent_id: unknown }).agent_id === "string") {
    return (clause as { agent_id: string }).agent_id === agent.packageId;
  }
  if (
    "agent_has_tag" in clause &&
    typeof (clause as { agent_has_tag: unknown }).agent_has_tag === "string"
  ) {
    return agent.tags.includes((clause as { agent_has_tag: string }).agent_has_tag);
  }
  return false;
}

function describeClause(clause: MatchWhenClause): string {
  if ("always" in clause) return "always";
  if ("agent_id" in clause) return `agent_id=${(clause as { agent_id: string }).agent_id}`;
  if ("agent_has_tag" in clause) {
    return `agent_has_tag=${(clause as { agent_has_tag: string }).agent_has_tag}`;
  }
  return "unknown";
}
