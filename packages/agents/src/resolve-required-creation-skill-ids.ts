/**
 * STRICT catalog resolver for required creation skills.
 *
 * Unlike `loadReviewerPrompt` in `agent-creation-review.ts` (which CATCHES
 * catalog failures and returns `skillIds: []` for backwards-compat with
 * dev-fresh DB), THIS resolver RETHROWS — the preflight catches and surfaces
 * as `catalog_unavailable`; `runAuthorAgent` lets the error propagate so the
 * caller surfaces the configuration error explicitly.
 *
 * Why "strict" matters here: the Anthropic pin requires `skillIds.length > 0`
 * per lane so the SkillDeliveryAdapter emits a non-empty `container.skills`
 * (else the Anthropic provider's function-tool fallback at `anthropic.ts:466`
 * fires when native MCP fails). A silent `[]` from a swallowed catalog error
 * would mask the real configuration problem — fail loud.
 *
 * Used by:
 *   - `preflight-agent-creation.ts` — collects per-lane skill sets for the
 *     `anthropic_no_skills_resolved` + `catalog_unavailable` checks.
 *   - `run-author-agent.ts` — resolves the author-agent's own
 *     `agent-authoring` skill BEFORE the dispatch-site empty-skill guard.
 */

import "server-only";

export type ResolvedLaneSkillSet = {
  /** The agent's package name (e.g. `@cinatra-ai/security-reviewer-agent`). */
  agentPackageName: string;
  /** Catalog skill ids resolved for this agent. Empty array is a VALID result (catalog returned no matches). */
  skillIds: string[];
};

/**
 * Resolve per-agent skill ids for each named agent package via the catalog
 * (`skills_installed_resolve_for_agent`). Catalog errors are RETHROWN — never
 * swallowed into `skillIds: []`.
 *
 * @param agentPackageNames the agent package names to resolve for (e.g.
 *   `["@cinatra-ai/security-reviewer-agent", "@cinatra-ai/code-reviewer-agent"]`).
 * @returns one entry per input agent, preserving input order, with the
 *   resolved skill ids (or `[]` if the catalog explicitly returned no
 *   matches — vs an error which throws).
 */
export async function resolveRequiredCreationSkillIds(
  agentPackageNames: string[],
): Promise<ResolvedLaneSkillSet[]> {
  // Dynamic import keeps `packages/agents` free of static host-app imports —
  // same pattern as `loadReviewerPrompt`'s `createDeterministicSkillsClient`
  // dynamic-import.
  const { createDeterministicSkillsClient } = await import("@cinatra-ai/skills");
  const skillsClient = createDeterministicSkillsClient({
    // Workspace-scoped read because skills are workspace-visible.
    actor: { actorType: "system", source: "worker" },
  });

  const results: ResolvedLaneSkillSet[] = [];
  for (const agentPackageName of agentPackageNames) {
    // Per-agent error rethrown — NOT swallowed. This is the load-bearing
    // difference vs `loadReviewerPrompt`'s tolerant fallback.
    const resolved = await skillsClient.installed.resolveForAgent({
      agentId: agentPackageName,
    });
    const skillIds = Array.isArray(resolved?.skillIds) ? resolved.skillIds : [];
    results.push({ agentPackageName, skillIds });
  }
  return results;
}
