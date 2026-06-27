/**
 * Pure filter for the personal-skill authoring "Agent" dropdown.
 *
 * `readAgentsForSkillMatching()` is the canonical installed-agents reader: it
 * returns `agent_templates WHERE packageName IS NOT NULL AND status IN
 * ('active', 'published')` unioned with provider-declared agents on disk. That
 * set is the right axis for the skill MATCHER (which must still consider the
 * internal `@cinatra/system-*` runtime templates that back scrape/research/
 * enrichment runs).
 *
 * The personal-skill authoring surface (`/skills/new`, `/skills/:id/edit`) has
 * a narrower contract: a user attaches a personal skill to an agent they
 * actually operate. The internal `system-*` templates are runtime plumbing,
 * not user-facing agents, so they must NOT appear in that dropdown — and the
 * save action must reject them even when an `agentId` is POSTed directly.
 *
 * The slug derivation in `readAgentsForSkillMatching()` strips the npm scope
 * (`@cinatra/system-scrape` -> `system-scrape`), so the `system-` prefix
 * survives into the `PersistedAgent.id`. That prefix is the authoritative
 * signal, mirroring the `system-*` id reservation used elsewhere (e.g. the
 * dashboards `RESERVED_SYSTEM_DASHBOARD_PREFIX`).
 */

/** Reserved id prefix for internal, non-user-facing system agents. */
export const SYSTEM_AGENT_ID_PREFIX = "system-";

/** True when `id` belongs to an internal `system-*` agent. */
export function isSystemAgentId(id: string): boolean {
  return id.startsWith(SYSTEM_AGENT_ID_PREFIX);
}

/**
 * Narrow an installed-agents list down to the agents a user can attach a
 * personal skill to: currently-installed/registered (the input already is, via
 * `readAgentsForSkillMatching()`) and non-system.
 */
export function selectAttachableAgents<T extends { id: string }>(
  agents: ReadonlyArray<T>,
): T[] {
  return agents.filter((agent) => !isSystemAgentId(agent.id));
}
