/**
 * `actorMayWriteScope` — the §IX.2 scope-write gate (cinatra#1897 B4). The gate-2
 * predicate the collection-add contract injects. Grounded in the shipped
 * scope-authority vocabulary; fail-closed + tenant-fenced.
 */
import { describe, expect, it } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import { actorMayWriteScope } from "@/lib/dashboards/scope-write-authority";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const TEAM = "team-1";
const PROJECT = "proj-1";

function actor(partial: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u1",
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    ...partial,
  } as ActorContext;
}

const teamScope: ListingScope = { kind: "team", scopeId: TEAM, orgId: ORG };
const orgScope: ListingScope = { kind: "organization", scopeId: ORG, orgId: ORG };
const projectScope: ListingScope = { kind: "project", scopeId: PROJECT, orgId: ORG };

describe("team scope", () => {
  it("a team admin of the team may write", () => {
    expect(
      actorMayWriteScope(actor({ teamRoles: { [TEAM]: "team_admin" } }), teamScope),
    ).toBe(true);
  });
  it("an org owner/admin of the team's org may write (shipped team-management authority)", () => {
    expect(actorMayWriteScope(actor({ orgRole: "org_admin" }), teamScope)).toBe(true);
    expect(actorMayWriteScope(actor({ orgRole: "org_owner" }), teamScope)).toBe(true);
  });
  it("a plain team member may NOT write (read-only tab)", () => {
    expect(
      actorMayWriteScope(actor({ teamRoles: { [TEAM]: "member" }, orgRole: "member" }), teamScope),
    ).toBe(false);
  });
  it("a team admin of a DIFFERENT team may not write", () => {
    expect(
      actorMayWriteScope(actor({ teamRoles: { "team-9": "team_admin" } }), teamScope),
    ).toBe(false);
  });
  it("an org admin of a DIFFERENT org may not write (tenant fence)", () => {
    expect(
      actorMayWriteScope(actor({ organizationId: OTHER_ORG, orgRole: "org_admin" }), teamScope),
    ).toBe(false);
  });
  it("a team_admin grant for a team in a DIFFERENT tenant may not write (team-arm tenant fence — codex authz-lens)", () => {
    // The team-admin arm is tenant-fenced: a team_admin key held while the actor's
    // active org is NOT the scope's org is never a cross-tenant writer. (Defense in
    // depth: removeScopeListing gates on this predicate alone.)
    expect(
      actorMayWriteScope(
        actor({ organizationId: OTHER_ORG, teamRoles: { [TEAM]: "team_admin" } }),
        teamScope,
      ),
    ).toBe(false);
  });
});

describe("organization scope", () => {
  it("an org owner/admin of this org may write", () => {
    expect(actorMayWriteScope(actor({ orgRole: "org_admin" }), orgScope)).toBe(true);
    expect(actorMayWriteScope(actor({ orgRole: "org_owner" }), orgScope)).toBe(true);
  });
  it("a plain member may NOT write", () => {
    expect(actorMayWriteScope(actor({ orgRole: "member" }), orgScope)).toBe(false);
  });
  it("an org admin of a DIFFERENT org may not write (tenant fence)", () => {
    expect(
      actorMayWriteScope(actor({ organizationId: OTHER_ORG, orgRole: "org_admin" }), orgScope),
    ).toBe(false);
  });
});

describe("project scope", () => {
  it("a project admin/owner grant may write", () => {
    expect(
      actorMayWriteScope(
        actor({ projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }] }),
        projectScope,
      ),
    ).toBe(true);
    expect(
      actorMayWriteScope(
        actor({ projectGrants: [{ projectId: PROJECT, effectiveRole: "owner", accessSource: "owner" }] }),
        projectScope,
      ),
    ).toBe(true);
  });
  it("a read/write grant may NOT write the collection (admin/owner only)", () => {
    expect(
      actorMayWriteScope(
        actor({ projectGrants: [{ projectId: PROJECT, effectiveRole: "write", accessSource: "user" }] }),
        projectScope,
      ),
    ).toBe(false);
    expect(
      actorMayWriteScope(
        actor({ projectGrants: [{ projectId: PROJECT, effectiveRole: "read", accessSource: "user" }] }),
        projectScope,
      ),
    ).toBe(false);
  });
  it("an admin grant on a DIFFERENT project does not write this one", () => {
    expect(
      actorMayWriteScope(
        actor({ projectGrants: [{ projectId: "proj-9", effectiveRole: "admin", accessSource: "user" }] }),
        projectScope,
      ),
    ).toBe(false);
  });
  it("no grants → fail-closed", () => {
    expect(actorMayWriteScope(actor({ projectGrants: [] }), projectScope)).toBe(false);
    expect(actorMayWriteScope(actor(), projectScope)).toBe(false);
  });
});

describe("platform admin", () => {
  it("writes every scope kind, cross-tenant (scope-ratchet convention)", () => {
    const pa = actor({ organizationId: OTHER_ORG, platformRole: "platform_admin" });
    expect(actorMayWriteScope(pa, teamScope)).toBe(true);
    expect(actorMayWriteScope(pa, orgScope)).toBe(true);
    expect(actorMayWriteScope(pa, projectScope)).toBe(true);
  });
});

describe("fail-closed", () => {
  it("an actor with no roles at all writes nothing", () => {
    const bare = actor({ orgRole: "member" });
    expect(actorMayWriteScope(bare, teamScope)).toBe(false);
    expect(actorMayWriteScope(bare, orgScope)).toBe(false);
    expect(actorMayWriteScope(bare, projectScope)).toBe(false);
  });
});
