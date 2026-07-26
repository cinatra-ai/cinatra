/**
 * The scope Dashboards tab — pure collection model (cinatra#1897 B4). Exercises
 * the three §IX.1 dispositions (addable / promotion / not-addable) and the
 * three-gate conjunction (actor-see → actor-write-scope → scope-see) the picker
 * renders, composing the landed collection-add contract (cinatra#1886).
 */
import { describe, expect, it } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ListingScope } from "@cinatra-ai/dashboards/entity-links";
import {
  authorizeScopeAdd,
  buildAddPickerModel,
  toCollectionScope,
  type ScopeAddCandidate,
} from "@/lib/dashboards/scope-dashboards-collection";

const ORG = "org-1";
const TEAM = "team-1";
const PROJECT = "proj-1";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u1",
  authSource: "ui",
  policyVersion: "v2",
  organizationId: ORG,
  teamIds: [TEAM],
  projectIds: [PROJECT],
  projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }],
} as ActorContext;

const teamScope: ListingScope = { kind: "team", scopeId: TEAM, orgId: ORG };
const orgScope: ListingScope = { kind: "organization", scopeId: ORG, orgId: ORG };
const projectScope: ListingScope = { kind: "project", scopeId: PROJECT, orgId: ORG };

/** A private, user-owned dashboard the ACTOR owns (so the actor sees it) but a
 *  generic scope member cannot (private). */
const privateOwnByActor: ScopeAddCandidate = {
  id: "dash-private",
  name: "Personal experiments",
  homeLabel: "Personal",
  ownerLevel: "user",
  ownerId: "u1",
  visibility: "private",
  projectId: null,
  orgId: ORG,
};

/** A team-owned dashboard of the scope's team — visible to the whole team. */
const teamOwned: ScopeAddCandidate = {
  id: "dash-team",
  name: "Expansion pipeline",
  homeLabel: "Team: Growth",
  ownerLevel: "team",
  ownerId: TEAM,
  visibility: "team",
  projectId: null,
  orgId: ORG,
};

/** An org-visible dashboard — visible to every org member. */
const orgVisible: ScopeAddCandidate = {
  id: "dash-org",
  name: "Win/loss review",
  homeLabel: "Organization: Acme Corp",
  ownerLevel: "organization",
  ownerId: ORG,
  visibility: "organization",
  projectId: null,
  orgId: ORG,
};

/** A project-tagged dashboard visible to the project room. */
const projectTagged: ScopeAddCandidate = {
  id: "dash-proj",
  name: "Sealed room board",
  homeLabel: "Project: Atlas",
  ownerLevel: "user",
  ownerId: "someone",
  visibility: "private",
  projectId: PROJECT,
  orgId: ORG,
};

const model = (scope: ListingScope, candidates: ScopeAddCandidate[]) =>
  buildAddPickerModel({ actor, scope, actorMayWriteScope: true, candidates });

describe("toCollectionScope", () => {
  it("maps the three listing scopes onto the contract's CollectionScope", () => {
    expect(toCollectionScope(teamScope)).toEqual({ kind: "team", teamId: TEAM, orgId: ORG });
    expect(toCollectionScope(orgScope)).toEqual({ kind: "organization", orgId: ORG });
    expect(toCollectionScope(projectScope)).toEqual({
      kind: "project",
      projectId: PROJECT,
      orgId: ORG,
    });
  });
});

describe("ADDABLE — actor sees AND scope sees", () => {
  it("a team-owned dashboard is addable to its team scope", () => {
    const [row] = model(teamScope, [teamOwned]);
    expect(row.disposition).toEqual({ kind: "addable" });
  });
  it("an org-visible dashboard is addable to the org scope", () => {
    const [row] = model(orgScope, [orgVisible]);
    expect(row.disposition).toEqual({ kind: "addable" });
  });
  it("a project-tagged dashboard is addable to its project scope", () => {
    const [row] = model(projectScope, [projectTagged]);
    expect(row.disposition).toEqual({ kind: "addable" });
  });
});

describe("PROMOTION — actor sees, scope cannot, a widen + membership exist", () => {
  it("a team scope offers the TEAM promotion for a private dashboard the actor owns", () => {
    const [row] = model(teamScope, [privateOwnByActor]);
    expect(row.disposition).toEqual({
      kind: "promotion",
      toVisibility: "team",
      targetTeamId: TEAM,
    });
  });
  it("an organization scope offers the ORGANIZATION promotion (no team target)", () => {
    const [row] = model(orgScope, [privateOwnByActor]);
    expect(row.disposition).toEqual({ kind: "promotion", toVisibility: "organization" });
  });
  it("a team target is WITHHELD from a non-member (the contract's live-offer gate)", () => {
    const nonMember = { ...actor, teamIds: [] } as ActorContext;
    const [row] = buildAddPickerModel({
      actor: nonMember,
      scope: teamScope,
      actorMayWriteScope: true,
      candidates: [privateOwnByActor],
    });
    // Actor still sees it (owns it) but is not a member of the target team → no
    // offer → not-addable (fail-closed, no dead recourse).
    expect(row.disposition).toEqual({ kind: "not-addable" });
  });
});

describe("NOT ADDABLE — scope cannot see it and no #1437 recourse applies", () => {
  it("a project scope has NO promotion recourse (a project is a refinement, not a tier)", () => {
    // A private dashboard the actor owns, not project-tagged: the project scope
    // can't see it and a project has no visibility widen → not addable, no offer.
    const [row] = model(projectScope, [privateOwnByActor]);
    expect(row.disposition).toEqual({ kind: "not-addable" });
  });
});

describe("the three-gate conjunction (authz-lens: actor-see → actor-write → scope-see)", () => {
  it("gate 2 (actor-may-write-scope) denies with NO recourse even for a scope-invisible widenable row", () => {
    const decision = authorizeScopeAdd({
      actor,
      scope: teamScope,
      actorMayWriteScope: false,
      row: { id: privateOwnByActor.id, ...ownershipOf(privateOwnByActor) },
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("actor_cannot_write_scope");
      // The promotion recourse is NEVER surfaced on a write-gate failure — only
      // on the scope-see failure (gates 1–2 having passed).
      expect(decision.promotion).toBeNull();
    }
  });

  it("gate 1 (actor-may-see) denies a row the actor cannot see, before scope-see", () => {
    const invisibleToActor: ScopeAddCandidate = {
      ...privateOwnByActor,
      id: "dash-foreign",
      ownerId: "someone-else", // user-owned by another; actor cannot see it
    };
    const decision = authorizeScopeAdd({
      actor,
      scope: teamScope,
      actorMayWriteScope: true,
      row: { id: invisibleToActor.id, ...ownershipOf(invisibleToActor) },
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("actor_cannot_see_row");
      expect(decision.promotion).toBeNull();
    }
  });

  it("all three gates passing → ok:true", () => {
    const decision = authorizeScopeAdd({
      actor,
      scope: teamScope,
      actorMayWriteScope: true,
      row: { id: teamOwned.id, ...ownershipOf(teamOwned) },
    });
    expect(decision.ok).toBe(true);
  });
});

function ownershipOf(c: ScopeAddCandidate) {
  return {
    ownerLevel: c.ownerLevel,
    ownerId: c.ownerId,
    visibility: c.visibility,
    projectId: c.projectId,
    orgId: c.orgId,
  };
}
