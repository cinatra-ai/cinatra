// ---------------------------------------------------------------------------
// UX dropdown pre-filter for scope-containment.
//
// `PermissionsScreen` (`packages/agents/src/instance-screens.tsx`) builds
// `availableScopes` from the session's full membership hierarchy. For an
// agent_run permissions form, that set should be filtered to only show
// scopes within the parent agent_template's access policy — otherwise the
// dropdown invites the user to pick a scope the server-side validator
// would then reject.
//
// Pure shape: takes the actor-derived `availableScopes` + the parent
// template's policy + the parent template's resolved orgId, returns a
// narrowed copy. No DB lookups in here; team→org parentage is already
// modeled in `availableScopes.orgs[].teams[]`.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

// Re-declared here to avoid an import cycle through the client component.
// The shape MUST match `src/components/access-combobox-hierarchical.tsx`
// `AvailableScopes`.
export type FilterableAvailableScopes = {
  orgs: Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>;
  projects: Array<{ id: string; name: string }>;
  canGrantWorkspace: boolean;
};

/**
 * Returns a copy of `scopes` containing only entries within ALL THREE of
 * the parent policy's visibility fields (intersection, not union).
 *
 * **Strategy — intersection.** The form locksteps all
 * three visibility fields to a single value (`runListVisibility ===
 * runDataVisibility === runExecuteVisibility`), so the dropdown should
 * only show choices that pass containment for ALL three fields. Using
 * the union (any one field admits it) leaves the user picking values
 * that the server-side validator then rejects.
 *
 * Resolves legacy "org" to "org:<resolvedRunOrgId>" when an orgId is
 * supplied; otherwise treats legacy "org" as widening (admits anything
 * org-scoped — fail-open at the UX layer is acceptable because the
 * server-side validator is authoritative).
 */
export function filterAvailableScopesForParentPolicy(
  scopes: FilterableAvailableScopes,
  parentPolicy: AgentAuthPolicy,
  resolvedTemplateOrgId: string | null,
): FilterableAvailableScopes {
  // Compute, for each field, the set of resolved ids it admits at each
  // tier. The dropdown shows the intersection across all three.
  type Admitted = {
    orgIds: Set<string>;
    teamIds: Set<string>;
    projectIds: Set<string>;
    admitAnyOrg: boolean;
    admitWorkspace: boolean;
  };
  const empty = (): Admitted => ({
    orgIds: new Set(),
    teamIds: new Set(),
    projectIds: new Set(),
    admitAnyOrg: false,
    admitWorkspace: false,
  });

  function admitsFor(v: AgentAuthPolicyVisibility): Admitted {
    const a = empty();
    if (v === "workspace") {
      a.admitWorkspace = true;
      return a;
    }
    if (v === "owner" || v === "admin") return a;
    if (v === "org") {
      if (resolvedTemplateOrgId) a.orgIds.add(resolvedTemplateOrgId);
      else a.admitAnyOrg = true;
      return a;
    }
    if (v.startsWith("org:")) {
      a.orgIds.add(v.slice("org:".length));
      return a;
    }
    if (v.startsWith("team:")) {
      a.teamIds.add(v.slice("team:".length));
      return a;
    }
    if (v.startsWith("project:")) {
      a.projectIds.add(v.slice("project:".length));
      return a;
    }
    return a;
  }

  const fields = [
    admitsFor(parentPolicy.runListVisibility),
    admitsFor(parentPolicy.runDataVisibility),
    admitsFor(parentPolicy.runExecuteVisibility),
  ];

  // Intersection. Workspace is "anything below" — intersected with a
  // non-workspace field, the non-workspace wins (the latter is narrower).
  const allWorkspace = fields.every((f) => f.admitWorkspace);
  if (allWorkspace) {
    return scopes;
  }

  // Build intersection sets.
  function intersectSets(getter: (a: Admitted) => Set<string>): Set<string> {
    return fields.reduce<Set<string>>((acc, f, i) => {
      // A field that admits-any-org or admits-workspace is treated as
      // not-narrowing for the org/team/project axis it doesn't restrict.
      // workspace admits everything → skip narrowing.
      if (f.admitWorkspace) return acc;
      const s = getter(f);
      if (i === 0) return new Set(s);
      return new Set([...acc].filter((x) => s.has(x)));
    }, new Set());
  }

  const admittedOrgIds = intersectSets((f) => f.orgIds);
  const admittedTeamIds = intersectSets((f) => f.teamIds);
  const admittedProjectIds = intersectSets((f) => f.projectIds);
  // admitAnyOrg only when EVERY field has admitAnyOrg or admitWorkspace.
  const admitAnyOrg = fields.every((f) => f.admitAnyOrg || f.admitWorkspace);

  const filteredOrgs = scopes.orgs
    .map((org) => {
      // Include this org if the parent admits it directly OR if any of
      // its teams are admitted (in which case we still need the org
      // shell for the picker hierarchy).
      const orgAdmitted = admitAnyOrg || admittedOrgIds.has(org.id);
      const filteredTeams = org.teams.filter((team) => admittedTeamIds.has(team.id));
      if (!orgAdmitted && filteredTeams.length === 0) return null;
      return {
        ...org,
        // If the org itself isn't admitted but only specific teams are,
        // show only those teams; otherwise show all teams under the
        // admitted org (the parent admits the whole org).
        teams: orgAdmitted ? org.teams : filteredTeams,
      };
    })
    .filter((x): x is FilterableAvailableScopes["orgs"][number] => x !== null);

  const filteredProjects = scopes.projects.filter((p) => admittedProjectIds.has(p.id));

  return {
    orgs: filteredOrgs,
    projects: filteredProjects,
    // canGrantWorkspace stays false because no parent field is workspace
    // (that path returned early above).
    canGrantWorkspace: false,
  };
}
