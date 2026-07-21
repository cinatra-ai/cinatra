import { describe, it, expect } from "vitest";

import {
  scopeMaySeeRow,
  actorMaySeeRow,
  evaluateOwnershipVisibility,
  vantageFromScope,
  vantageFromActor,
  buildOwnershipFilter,
  OWNERSHIP_CLAUSE_IDS,
  COLLECTION_SCOPE_KINDS,
  type CollectionScope,
  type OwnershipEvalRow,
} from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Scope-vantage guard — scopeMaySeeRow (cinatra#1886 C2 / epic #1883 D11).
//
// The pure row projection of the canonical ownership predicate. Covers:
//   - the per-scope-kind visibility matrix (user/team/org/workspace/project);
//   - fail-closed defaults (malformed scope, non-canonical row, null-org);
//   - the structural lockstep anchor (both projections enumerate one clause
//     set). The SEMANTIC lockstep (same fixtures through the compiled SQL and
//     the row predicate) lives in the DB-integration conformance test.
// ---------------------------------------------------------------------------

const ORG = "org-1";
const ORG2 = "org-2";

function row(partial: Partial<OwnershipEvalRow>): OwnershipEvalRow {
  return {
    ownerLevel: null,
    ownerId: null,
    visibility: null,
    projectId: null,
    orgId: ORG,
    ...partial,
  };
}

const userRow = (u: string, org = ORG): OwnershipEvalRow =>
  row({ ownerLevel: "user", ownerId: u, visibility: "private", orgId: org });
const teamRow = (t: string, org = ORG): OwnershipEvalRow =>
  row({ ownerLevel: "team", ownerId: t, visibility: "team", orgId: org });
const orgRow = (org = ORG): OwnershipEvalRow =>
  row({ ownerLevel: "organization", ownerId: org, visibility: "organization", orgId: org });
const publicRow = (org = ORG): OwnershipEvalRow =>
  row({ ownerLevel: "workspace", ownerId: org, visibility: "public", orgId: org });
const projectRow = (p: string, org = ORG): OwnershipEvalRow =>
  row({ ownerLevel: "organization", ownerId: org, visibility: "private", projectId: p, orgId: org });

describe("scopeMaySeeRow — per-scope-kind matrix", () => {
  it("covers the fixed scope-kind roster", () => {
    expect([...COLLECTION_SCOPE_KINDS]).toEqual([
      "user",
      "team",
      "organization",
      "workspace",
      "project",
    ]);
  });

  it("user scope sees own user rows + org/public, NOT team/project/foreign", () => {
    const scope: CollectionScope = { kind: "user", userId: "user-1", orgId: ORG };
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(true);
    expect(scopeMaySeeRow(scope, userRow("user-2"))).toBe(false);
    expect(scopeMaySeeRow(scope, orgRow())).toBe(true);
    expect(scopeMaySeeRow(scope, publicRow())).toBe(true);
    expect(scopeMaySeeRow(scope, teamRow("team-a"))).toBe(false);
    expect(scopeMaySeeRow(scope, projectRow("proj-x"))).toBe(false);
    expect(scopeMaySeeRow(scope, publicRow(ORG2))).toBe(false);
  });

  it("team scope sees its team rows + org/public, NOT other teams/user/project", () => {
    const scope: CollectionScope = { kind: "team", teamId: "team-a", orgId: ORG };
    expect(scopeMaySeeRow(scope, teamRow("team-a"))).toBe(true);
    expect(scopeMaySeeRow(scope, teamRow("team-b"))).toBe(false);
    expect(scopeMaySeeRow(scope, orgRow())).toBe(true);
    expect(scopeMaySeeRow(scope, publicRow())).toBe(true);
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(false);
    expect(scopeMaySeeRow(scope, projectRow("proj-x"))).toBe(false);
  });

  it("organization scope sees org/public in its org only, NOT team/user/project", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    expect(scopeMaySeeRow(scope, orgRow())).toBe(true);
    expect(scopeMaySeeRow(scope, publicRow())).toBe(true);
    expect(scopeMaySeeRow(scope, teamRow("team-a"))).toBe(false);
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(false);
    expect(scopeMaySeeRow(scope, projectRow("proj-x"))).toBe(false);
    expect(scopeMaySeeRow(scope, orgRow(ORG2))).toBe(false);
    expect(scopeMaySeeRow(scope, publicRow(ORG2))).toBe(false);
  });

  it("workspace scope behaves as an org-wide reader (org/public in its org)", () => {
    const scope: CollectionScope = { kind: "workspace", orgId: ORG };
    expect(scopeMaySeeRow(scope, publicRow())).toBe(true);
    expect(scopeMaySeeRow(scope, orgRow())).toBe(true);
    expect(scopeMaySeeRow(scope, teamRow("team-a"))).toBe(false);
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(false);
    expect(scopeMaySeeRow(scope, projectRow("proj-x"))).toBe(false);
    expect(scopeMaySeeRow(scope, publicRow(ORG2))).toBe(false);
  });

  it("project scope sees its project rows + org/public, NOT other projects/team/user", () => {
    const scope: CollectionScope = { kind: "project", projectId: "proj-x", orgId: ORG };
    expect(scopeMaySeeRow(scope, projectRow("proj-x"))).toBe(true);
    expect(scopeMaySeeRow(scope, projectRow("proj-y"))).toBe(false);
    expect(scopeMaySeeRow(scope, orgRow())).toBe(true);
    expect(scopeMaySeeRow(scope, publicRow())).toBe(true);
    expect(scopeMaySeeRow(scope, teamRow("team-a"))).toBe(false);
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(false);
  });
});

describe("scopeMaySeeRow — fail-closed defaults", () => {
  it("a malformed scope (missing required id) sees nothing", () => {
    expect(vantageFromScope({ kind: "team", teamId: "", orgId: ORG })).toBeNull();
    expect(scopeMaySeeRow({ kind: "team", teamId: "", orgId: ORG }, orgRow())).toBe(false);
    expect(scopeMaySeeRow({ kind: "organization", orgId: "" }, orgRow())).toBe(false);
    expect(scopeMaySeeRow({ kind: "project", projectId: "p", orgId: "" }, orgRow())).toBe(false);
    expect(scopeMaySeeRow({ kind: "user", userId: "" }, userRow(""))).toBe(false);
  });

  it("an unknown scope kind sees nothing", () => {
    const bogus = { kind: "galaxy", orgId: ORG } as unknown as CollectionScope;
    expect(vantageFromScope(bogus)).toBeNull();
    expect(scopeMaySeeRow(bogus, orgRow())).toBe(false);
  });

  it("a non-canonical row visibility matches no clause (fail-closed)", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    expect(scopeMaySeeRow(scope, row({ visibility: "org", orgId: ORG }))).toBe(false);
    expect(scopeMaySeeRow(scope, row({ visibility: "team:team-a", orgId: ORG }))).toBe(false);
    expect(scopeMaySeeRow(scope, row({ visibility: null, orgId: ORG }))).toBe(false);
  });

  it("a user scope with no org sees only its own user rows, never org/public", () => {
    const scope: CollectionScope = { kind: "user", userId: "user-1" };
    expect(scopeMaySeeRow(scope, userRow("user-1"))).toBe(true);
    expect(scopeMaySeeRow(scope, orgRow())).toBe(false);
    expect(scopeMaySeeRow(scope, publicRow())).toBe(false);
  });

  it("never admits a row whose org differs, even when the axis id matches", () => {
    // org-visible row in ORG2 must not leak to an ORG-scoped organization scope.
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    expect(
      scopeMaySeeRow(scope, row({ visibility: "organization", ownerLevel: "organization", ownerId: ORG2, orgId: ORG2 })),
    ).toBe(false);
  });
});

describe("evaluateOwnershipVisibility — the shared row projection", () => {
  it("scope never carries platform-admin standing (no public cross-org leak)", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const v = vantageFromScope(scope);
    expect(v?.isPlatformAdmin).toBe(false);
    // Even for an org scope, a foreign-org public row is refused.
    expect(scopeMaySeeRow(scope, publicRow(ORG2))).toBe(false);
  });

  it("actorMaySeeRow honors the actor's OBO ceiling (narrowing)", () => {
    const base: ActorContext = {
      principalType: "HumanUser",
      principalId: "user-1",
      organizationId: ORG,
      teamIds: ["team-a"],
      projectIds: ["proj-x"],
      platformRole: "member",
      authSource: "ui",
      policyVersion: "v2",
    };
    // Without a ceiling, the actor sees both the team row and the project row.
    expect(actorMaySeeRow(base, teamRow("team-a"))).toBe(true);
    expect(actorMaySeeRow(base, projectRow("proj-x"))).toBe(true);
    // A project-tier ceiling narrows via satisfy-all: only rows refined to
    // proj-x survive; the team row (no project refinement) is now denied.
    const ceiled: ActorContext = {
      ...base,
      oboCeiling: [{ tier: "project", id: "proj-x" }],
    };
    expect(actorMaySeeRow(ceiled, teamRow("team-a"))).toBe(false);
    expect(actorMaySeeRow(ceiled, projectRow("proj-x"))).toBe(true);
    expect(actorMaySeeRow(ceiled, orgRow())).toBe(false);
  });
});

describe("lockstep — one clause set drives both projections", () => {
  it("exposes the fixed canonical clause roster", () => {
    expect([...OWNERSHIP_CLAUSE_IDS]).toEqual([
      "user",
      "team",
      "organization",
      "public",
      "project",
    ]);
  });

  it("buildOwnershipFilter emits exactly one SQL term per canonical clause", () => {
    const actor: ActorContext = {
      principalType: "HumanUser",
      principalId: "user-1",
      organizationId: ORG,
      teamIds: ["team-a"],
      projectIds: ["proj-x"],
      platformRole: "member",
      authSource: "ui",
      policyVersion: "v2",
    };
    const { sql } = buildOwnershipFilter(actor);
    // One recognizable fragment per clause id — the SQL projection and the row
    // projection iterate the SAME OWNERSHIP_VISIBILITY_CLAUSES array.
    expect(sql).toContain("owner_level = 'user'"); // user
    expect(sql).toContain("owner_level = 'team'"); // team
    expect(sql).toContain("visibility = 'organization'"); // organization
    expect(sql).toContain("visibility = 'public'"); // public
    expect(sql).toContain("project_id IS NOT NULL"); // project
    // The evaluator's vantage is the same projection the SQL builder uses.
    expect(vantageFromActor(actor)).toEqual({
      principalId: "user-1",
      teamIds: ["team-a"],
      organizationId: ORG,
      projectIds: ["proj-x"],
      isPlatformAdmin: false,
    });
  });

  it("the row evaluator agrees with the actor vantage across the corpus", () => {
    const actor: ActorContext = {
      principalType: "HumanUser",
      principalId: "user-1",
      organizationId: ORG,
      teamIds: ["team-a"],
      projectIds: ["proj-x"],
      platformRole: "member",
      authSource: "ui",
      policyVersion: "v2",
    };
    const v = vantageFromActor(actor);
    const corpus: Array<[OwnershipEvalRow, boolean]> = [
      [userRow("user-1"), true],
      [userRow("user-2"), false],
      [teamRow("team-a"), true],
      [teamRow("team-b"), false],
      [orgRow(), true],
      [publicRow(), true],
      [publicRow(ORG2), false],
      [projectRow("proj-x"), true],
      [projectRow("proj-y"), false],
    ];
    for (const [r, expected] of corpus) {
      expect(evaluateOwnershipVisibility(v, r)).toBe(expected);
    }
  });
});
