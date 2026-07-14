// ---------------------------------------------------------------------------
// Pure helpers for the project agent-template bind picker (cinatra#1503,
// design cinatra#1509 §4.4).
//
// Kept OUT of ./actions.ts ("use server" modules may only export async
// functions) so the authority gate, the bound-id exclusion, and the
// client-side catalog filter are plain unit-testable functions — the
// access-team-hydration.ts precedent from #1546.
// ---------------------------------------------------------------------------

import type { ProjectGrant } from "@/lib/authz/actor-context";

/**
 * One installed agent template the bind picker can offer. `agentTemplateId`
 * is the canonical npm packageName (the same value the raw bind form accepted,
 * e.g. `@cinatra-ai/agent-scrape`) — the `project_agent_template_bindings`
 * rows key on it.
 */
export type BindableAgentTemplate = {
  agentTemplateId: string;
  humanReadableName: string;
  description: string;
};

// Mirrors PROJECT_ROLE_RANK in packages/projects/src/mcp/handlers.ts — the
// gate the `project_agent_template_bindings_create` handler enforces
// (`assertProjectGrantRole(actor, project, "write")`). The rank map is
// deliberately duplicated at this thin UI-action layer (the handler keeps
// final authority; this only pre-gates the CANDIDATE enumeration on the same
// bind authority — §4.4 "gate it on the same authority as the bind action").
const PROJECT_ROLE_RANK: Record<ProjectGrant["effectiveRole"], number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};

/**
 * True when the actor could pass the bind (create) handler's authority gate:
 * platform_admin bypass, or a canonical project grant for THIS project with
 * role rank >= write. Pure — the inputs are exactly what
 * `buildBindingsActor()` already stamps on the actor.
 */
export function hasProjectBindAuthority(input: {
  platformAdmin: boolean;
  projectGrants: readonly ProjectGrant[];
  projectId: string;
}): boolean {
  if (input.platformAdmin) return true;
  const grant = input.projectGrants.find(
    (g) => g.projectId === input.projectId,
  );
  if (!grant) return false;
  return PROJECT_ROLE_RANK[grant.effectiveRole] >= PROJECT_ROLE_RANK.write;
}

/**
 * Project the installed-agents catalog onto the bindable-template shape:
 * drop entries without a resolvable packageId, drop templates the project
 * already binds, dedupe by id, and sort by display name (locale-aware) so the
 * picker list is stable. An empty display name falls back to the id — the
 * picker never renders a nameless row (the id stays the secondary line).
 */
export function toBindableTemplates(
  installed: ReadonlyArray<{
    packageId: string;
    humanReadableName: string;
    description: string;
  }>,
  boundTemplateIds: Iterable<string>,
): BindableAgentTemplate[] {
  const bound = new Set(boundTemplateIds);
  const seen = new Set<string>();
  const out: BindableAgentTemplate[] = [];
  for (const agent of installed) {
    const id = agent.packageId?.trim();
    if (!id || bound.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      agentTemplateId: id,
      humanReadableName: agent.humanReadableName?.trim() || id,
      description: agent.description ?? "",
    });
  }
  return out.sort((a, b) =>
    a.humanReadableName.localeCompare(b.humanReadableName),
  );
}

/**
 * Client-side catalog filter (§4.4 — candidates are server-listed once, then
 * filtered client-side at catalog scale). Case-insensitive substring match
 * over the display name, the template/package id, and the description.
 */
export function filterBindableTemplates(
  items: readonly BindableAgentTemplate[],
  query: string,
): BindableAgentTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (t) =>
      t.humanReadableName.toLowerCase().includes(q) ||
      t.agentTemplateId.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q),
  );
}
