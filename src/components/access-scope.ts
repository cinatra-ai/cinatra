// ---------------------------------------------------------------------------
// Pure (server- and client-safe) access-scope label helpers.
//
// Split out of access-combobox-hierarchical.tsx (a "use client" module) so that
// server components and shared libs can resolve scope labels without pulling a
// client component into their graph. The combobox re-exports these for existing
// callers.
//
// Labels are title-case ("Workspace: All", "Workspace: Admins only", etc.) and
// are the single source of truth for the trigger, the dropdown rows, and any
// permission-summary text.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

export type AvailableScopes = {
  orgs: Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>;
  projects: Array<{ id: string; name: string }>;
  canGrantWorkspace: boolean;
};

/**
 * Resolve a visibility token to (type, name) for rendering. The closed trigger
 * shows `<type>: <name>`; dropdown rows reuse the same decomposition so the
 * Project / Team / Organization / Workspace / Personal prefixes stay consistent.
 */
export function resolveAccessParts(
  visibility: AgentAuthPolicyVisibility,
  scopes: AvailableScopes,
): { type: string | null; name: string } {
  if (visibility === "owner") return { type: "Personal", name: "Only me" };
  if (visibility === "admin") return { type: "Workspace", name: "Admins only" };
  if (visibility === "workspace") return { type: "Workspace", name: "All" };
  if (typeof visibility === "string" && visibility.startsWith("org:")) {
    const id = visibility.slice("org:".length);
    const name = scopes.orgs.find((o) => o.id === id)?.name ?? scopes.orgs[0]?.name ?? "your organization";
    return { type: "Organization", name };
  }
  if (visibility === "org") {
    return { type: "Organization", name: scopes.orgs[0]?.name ?? "your organization" };
  }
  if (typeof visibility === "string" && visibility.startsWith("team:")) {
    const id = visibility.slice("team:".length);
    const owner = scopes.orgs.find((o) => o.teams.some((t) => t.id === id));
    const team = owner?.teams.find((t) => t.id === id);
    return { type: "Team", name: owner && team ? `${owner.name} - ${team.name}` : id.slice(-6) };
  }
  if (typeof visibility === "string" && visibility.startsWith("project:")) {
    const id = visibility.slice("project:".length);
    const name = scopes.projects.find((p) => p.id === id)?.name ?? `Project ${id.slice(-6)}`;
    return { type: "Project", name };
  }
  return { type: null, name: visibility };
}

export function resolveAccessLabel(
  visibility: AgentAuthPolicyVisibility,
  scopes: AvailableScopes,
): string {
  const parts = resolveAccessParts(visibility, scopes);
  return parts.type ? `${parts.type}: ${parts.name}` : parts.name;
}
