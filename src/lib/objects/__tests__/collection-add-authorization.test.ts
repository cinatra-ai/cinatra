import { describe, it, expect } from "vitest";

import {
  authorizeCollectionAdd,
  promotionOfferForScope,
  type CollectionAddRow,
  type CollectionScope,
} from "@/lib/objects/collection-add-authorization";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Collection-add authorization CONTRACT (cinatra#1886 C2 / epic #1883 D11).
//
// actor-may-see AND actor-may-write-scope AND scopeMaySeeRow, with the #1437
// promotion request as the recourse on a scope-visibility failure. Covers the
// triple-condition matrix, the ordered short-circuits, promotion-offer shape
// per scope kind, and fail-closed defaults.
// ---------------------------------------------------------------------------

const ORG = "org-1";

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: ORG,
    teamIds: ["team-a"],
    projectIds: ["proj-x"],
    platformRole: "member",
    authSource: "ui",
    policyVersion: "v2",
    ...overrides,
  };
}

function rowOf(partial: Partial<CollectionAddRow>): CollectionAddRow {
  return {
    id: "art-1",
    ownerLevel: null,
    ownerId: null,
    visibility: null,
    projectId: null,
    orgId: ORG,
    ...partial,
  };
}

// An org-visible row in ORG — the actor (member of ORG) can see it; a generic
// member of an ORG-scoped collection can also see it.
const orgVisibleRow = rowOf({
  ownerLevel: "organization",
  ownerId: ORG,
  visibility: "organization",
  orgId: ORG,
});

// A row PRIVATE to user-1 — the actor sees it (owner), but a team/org scope
// cannot (scopeMaySeeRow false → promotion recourse).
const actorPrivateRow = rowOf({
  ownerLevel: "user",
  ownerId: "user-1",
  visibility: "private",
  orgId: ORG,
});

describe("authorizeCollectionAdd — the triple condition", () => {
  it("allows when all three conjuncts hold", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: orgVisibleRow,
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("denies actor_cannot_see_row FIRST (no scope info leak), no promotion", () => {
    // A row private to ANOTHER user — the acting actor cannot see it.
    const foreignPrivate = rowOf({
      ownerLevel: "user",
      ownerId: "user-2",
      visibility: "private",
      orgId: ORG,
    });
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: foreignPrivate,
      // even with write access + a scope that could see it, actor-see wins first
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "actor_cannot_see_row",
      promotion: null,
    });
  });

  it("denies actor_cannot_write_scope BEFORE revealing the scope-see failure", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      // a row the actor sees but the scope cannot — yet write-scope fails first
      row: actorPrivateRow,
      actorMayWriteScope: false,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "actor_cannot_write_scope",
      promotion: null,
    });
  });

  it("denies scope_cannot_see_row LAST and offers the #1437 promotion recourse", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: actorPrivateRow,
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: { artifactId: "art-1", toVisibility: "organization" },
    });
  });
});

describe("authorizeCollectionAdd — per-scope promotion offer", () => {
  it("team scope offers a team-target promotion", () => {
    const scope: CollectionScope = { kind: "team", teamId: "team-a", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: actorPrivateRow, // actor (owner) sees; team scope cannot
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: { artifactId: "art-1", toVisibility: "team", targetTeamId: "team-a" },
    });
  });

  it("withholds a team offer when the actor is NOT a member of the team (dead #1437 recourse)", () => {
    // An org admin may write a team's collection (actorMayWriteScope) but is not
    // a member of the team, so a #1437 team-target request would bounce. The
    // contract withholds the offer rather than surface a dead recourse.
    const scope: CollectionScope = { kind: "team", teamId: "team-z", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor({ teamIds: ["team-a"], orgRole: "org_admin" }), // not in team-z
      scope,
      row: actorPrivateRow, // private, same org — tenant+widen valid, but membership fails
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: null,
    });
    // The actor-less core still computes the tenant+widen-valid target.
    expect(promotionOfferForScope(scope, actorPrivateRow)).toEqual({
      artifactId: "art-1",
      toVisibility: "team",
      targetTeamId: "team-z",
    });
  });

  it("offers the team target when the actor IS a member", () => {
    const scope: CollectionScope = { kind: "team", teamId: "team-a", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor({ teamIds: ["team-a"] }),
      scope,
      row: actorPrivateRow,
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: { artifactId: "art-1", toVisibility: "team", targetTeamId: "team-a" },
    });
  });

  it("workspace scope offers an organization-target promotion", () => {
    const scope: CollectionScope = { kind: "workspace", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: actorPrivateRow,
      actorMayWriteScope: true,
    });
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: { artifactId: "art-1", toVisibility: "organization" },
    });
  });

  it("user and project scopes have NO #1437-shaped recourse (null offer, still denied)", () => {
    const userScope: CollectionScope = { kind: "user", userId: "user-9", orgId: ORG };
    const decU = authorizeCollectionAdd({
      actor: actor(),
      scope: userScope,
      row: actorPrivateRow, // user-1's private row; user-9's collection cannot see it
      actorMayWriteScope: true,
    });
    expect(decU).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: null,
    });

    const projScope: CollectionScope = { kind: "project", projectId: "proj-z", orgId: ORG };
    const decP = authorizeCollectionAdd({
      actor: actor(),
      scope: projScope,
      row: actorPrivateRow,
      actorMayWriteScope: true,
    });
    expect(decP).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: null,
    });
  });

  it("promotionOfferForScope offers a GENUINE #1437 widen per scope kind", () => {
    // A private, same-org row genuinely widens to team/organization.
    const priv = rowOf({ id: "art-42", visibility: "private", ownerLevel: "user", ownerId: "user-1", orgId: ORG });
    expect(promotionOfferForScope({ kind: "organization", orgId: ORG }, priv)).toEqual({
      artifactId: "art-42",
      toVisibility: "organization",
    });
    expect(promotionOfferForScope({ kind: "workspace", orgId: ORG }, priv)).toEqual({
      artifactId: "art-42",
      toVisibility: "organization",
    });
    expect(promotionOfferForScope({ kind: "team", teamId: "team-b", orgId: ORG }, priv)).toEqual({
      artifactId: "art-42",
      toVisibility: "team",
      targetTeamId: "team-b",
    });
    expect(promotionOfferForScope({ kind: "user", userId: "u", orgId: ORG }, priv)).toBeNull();
    expect(promotionOfferForScope({ kind: "project", projectId: "p", orgId: ORG }, priv)).toBeNull();
  });

  it("promotionOfferForScope refuses invalid recourses (codex convergence)", () => {
    // team→team no-op: a row already owned by ANOTHER team does not widen to
    // the scope's team ("team" → "team" is not a widen).
    const teamBRow = rowOf({ id: "a", visibility: "team", ownerLevel: "team", ownerId: "team-b", orgId: ORG });
    expect(promotionOfferForScope({ kind: "team", teamId: "team-a", orgId: ORG }, teamBRow)).toBeNull();

    // cross-org: a foreign-org public row cannot be promoted into THIS scope's
    // org (tenant mismatch; public→organization would also be a narrowing).
    const foreignPublic = rowOf({ id: "b", visibility: "public", ownerLevel: "workspace", ownerId: "org-2", orgId: "org-2" });
    expect(promotionOfferForScope({ kind: "organization", orgId: ORG }, foreignPublic)).toBeNull();

    // a same-org public row does not widen to organization (narrowing).
    const orgPublic = rowOf({ id: "c", visibility: "public", ownerLevel: "workspace", ownerId: ORG, orgId: ORG });
    expect(promotionOfferForScope({ kind: "organization", orgId: ORG }, orgPublic)).toBeNull();

    // malformed team scope (empty teamId) yields no offer.
    const priv = rowOf({ id: "d", visibility: "private", ownerLevel: "user", ownerId: "u", orgId: ORG });
    expect(promotionOfferForScope({ kind: "team", teamId: "", orgId: ORG }, priv)).toBeNull();
  });
});

describe("authorizeCollectionAdd — fail-closed defaults", () => {
  it("a malformed scope denies (scope sees nothing), offer per kind", () => {
    const scope: CollectionScope = { kind: "team", teamId: "", orgId: ORG };
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: orgVisibleRow, // even an org-visible row: the malformed scope sees nothing
      actorMayWriteScope: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("scope_cannot_see_row");
    }
  });

  it("a non-canonical row visibility denies the add", () => {
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const legacyRow = rowOf({ visibility: "org", orgId: ORG });
    const decision = authorizeCollectionAdd({
      actor: actor(),
      scope,
      row: legacyRow,
      actorMayWriteScope: true,
    });
    // The actor's own read filter also refuses a non-canonical row → the first
    // conjunct (actor-may-see) fails closed.
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("actor_cannot_see_row");
    }
  });

  it("a platform_admin's cross-org public reach does NOT flow to the scope guard", () => {
    // A platform admin sees public rows across orgs (read filter widening), but
    // scopeMaySeeRow never carries admin standing — a foreign-org public row the
    // admin CAN see is still refused at the (single-org) scope vantage.
    const scope: CollectionScope = { kind: "organization", orgId: ORG };
    const foreignOrgPublic = rowOf({
      ownerLevel: "workspace",
      ownerId: "org-2",
      visibility: "public",
      orgId: "org-2",
    });
    const decision = authorizeCollectionAdd({
      actor: actor({ platformRole: "platform_admin" }),
      scope,
      row: foreignOrgPublic,
      actorMayWriteScope: true,
    });
    // Denied at the scope guard; NO promotion recourse — a foreign-org public
    // row is neither tenant-valid nor a widen into this scope's org.
    expect(decision).toEqual({
      ok: false,
      reason: "scope_cannot_see_row",
      promotion: null,
    });
  });
});
