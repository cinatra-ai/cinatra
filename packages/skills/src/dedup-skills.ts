/**
 * Dropdown view-model helper for `/configuration/skills?tab=matches`.
 *
 * Same logical skill can land in the catalog from multiple installation
 * paths (system + GitHub extension; package rename leaving old + new rows;
 * system + third-party install). The "Add a skill" dropdown should show
 * one entry per logical skill.
 *
 * IMPORTANT: This is NOT applied at `listInstalledSkills()`. Downstream
 * callers (`personal-skills.ts`, `agents/server-actions.ts`) depend on
 * exact skill-id addressability and dedup at the registry layer would
 * drop rows they expect to find. Apply at the dropdown render site, AFTER
 * filtering out agent-linked skills so an agent-linked row can't win
 * dedup with strong provenance and then get filtered out, leaving a
 * legitimate cross-agent skill that shared its name absent from the
 * dropdown.
 *
 * Dedup key: normalized display name (`name.trim().toLowerCase()`).
 * Tie-breaker on collision: strongest provenance wins
 * (system > organization > team > workspace > project > personal >
 * third-party). `level=agent` should not appear here (dropdown filters
 * before calling).
 *
 * Lives in its own file to avoid pulling skills-registry's heavy
 * transitive deps (@/lib/agents-store -> packages/agents barrel ->
 * objects/skills) into the test module graph.
 */

const LEVEL_RANK: Record<string, number> = {
  system: 0,
  organization: 1,
  team: 2,
  workspace: 3,
  project: 4,
  personal: 5,
  "third-party": 6,
  agent: 99, // should not appear here; dropdown filters before calling
};

export function dedupSkillsByName<T extends { name: string; level?: string }>(
  skills: T[],
): T[] {
  const dedupKey = (skill: T) => skill.name.trim().toLowerCase();
  const deduped = new Map<string, T>();
  for (const skill of skills) {
    const key = dedupKey(skill);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, skill);
      continue;
    }
    const existingRank = LEVEL_RANK[existing.level ?? "third-party"] ?? 99;
    const incomingRank = LEVEL_RANK[skill.level ?? "third-party"] ?? 99;
    if (incomingRank < existingRank) {
      deduped.set(key, skill);
    }
  }
  return Array.from(deduped.values());
}
