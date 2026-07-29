/**
 * Test-only construction of a `ResolvedInjectedSkillSet`.
 *
 * There is deliberately NO exported constructor for the branded set — a test
 * builds one the same way production does, by running the REAL resolver against
 * stub ports. That keeps the tests honest (they exercise the ranking, the cap,
 * and the attribution refusal) and keeps AC-1 true: nothing but
 * `resolveInjectedSkillSet` can mint a set.
 */
import {
  resolveInjectedSkillSet,
  type ResolvedInjectedSkillSet,
} from "@cinatra-ai/skills/injection";

export function makeInjectedSkillSet(input: {
  /** Required (declared-dependency rank) catalog skill ids. */
  skillIds?: string[];
  /** Recommendation-rank catalog skill ids. */
  recommendedSkillIds?: string[];
  /** The personal delta, when the case needs one. */
  delta?: { skillId: string; content: string; revisionId?: string };
}): Promise<ResolvedInjectedSkillSet> {
  return resolveInjectedSkillSet(
    {
      kind: "agent-run",
      agentId: "test-agent",
      runId: "test-run",
      userId: "test-user",
    },
    {
      authorizeAgentRun: async () => ({
        ok: true,
        runOwnerUserId: "test-user",
      }),
      resolveDeclaredDependencySkills: async () =>
        (input.skillIds ?? []).map((skillId) => ({ skillId })),
      resolveRunRecommendedSkills: async () =>
        (input.recommendedSkillIds ?? []).map((skillId) => ({ skillId })),
      resolvePersonalDelta: async () => input.delta ?? null,
    },
  );
}

/** The empty set — a skill-free skill-aware call. */
export function emptyInjectedSkillSet(): Promise<ResolvedInjectedSkillSet> {
  return makeInjectedSkillSet({});
}
