// Phase-2 ACL cutover (cinatra#1898, epic #1883 §D7) — the PROPERTY-STYLE
// AGREEMENT proof for acceptance item 1: "library and dashboard surfaces agree
// on every row".
//
// The library gates a dashboard-typed artifact via the SINGLE canonical
// `object.read` filter over the dashboard's scope tuple
// (`evaluateOwnershipVisibility` ∘ `deriveDashboardScopeTuple`). The /dashboards
// surfaces gate via the scope resolver (`filterReadableDashboards` →
// `resolveDashboardAccess` + the project grant). Post-cutover the two MUST return
// the identical verdict for EVERY (dashboard, actor) pair — this test drives a
// generated corpus (all owner tiers × project/non-project × owner/member/
// non-member × grant/no-grant, same-org and cross-org) through BOTH and asserts
// they never disagree. A disagreement here is a real ACL divergence.
//
// The corpus deliberately sets each row's demoted `visibility` column to a value
// that would, under the RETIRED {private, owners, members} vocabulary, have
// changed the verdict — proving the vocabulary no longer participates.
import { describe, expect, it } from "vitest";

import { filterReadableDashboards, type DashboardAuthzActor } from "@/lib/dashboards/authz";
import {
  evaluateOwnershipVisibility,
  vantageFromActor,
  type OwnershipEvalRow,
} from "@/lib/derived-store-ownership";
import { deriveDashboardScopeTuple } from "@/lib/dashboards/dashboard-scope-tuple";
import type { ActorContext } from "@/lib/authz/actor-context";

const ORG = "org-1";

// A dashboard row as the resolver reads it (the retired `visibility` value is
// intentionally hostile — under the old vocabulary a 'private'/'owners' row was
// owner-only; here it must NOT change the verdict).
type Row = {
  id: string;
  organizationId: string;
  ownerLevel: string;
  ownerId: string;
  projectId: string | null;
  visibility: string;
};

function r(id: string, ownerLevel: string, ownerId: string, projectId: string | null, organizationId = ORG): Row {
  return { id, organizationId, ownerLevel, ownerId, projectId, visibility: "private" };
}

// Team ids (t*) and project ids (p*) are org-SCOPED — globally unique to exactly
// one org — which is WHY the object filter's team/project clauses need no org
// re-check. The corpus honors that invariant: org-1 owns t1/p1/p2; org-2 owns
// t9/p9. A corpus that shared a team/project id across orgs would be modeling an
// impossible state (and would spuriously diverge from the org-fenced resolver).
const ROWS: Row[] = [
  r("user-u1", "user", "u1", null),
  r("team-t1", "team", "t1", null),
  r("org-own", "organization", ORG, null),
  r("ws-own", "workspace", ORG, null), // workspace owner_id resolves through the org id
  r("proj-teamowned", "team", "t1", "p1"), // project row whose UNDERLYING owner is a team
  r("proj-orgowned", "organization", ORG, "p2"),
  r("unknown-tier", "cohort", "c9", null), // an unmodeled tier — must fail closed on both
  // A project_id='' ANOMALY (no non-empty DB constraint): both surfaces must treat
  // it as UNSCOPED (truthiness), NOT as a project row that would skip the grant
  // gate on one side while the object filter's project clause never matches ''.
  r("proj-empty-str", "team", "t1", ""),
  r("xorg-org", "organization", "org-2", null, "org-2"), // cross-org org row
  r("xorg-proj", "organization", "org-2", "p9", "org-2"), // cross-org project row (org-2's p9)
];

// Actors. `grants` seeds BOTH the /dashboards projectGrants and the library
// vantage's projectIds (a project member's read gate is the grant on both sides).
type ActorSpec = {
  name: string;
  userId: string;
  organizationId: string;
  teamIds: string[];
  orgRole: "org_owner" | "org_admin" | "member";
  teamRoles: Record<string, "team_admin" | "member">;
  grants: string[];
};

const ACTORS: ActorSpec[] = [
  { name: "u1 self (user owner)", userId: "u1", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {}, grants: [] },
  { name: "team member (non-admin)", userId: "u2", organizationId: ORG, teamIds: ["t1"], orgRole: "member", teamRoles: { t1: "member" }, grants: [] },
  { name: "team admin", userId: "u3", organizationId: ORG, teamIds: ["t1"], orgRole: "member", teamRoles: { t1: "team_admin" }, grants: [] },
  { name: "org admin", userId: "u4", organizationId: ORG, teamIds: [], orgRole: "org_admin", teamRoles: {}, grants: [] },
  { name: "org owner", userId: "u5", organizationId: ORG, teamIds: [], orgRole: "org_owner", teamRoles: {}, grants: [] },
  { name: "plain org member", userId: "u6", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {}, grants: [] },
  { name: "project p1 grantee (no team)", userId: "u7", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {}, grants: ["p1"] },
  { name: "project p1+p2 grantee + team", userId: "u8", organizationId: ORG, teamIds: ["t1"], orgRole: "member", teamRoles: { t1: "member" }, grants: ["p1", "p2"] },
  { name: "foreign-team member", userId: "u9", organizationId: ORG, teamIds: ["t2"], orgRole: "member", teamRoles: { t2: "team_admin" }, grants: [] },
  // Cross-org actor holds ONLY org-2 resources (t9/p9) — never org-1's t1/p1/p2.
  { name: "cross-org member (org-2)", userId: "u10", organizationId: "org-2", teamIds: ["t9"], orgRole: "org_admin", teamRoles: { t9: "team_admin" }, grants: ["p9"] },
];

/** The /dashboards surface verdict for one row + actor (owner/member gate + grant). */
function dashboardSurfaceCanRead(row: Row, a: ActorSpec): boolean {
  const authzActor: DashboardAuthzActor = {
    userId: a.userId,
    organizationId: a.organizationId,
    teamIds: a.teamIds,
    orgRole: a.orgRole,
    teamRoles: a.teamRoles,
    projectGrants: a.grants.map((projectId) => ({ projectId, effectiveRole: "read" as const })),
  };
  // filterReadableDashboards keeps a row iff the actor may READ it.
  return filterReadableDashboards([row as never], authzActor).length === 1;
}

/** The library surface verdict for one row + actor (canonical object.read filter). */
function librarySurfaceCanRead(row: Row, a: ActorSpec): boolean {
  const tuple = deriveDashboardScopeTuple({
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    projectId: row.projectId,
  });
  const evalRow: OwnershipEvalRow = {
    ownerLevel: tuple.ownerLevel,
    ownerId: tuple.ownerId,
    visibility: tuple.visibility,
    projectId: tuple.projectId,
    orgId: row.organizationId,
  };
  const actorCtx = {
    principalType: "HumanUser",
    principalId: a.userId,
    authSource: "ui",
    organizationId: a.organizationId,
    teamIds: a.teamIds,
    // projectIds is DERIVED from grants (the same set the /dashboards grant gate reads).
    projectGrants: a.grants.map((projectId) => ({ projectId, effectiveRole: "read", accessSource: "direct" })),
    projectIds: a.grants,
    platformRole: "member",
  } as unknown as ActorContext;
  return evaluateOwnershipVisibility(vantageFromActor(actorCtx), evalRow);
}

describe("Phase-2 library ⇄ dashboard AGREEMENT (cinatra#1898 acceptance 1)", () => {
  it("the two surfaces return the identical read verdict for EVERY (row, actor) pair", () => {
    const disagreements: string[] = [];
    for (const row of ROWS) {
      for (const actor of ACTORS) {
        const dash = dashboardSurfaceCanRead(row, actor);
        const lib = librarySurfaceCanRead(row, actor);
        if (dash !== lib) {
          disagreements.push(
            `row=${row.id} (${row.ownerLevel}/${row.ownerId}${row.projectId ? `+${row.projectId}` : ""}) ` +
              `actor="${actor.name}": /dashboards=${dash} library=${lib}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Sanity: the corpus actually exercises BOTH verdicts (not all-true / all-false).
    const anyTrue = ROWS.some((row) => ACTORS.some((a) => librarySurfaceCanRead(row, a)));
    const anyFalse = ROWS.some((row) => ACTORS.some((a) => !librarySurfaceCanRead(row, a)));
    expect(anyTrue && anyFalse).toBe(true);
  });

  it("WIDENING: a team/org member now reads a would-be owner-only ('private') scope dashboard", () => {
    // The exact admin-only → scope-visible flip (acceptance 2): under the retired
    // vocabulary these rows were owner-only; now every scope member reads them,
    // and BOTH surfaces agree.
    const teamMember = ACTORS.find((a) => a.name === "team member (non-admin)")!;
    const orgMember = ACTORS.find((a) => a.name === "plain org member")!;
    const teamRow = ROWS.find((x) => x.id === "team-t1")!;
    const orgRow = ROWS.find((x) => x.id === "org-own")!;
    expect(dashboardSurfaceCanRead(teamRow, teamMember)).toBe(true);
    expect(librarySurfaceCanRead(teamRow, teamMember)).toBe(true);
    expect(dashboardSurfaceCanRead(orgRow, orgMember)).toBe(true);
    expect(librarySurfaceCanRead(orgRow, orgMember)).toBe(true);
  });

  it("NO LEAK: a project dashboard stays project-member-only on both surfaces (grant is the gate)", () => {
    const teamMemberNoGrant = ACTORS.find((a) => a.name === "team member (non-admin)")!;
    const grantee = ACTORS.find((a) => a.name === "project p1 grantee (no team)")!;
    const projTeamOwned = ROWS.find((x) => x.id === "proj-teamowned")!;
    // A team member WITHOUT a p1 grant is denied (the re-owning closes the old
    // team-clause leak); a p1 grantee (not even on the team) is admitted.
    expect(dashboardSurfaceCanRead(projTeamOwned, teamMemberNoGrant)).toBe(false);
    expect(librarySurfaceCanRead(projTeamOwned, teamMemberNoGrant)).toBe(false);
    expect(dashboardSurfaceCanRead(projTeamOwned, grantee)).toBe(true);
    expect(librarySurfaceCanRead(projTeamOwned, grantee)).toBe(true);
  });
});
