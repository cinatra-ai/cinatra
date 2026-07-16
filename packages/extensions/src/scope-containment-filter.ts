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
// The shape MUST match `src/components/access-scope.ts` `AvailableScopes`
// (re-exported by the unified `src/components/access-combobox.tsx`).
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

  // Multi-scope W2: fields are NON-EMPTY token arrays. The admitted set for a
  // field is the UNION of every token's admitted set (any-match: a scope the
  // field admits is one SOME token admits). A single-token field reduces to the
  // pre-array `admitsFor(field[0])`.
  function admitsForField(
    selection: readonly AgentAuthPolicyVisibility[],
  ): Admitted {
    const acc = empty();
    for (const v of selection) {
      const a = admitsFor(v);
      for (const id of a.orgIds) acc.orgIds.add(id);
      for (const id of a.teamIds) acc.teamIds.add(id);
      for (const id of a.projectIds) acc.projectIds.add(id);
      acc.admitAnyOrg = acc.admitAnyOrg || a.admitAnyOrg;
      acc.admitWorkspace = acc.admitWorkspace || a.admitWorkspace;
    }
    return acc;
  }

  // Per-field union; the cross-field INTERSECTION below is unchanged (the form
  // locksteps all three fields, so a shown scope must pass every field).
  const fields = [
    admitsForField(parentPolicy.runListVisibility),
    admitsForField(parentPolicy.runDataVisibility),
    admitsForField(parentPolicy.runExecuteVisibility),
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

// ---------------------------------------------------------------------------
// Subsumption bridge (cinatra#1607 AC2 / spec §6.4): the agent_template's
// three-field visibility intersection is the general `allowedScopes` case of
// the access picker's first-class containment contract — NOT a single
// `parentScope`. This adapter expresses this one-off pre-filter as a typed
// `allowedScopes` PREDICATE the unified `AccessCombobox` consumes directly, so
// the picker's `allowedScopes` prop subsumes what this module did per-site.
//
// The predicate is DERIVED from `filterAvailableScopesForParentPolicy` above, so
// it admits EXACTLY the identities that survive the intersection filter (proven
// by an equivalence test) — no re-implementation of the intersection algebra.
//
// The scope identity is re-declared locally (structurally identical to the
// picker's `ScopeIdentity`) to keep the package→app boundary clean, mirroring
// the `FilterableAvailableScopes` re-declaration above.
// ---------------------------------------------------------------------------

export type ScopeIdentityLike = {
  kind: "personal" | "project" | "team" | "org" | "workspace" | "admin";
  id?: string;
};

/**
 * Build a typed `allowedScopes` predicate from an agent_template policy — the
 * §6.4 mapping of the three-field intersection onto the picker's lower-level
 * containment constraint. Personal is always admitted (§6.2 — never dropped by
 * containment); `admin` is not an agent-run grant target and is excluded.
 */
export function allowedScopesFromPolicy(
  scopes: FilterableAvailableScopes,
  parentPolicy: AgentAuthPolicy,
  resolvedTemplateOrgId: string | null,
): (scope: ScopeIdentityLike) => boolean {
  const filtered = filterAvailableScopesForParentPolicy(
    scopes,
    parentPolicy,
    resolvedTemplateOrgId,
  );
  const orgIds = new Set(filtered.orgs.map((o) => o.id));
  const teamIds = new Set(filtered.orgs.flatMap((o) => o.teams.map((t) => t.id)));
  const projectIds = new Set(filtered.projects.map((p) => p.id));
  return (scope) => {
    switch (scope.kind) {
      case "personal":
        return true;
      case "workspace":
        return filtered.canGrantWorkspace;
      case "admin":
        return false;
      case "org":
        return scope.id != null && orgIds.has(scope.id);
      case "team":
        return scope.id != null && teamIds.has(scope.id);
      case "project":
        return scope.id != null && projectIds.has(scope.id);
    }
  };
}
