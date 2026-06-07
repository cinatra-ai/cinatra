/**
 * UX dropdown pre-filter tests.
 *
 * Pure (no DB) — exercises `filterAvailableScopesForParentPolicy`
 * against the synthetic `AvailableScopes` shape.
 */
import { describe, it, expect } from "vitest";

import {
  filterAvailableScopesForParentPolicy,
  type FilterableAvailableScopes,
} from "../scope-containment-filter";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const TEAM_X_IN_A = "10000000-0000-0000-0000-000000000001";
const TEAM_Y_IN_B = "10000000-0000-0000-0000-000000000002";
const PROJECT_P_IN_A = "20000000-0000-0000-0000-000000000001";

const baseScopes: FilterableAvailableScopes = {
  orgs: [
    { id: ORG_A, name: "Org A", teams: [{ id: TEAM_X_IN_A, name: "Team X" }] },
    { id: ORG_B, name: "Org B", teams: [{ id: TEAM_Y_IN_B, name: "Team Y" }] },
  ],
  projects: [
    { id: PROJECT_P_IN_A, name: "Project P" },
  ],
  canGrantWorkspace: true,
};

function policy(v: AgentAuthPolicy["runListVisibility"]): AgentAuthPolicy {
  return {
    runListVisibility: v,
    runDataVisibility: v,
    runExecuteVisibility: v,
    allowRunSharing: false,
  };
}

describe("filterAvailableScopesForParentPolicy", () => {
  it("workspace parent — no filtering (returns original)", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy("workspace"), ORG_A);
    expect(result.orgs).toHaveLength(2);
    expect(result.projects).toHaveLength(1);
    expect(result.canGrantWorkspace).toBe(true);
  });

  it("owner parent — empty everything; canGrantWorkspace=false", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy("owner"), ORG_A);
    expect(result.orgs).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.canGrantWorkspace).toBe(false);
  });

  it("org:A parent — only Org A shows, all its teams visible, projects must explicitly admit", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy(`org:${ORG_A}`), ORG_A);
    expect(result.orgs.map((o) => o.id)).toEqual([ORG_A]);
    expect(result.orgs[0]?.teams.map((t) => t.id)).toEqual([TEAM_X_IN_A]);
    expect(result.projects).toEqual([]); // not in parent set
    expect(result.canGrantWorkspace).toBe(false);
  });

  it("team:X parent — only that team visible under its org shell", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy(`team:${TEAM_X_IN_A}`), ORG_A);
    // Org A appears as a shell because its team X is admitted
    expect(result.orgs.map((o) => o.id)).toEqual([ORG_A]);
    expect(result.orgs[0]?.teams.map((t) => t.id)).toEqual([TEAM_X_IN_A]);
    expect(result.projects).toEqual([]);
  });

  it("project:P parent — only that project visible; orgs empty", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy(`project:${PROJECT_P_IN_A}`), ORG_A);
    expect(result.orgs).toEqual([]);
    expect(result.projects.map((p) => p.id)).toEqual([PROJECT_P_IN_A]);
  });

  it("legacy \"org\" parent with templateOrgId — resolves to org:templateOrgId", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy("org"), ORG_A);
    expect(result.orgs.map((o) => o.id)).toEqual([ORG_A]);
  });

  it("admin parent — empty (admin is cross-org peer, no scope tiers admitted)", () => {
    const result = filterAvailableScopesForParentPolicy(baseScopes, policy("admin"), ORG_A);
    expect(result.orgs).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.canGrantWorkspace).toBe(false);
  });

  it("mixed policy (List=workspace, Data=org:A, Execute=team:X) — intersection narrows to Team X under Org A", () => {
    // Intersection (not union). The form locksteps all three
    // visibility fields to a single value, so the dropdown should only show
    // choices that pass ALL three field checks.
    //
    //   List=workspace  → admits everything (no narrowing)
    //   Data=org:A      → admits Org A only
    //   Execute=team:X  → admits Team X only
    //
    // Intersection: Org A's shell + Team X (because Team X is the only
    // admitted entity AND Org A is admitted by Data). canGrantWorkspace is
    // false because Data and Execute are not workspace.
    const mixed: AgentAuthPolicy = {
      runListVisibility: "workspace",
      runDataVisibility: `org:${ORG_A}`,
      runExecuteVisibility: `team:${TEAM_X_IN_A}`,
      allowRunSharing: false,
    };
    const result = filterAvailableScopesForParentPolicy(baseScopes, mixed, ORG_A);
    expect(result.canGrantWorkspace).toBe(false); // not workspace in all 3 fields
    // The intersection of {everything, Org A, Team X} narrows the org/team
    // axis to: orgs ∩ {Org A} ∩ {} = {} (Execute doesn't admit any org
    // directly); teams ∩ {} ∩ {Team X} = {} (Data doesn't admit any team
    // directly). So the strict intersection is empty.
    // This is exactly what we want — the user shouldn't pick a value the
    // server would reject. The previous union behaviour was looser.
    expect(result.orgs).toEqual([]);
    expect(result.projects).toEqual([]);
  });

  it("mixed policy without workspace — intersection of admitted scopes wins", () => {
    // Intersection (not union).
    //   List=owner       → admits nothing in any tier
    //   Data=org:A       → admits Org A
    //   Execute=team:Y   → admits Team Y
    //
    // Intersection: orgs = {} ∩ {Org A} ∩ {} = {}; teams = {} ∩ {} ∩ {Team Y} = {}.
    // Result is empty — because List=owner doesn't admit ANY scope, no
    // higher tier can pass containment against it.
    const mixed: AgentAuthPolicy = {
      runListVisibility: "owner",
      runDataVisibility: `org:${ORG_A}`,
      runExecuteVisibility: `team:${TEAM_Y_IN_B}`,
      allowRunSharing: false,
    };
    const result = filterAvailableScopesForParentPolicy(baseScopes, mixed, ORG_A);
    expect(result.orgs).toEqual([]);
    expect(result.projects).toEqual([]);
  });
});
