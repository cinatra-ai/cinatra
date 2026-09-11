/**
 * Per-scope eligibility fixtures (cinatra#2808, per-scope surfaces S2).
 *
 * The acceptance item this file proves, verbatim:
 *
 *   "Per-scope list fixtures (five scopes; multi-org workspace union;
 *    admin-only visibility both ways; hidden bindings absent; exact-project
 *    installs present; viewed-org ≠ active-org correct)."
 *
 * and, for the builder half:
 *
 *   "Eligibility loader (net-new): two arms off one policy snapshot … This
 *    slice owns the exported `WorkspaceVantage` builder the epic names."
 *
 * Every case drives the PURE loader: the policy snapshot is handed in as a
 * value, so a fixture can pin that both arms saw the SAME one.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
} from "@cinatra-ai/agents/auth-policy-types";

import {
  buildWorkspaceVantage,
  listScopeEligiblePackages,
  type ScopePackageInstall,
  type ScopeProjectBinding,
  type WorkspaceVantage,
} from "../scope-surface-eligibility";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TEAM_A = "team-a";
const PROJECT_A = "project-a";
const ACTOR = "user-1";

function policy(...tokens: AgentAuthPolicyVisibility[]): AgentAuthPolicy {
  const selection = tokens as [AgentAuthPolicyVisibility, ...AgentAuthPolicyVisibility[]];
  return {
    runListVisibility: selection,
    runDataVisibility: selection,
    runExecuteVisibility: selection,
    allowRunSharing: false,
  };
}

function install(
  over: Partial<ScopePackageInstall> & Pick<ScopePackageInstall, "packageName">,
): ScopePackageInstall {
  const scoped = {
    ownerLevel: "organization" as const,
    ownerId: ORG_A as string | null,
    organizationId: ORG_A as string | null,
    ...over,
  };
  return {
    installId: `i-${scoped.packageName}-${scoped.ownerId ?? scoped.organizationId ?? "x"}`,
    displayName: scoped.packageName,
    description: null,
    version: "1.0.0",
    status: "active",
    isAssistant: false,
    ...scoped,
  };
}

/** Both arms off ONE snapshot: the map IS the snapshot. */
function snapshot(entries: Array<[string, AgentAuthPolicy]>) {
  const map = new Map(entries);
  return (row: ScopePackageInstall) => map.get(row.installId) ?? policy("org");
}

const ALLOW_ALL = () => true;

const vantageAB: WorkspaceVantage = {
  userId: ACTOR,
  organizations: [
    { orgId: ORG_A, teamIds: [TEAM_A], projectIds: [PROJECT_A] },
    { orgId: ORG_B, teamIds: [], projectIds: [] },
  ],
};

describe("listScopeEligiblePackages — the five scope rules", () => {
  it("personal lists the actor's invocable set and nothing the actor arm refuses", () => {
    const mine = install({ packageName: "@v/mine", ownerLevel: "user", ownerId: ACTOR });
    const theirs = install({ packageName: "@v/theirs", ownerLevel: "user", ownerId: "user-2" });
    const rows = listScopeEligiblePackages({
      scope: { kind: "personal", orgId: ORG_A },
      actorUserId: ACTOR,
      installs: [mine, theirs],
      policyFor: snapshot([]),
      actorMayUse: (row) => row.ownerId === ACTOR,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/mine"]);
  });

  it("organization lists exact-org installs and never another organization's", () => {
    const here = install({ packageName: "@v/here", organizationId: ORG_A, ownerId: ORG_A });
    const elsewhere = install({
      packageName: "@v/elsewhere",
      organizationId: ORG_B,
      ownerId: ORG_B,
    });
    const rows = listScopeEligiblePackages({
      scope: { kind: "organization", orgId: ORG_A },
      actorUserId: ACTOR,
      installs: [here, elsewhere],
      policyFor: snapshot([]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/here"]);
  });

  it("team lists exact-team plus exact-org, never another team's install", () => {
    const mineTeam = install({
      packageName: "@v/team-own",
      ownerLevel: "team",
      ownerId: TEAM_A,
      organizationId: ORG_A,
    });
    const otherTeam = install({
      packageName: "@v/team-other",
      ownerLevel: "team",
      ownerId: "team-z",
      organizationId: ORG_A,
    });
    const orgWide = install({ packageName: "@v/org-wide" });
    const rows = listScopeEligiblePackages({
      scope: { kind: "team", orgId: ORG_A, teamId: TEAM_A },
      actorUserId: ACTOR,
      installs: [mineTeam, otherTeam, orgWide],
      policyFor: snapshot([
        [`i-@v/team-own-${TEAM_A}`, policy(`team:${TEAM_A}`)],
        ["i-@v/team-other-team-z", policy("team:team-z")],
      ]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/org-wide", "@v/team-own"]);
  });

  it("project lists exact-project installs and non-hidden bindings; a hidden binding never surfaces", () => {
    const exact = install({
      packageName: "@v/project-own",
      organizationId: ORG_A,
      ownerId: ORG_A,
    });
    const boundVisible = install({
      packageName: "@v/bound",
      organizationId: ORG_A,
      ownerId: ORG_A,
    });
    const boundHidden = install({
      packageName: "@v/hidden",
      organizationId: ORG_A,
      ownerId: ORG_A,
    });
    const bindings: ScopeProjectBinding[] = [
      { packageName: "@v/project-own", projectId: PROJECT_A, visibility: "project-private" },
      { packageName: "@v/bound", projectId: PROJECT_A, visibility: "visible" },
      { packageName: "@v/hidden", projectId: PROJECT_A, visibility: "hidden" },
    ];
    const rows = listScopeEligiblePackages({
      scope: { kind: "project", orgId: ORG_A, projectId: PROJECT_A },
      actorUserId: ACTOR,
      installs: [exact, boundVisible, boundHidden],
      bindings,
      // `project:<P>` so only the project's own vantage admits them — an org
      // token would let the exact-org arm carry all three in and hide the
      // binding rule behind it.
      policyFor: snapshot([
        [`i-@v/project-own-${ORG_A}`, policy(`project:${PROJECT_A}`)],
        [`i-@v/bound-${ORG_A}`, policy(`project:${PROJECT_A}`)],
        [`i-@v/hidden-${ORG_A}`, policy(`project:${PROJECT_A}`)],
      ]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/bound", "@v/project-own"]);
    expect(rows.map((r) => r.packageName)).not.toContain("@v/hidden");
  });

  it("workspace unions every member organization and keeps its execution organizations", () => {
    const inA = install({ packageName: "@v/only-a", organizationId: ORG_A, ownerId: ORG_A });
    const inB = install({ packageName: "@v/only-b", organizationId: ORG_B, ownerId: ORG_B });
    const bothA = install({
      packageName: "@v/both",
      installId: "i-both-a",
      organizationId: ORG_A,
      ownerId: ORG_A,
    });
    const bothB = install({
      packageName: "@v/both",
      installId: "i-both-b",
      organizationId: ORG_B,
      ownerId: ORG_B,
    });
    const rows = listScopeEligiblePackages({
      scope: { kind: "workspace" },
      actorUserId: ACTOR,
      installs: [inA, inB, bothA, bothB],
      vantage: vantageAB,
      policyFor: snapshot([]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/both", "@v/only-a", "@v/only-b"]);
    // Package-level display dedupe, and the launch-organization candidates the
    // epic's contract keeps: "#2808 owns candidate production".
    const both = rows.find((r) => r.packageName === "@v/both")!;
    expect([...both.executionOrganizationIds].sort()).toEqual([ORG_A, ORG_B]);
    expect(rows.find((r) => r.packageName === "@v/only-a")!.executionOrganizationIds).toEqual([
      ORG_A,
    ]);
  });

  it("workspace admits an organization-NULL row once, with no concrete execution organization", () => {
    const tenantWide = install({
      packageName: "@v/platform",
      ownerLevel: "workspace",
      ownerId: null,
      organizationId: null,
    });
    const rows = listScopeEligiblePackages({
      scope: { kind: "workspace" },
      actorUserId: ACTOR,
      installs: [tenantWide],
      vantage: vantageAB,
      policyFor: snapshot([["i-@v/platform-x", policy("workspace")]]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows).toHaveLength(1);
    // "an org-NULL-only package requires selection from WorkspaceVantage"
    expect(rows[0]!.executionOrganizationIds).toEqual([]);
  });
});

describe("listScopeEligiblePackages — the two arms and the viewed scope", () => {
  it("an admin-only package is refused both ways: for a member AND for an admin actor", () => {
    const adminOnly = install({ packageName: "@v/admin-only" });
    const forMember = listScopeEligiblePackages({
      scope: { kind: "organization", orgId: ORG_A },
      actorUserId: ACTOR,
      installs: [adminOnly],
      policyFor: snapshot([[`i-@v/admin-only-${ORG_A}`, policy("admin")]]),
      actorMayUse: () => false,
    });
    const forAdmin = listScopeEligiblePackages({
      scope: { kind: "organization", orgId: ORG_A },
      actorUserId: ACTOR,
      installs: [adminOnly],
      policyFor: snapshot([[`i-@v/admin-only-${ORG_A}`, policy("admin")]]),
      // The ACTOR arm admits the admin; the VANTAGE arm still refuses, because
      // a scope holds no admin standing.
      actorMayUse: ALLOW_ALL,
    });
    expect(forMember).toEqual([]);
    expect(forAdmin).toEqual([]);
  });

  it("reads the VIEWED organization, never the active one", () => {
    const inB = install({ packageName: "@v/only-b", organizationId: ORG_B, ownerId: ORG_B });
    // The actor's active organization is ORG_A; the page they are looking at is
    // ORG_B's. The loader is parameterized by the viewed org and takes no
    // active-org input at all, so the row shows.
    const rows = listScopeEligiblePackages({
      scope: { kind: "organization", orgId: ORG_B },
      actorUserId: ACTOR,
      installs: [inB],
      policyFor: snapshot([[`i-@v/only-b-${ORG_B}`, policy(`org:${ORG_B}`)]]),
      actorMayUse: ALLOW_ALL,
    });
    expect(rows.map((r) => r.packageName)).toEqual(["@v/only-b"]);
  });

  it("both arms read the same snapshot value", () => {
    const row = install({ packageName: "@v/one" });
    const seen: AgentAuthPolicy[] = [];
    let reads = 0;
    listScopeEligiblePackages({
      scope: { kind: "organization", orgId: ORG_A },
      actorUserId: ACTOR,
      installs: [row],
      policyFor: () => {
        reads += 1;
        return policy("org");
      },
      actorMayUse: (_row, p) => {
        seen.push(p);
        return true;
      },
    });
    expect(reads).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("an archived install never surfaces on any scope tab", () => {
    const archived = install({ packageName: "@v/archived", status: "archived" });
    expect(
      listScopeEligiblePackages({
        scope: { kind: "organization", orgId: ORG_A },
        actorUserId: ACTOR,
        installs: [archived],
        policyFor: snapshot([]),
        actorMayUse: ALLOW_ALL,
      }),
    ).toEqual([]);
  });
});

describe("buildWorkspaceVantage — the epic's conformance anchor", () => {
  const deps = {
    readMemberOrganizations: async () => [
      { orgId: ORG_A, archived: false },
      { orgId: ORG_B, archived: false },
      { orgId: "org-archived", archived: true },
    ],
    readVisibleTeams: async (_userId: string, orgId: string) =>
      orgId === ORG_A ? [TEAM_A] : [],
    readVisibleProjects: async (_userId: string, orgId: string) =>
      orgId === ORG_A ? [PROJECT_A] : [],
  };

  it("is the actor's member organizations, with the actor-visible teams and projects in each", async () => {
    const vantage = await buildWorkspaceVantage(deps, { userId: ACTOR });
    expect(vantage.userId).toBe(ACTOR);
    expect(vantage.organizations.map((o) => o.orgId)).toEqual([ORG_A, ORG_B]);
    expect(vantage.organizations[0]!.teamIds).toEqual([TEAM_A]);
    expect(vantage.organizations[0]!.projectIds).toEqual([PROJECT_A]);
    expect(vantage.organizations[1]!.teamIds).toEqual([]);
  });

  it("drops an archived organization", async () => {
    const vantage = await buildWorkspaceVantage(deps, { userId: ACTOR });
    expect(vantage.organizations.map((o) => o.orgId)).not.toContain("org-archived");
  });

  it("drops an organization whose membership was revoked, on the next read", async () => {
    let orgs = [{ orgId: ORG_A, archived: false }, { orgId: ORG_B, archived: false }];
    const revocable = { ...deps, readMemberOrganizations: async () => orgs };
    expect(
      (await buildWorkspaceVantage(revocable, { userId: ACTOR })).organizations.map((o) => o.orgId),
    ).toEqual([ORG_A, ORG_B]);
    orgs = [{ orgId: ORG_A, archived: false }];
    expect(
      (await buildWorkspaceVantage(revocable, { userId: ACTOR })).organizations.map((o) => o.orgId),
    ).toEqual([ORG_A]);
  });

  it("never adds, removes or selects a member organization from the active one", async () => {
    const onA = await buildWorkspaceVantage(deps, {
      userId: ACTOR,
      activeOrganizationId: ORG_A,
    });
    const onB = await buildWorkspaceVantage(deps, {
      userId: ACTOR,
      activeOrganizationId: ORG_B,
    });
    const none = await buildWorkspaceVantage(deps, { userId: ACTOR, activeOrganizationId: null });
    expect(onA).toEqual(onB);
    expect(onA).toEqual(none);
  });
});
