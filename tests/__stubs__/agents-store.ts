// Minimal stub for @/lib/agents-store used in
// src/app/settings/agents/__tests__/save-agent-install-path-action.test.ts.
// The real module pulls @cinatra-ai/skills → @cinatra-ai/llm which
// are not available to the vitest sandbox; the new action under test does
// not touch any of these symbols. We export the shapes that
// src/app/settings/agents/actions.ts imports so its module load succeeds.

export async function matchAgentsToSkills(): Promise<void> {}
export async function readAgentSkillExclusions(): Promise<{
  exclusions: Array<{ id: string; agentId: string; skillId: string; reason?: string }>;
}> {
  return { exclusions: [] };
}
export async function readAgentSkillMatches(): Promise<{
  matches: Array<{
    id: string;
    agentId: string;
    skillId: string;
    score: number;
    rationale?: string;
  }>;
  matchedAt?: string;
}> {
  return { matches: [] };
}
export async function saveAgentSkillExclusions(
  _exclusions: Array<{ id: string; agentId: string; skillId: string; reason?: string }>,
): Promise<void> {}
export async function saveAgentSkillMatches(
  _matches: Array<{
    id: string;
    agentId: string;
    skillId: string;
    score: number;
    rationale?: string;
  }>,
): Promise<void> {}
export async function syncInstalledAgentsToDatabase(): Promise<void> {}
// cinatra#1503: src/app/projects/[projectId]/agents/{actions,page}.tsx import
// the canonical installed-agents reader for the bind picker's candidate
// enumeration / bound-row name resolution. Tests that exercise the action
// vi.mock this module with a factory; the stub keeps module loads safe.
export async function readAgentsForSkillMatching(): Promise<
  Array<{
    id: string;
    identifier: string;
    packageId: string;
    packageName: string;
    packageSlug: string;
    humanReadableName: string;
    description: string;
    keywords: string[];
  }>
> {
  return [];
}
