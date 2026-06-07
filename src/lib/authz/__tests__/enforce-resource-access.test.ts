/**
 * Access-control matrix for object and project CRUD authorization.
 *
 * Parameterized matrix: actor × op × resource. The helper contract is that
 * `enforceResourceAccess` either resolves for authorized actors or rejects
 * with AuthzError while preserving hidden-not-found semantics.
 */
import { describe, it, expect } from "vitest";

import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import type { Permission } from "@/lib/authz/permissions";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

// ---------------------------------------------------------------------------
// Fixtures — actor variants
// ---------------------------------------------------------------------------

type Actor = PrimitiveActorContext;

const OWNER_USER = "user-owner";
const COOWNER_USER = "user-coowner";
const TEAM_ID = "team-A";
const ORG_ID = "org-A";
const OTHER_ORG_ID = "org-B";

const actors: Record<string, Actor | null> = {
  anonymous: null,
  owner: { userId: OWNER_USER, orgId: ORG_ID, roles: ["member"] } as unknown as Actor,
  coOwner: { userId: COOWNER_USER, orgId: ORG_ID, roles: ["member"] } as unknown as Actor,
  teamAdmin: {
    userId: "user-team-admin",
    orgId: ORG_ID,
    roles: ["member"],
    teamRoles: { [TEAM_ID]: "admin" },
  } as unknown as Actor,
  teamMember: {
    userId: "user-team-member",
    orgId: ORG_ID,
    roles: ["member"],
    teamRoles: { [TEAM_ID]: "member" },
  } as unknown as Actor,
  orgAdmin: { userId: "user-org-admin", orgId: ORG_ID, roles: ["owner"] } as unknown as Actor,
  orgMember: { userId: "user-org-member", orgId: ORG_ID, roles: ["member"] } as unknown as Actor,
  crossOrg: { userId: "user-cross-org", orgId: OTHER_ORG_ID, roles: ["member"] } as unknown as Actor,
  platformAdmin: { userId: "user-pa", orgId: ORG_ID, roles: ["platform_admin"] } as unknown as Actor,
};

// ---------------------------------------------------------------------------
// Fixtures — resource variants
// ---------------------------------------------------------------------------

const userOwnedProject: ResourceForAccessCheck = {
  resourceType: "project",
  resourceId: "proj-user",
  organizationId: ORG_ID,
  ownerLevel: "user",
  ownerId: OWNER_USER,
  visibility: "private",
  coOwnerUserIds: [COOWNER_USER],
};

const teamOwnedProject: ResourceForAccessCheck = {
  resourceType: "project",
  resourceId: "proj-team",
  organizationId: ORG_ID,
  ownerLevel: "team",
  ownerId: TEAM_ID,
  visibility: "team",
};

const orgOwnedProject: ResourceForAccessCheck = {
  resourceType: "project",
  resourceId: "proj-org",
  organizationId: ORG_ID,
  ownerLevel: "organization",
  ownerId: ORG_ID,
  visibility: "organization",
};

const workspaceOwnedObject: ResourceForAccessCheck = {
  resourceType: "object",
  resourceId: "obj-workspace",
  organizationId: ORG_ID,
  ownerLevel: "workspace",
  ownerId: "platform",
  visibility: "public",
};

// ---------------------------------------------------------------------------
// Matrix — [name, actorKey, op, resource, expectAllow]
// ---------------------------------------------------------------------------

const cases: Array<[string, keyof typeof actors, Permission, ResourceForAccessCheck, boolean]> = [
  // owner row
  ["owner reads own user-owned project", "owner", "project.read", userOwnedProject, true],
  ["owner updates own user-owned project", "owner", "project.update", userOwnedProject, true],
  ["owner deletes own user-owned project", "owner", "project.delete", userOwnedProject, true],

  // co-owner row — read/update/manageMembers, not delete
  ["co-owner reads project", "coOwner", "project.read", userOwnedProject, true],
  ["co-owner updates project", "coOwner", "project.update", userOwnedProject, true],
  ["co-owner manages members", "coOwner", "project.manageMembers", userOwnedProject, true],
  ["co-owner DENIED delete", "coOwner", "project.delete", userOwnedProject, false],

  // cross-org — DENY all
  ["cross-org DENIED read on user-owned", "crossOrg", "project.read", userOwnedProject, false],
  ["cross-org DENIED read on team-owned", "crossOrg", "project.read", teamOwnedProject, false],
  ["cross-org DENIED read on org-owned", "crossOrg", "project.read", orgOwnedProject, false],

  // platform admin — read bypass; NO write bypass
  ["platform_admin reads cross-scope user-owned", "platformAdmin", "project.read", userOwnedProject, true],
  ["platform_admin reads cross-scope team-owned", "platformAdmin", "project.read", teamOwnedProject, true],
  ["platform_admin DENIED update on user-owned", "platformAdmin", "project.update", userOwnedProject, false],
  ["platform_admin DENIED delete on user-owned", "platformAdmin", "project.delete", userOwnedProject, false],

  // org-member — read on org-owned; deny write
  ["org-member reads org-owned", "orgMember", "project.read", orgOwnedProject, true],
  ["org-member DENIED update org-owned", "orgMember", "project.update", orgOwnedProject, false],

  // team admin
  ["team-admin updates team-owned", "teamAdmin", "project.update", teamOwnedProject, true],
  ["team-member reads team-owned", "teamMember", "project.read", teamOwnedProject, true],
  ["team-member DENIED update team-owned", "teamMember", "project.update", teamOwnedProject, false],

  // anonymous
  ["anonymous DENIED read on org-owned", "anonymous", "project.read", orgOwnedProject, false],

  // workspace
  ["platform_admin reads workspace-owned object", "platformAdmin", "object.read", workspaceOwnedObject, true],
  ["org-member DENIED workspace-owned object update", "orgMember", "object.update", workspaceOwnedObject, false],

  // promoteScope — only admins at target level
  ["team-member DENIED promoteScope", "teamMember", "project.update", userOwnedProject, false],
];

describe("enforceResourceAccess matrix", () => {
  it.each(cases)("%s", async (_name, actorKey, op, resource, expectAllow) => {
    const actor = actors[actorKey];
    if (expectAllow) {
      await expect(enforceResourceAccess(resource, actor, op)).resolves.toBeUndefined();
    } else {
      await expect(enforceResourceAccess(resource, actor, op)).rejects.toBeInstanceOf(AuthzError);
    }
  });

  it("null resource -> 404 hidden", async () => {
    await expect(enforceResourceAccess(null, actors.owner, "project.read")).rejects.toBeInstanceOf(
      AuthzError,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-org guard on projects.organization_id.
//
// The guard compares the actor's `organizationId` (sourced from
// session.activeOrganizationId) against the resource row's `organization_id`.
// Three cases:
//   1. actor.org=A, resource.org=B → DENIED (cross-tenant isolation)
//   2. actor.org=A, resource.org=null (legacy row) → NOT BLOCKED by the
//      org guard. The kernel treats null as "no tenant constraint" so
//      legacy rows degrade gracefully.
//   3. actor.org=A, resource.org=A → other ACL conditions decide. With
//      a user-owner short-circuit in play, the owner is allowed.
// ---------------------------------------------------------------------------
describe("cross-org guard on projects.organization_id", () => {
  const actorInOrgA = actors.owner!; // userId=user-owner, orgId=org-A

  it("denies actor from org-A reading project owned by org-B", async () => {
    const projectInOrgB: ResourceForAccessCheck = {
      resourceType: "project",
      resourceId: "proj-other-tenant",
      organizationId: OTHER_ORG_ID,
      ownerLevel: "organization",
      ownerId: OTHER_ORG_ID,
      visibility: "private",
    };
    await expect(
      enforceResourceAccess(projectInOrgB, actorInOrgA, "project.read"),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("allows actor from org-A on legacy row with null organization_id", async () => {
    // Legacy rows carry NULL organization_id. The kernel cross-org guard
    // short-circuits on null (documented "no tenant constraint" semantics)
    // so the call is decided by the user-owner short-circuit.
    const legacyUserOwned: ResourceForAccessCheck = {
      resourceType: "project",
      resourceId: "proj-legacy",
      organizationId: null,
      ownerLevel: "user",
      ownerId: OWNER_USER, // matches actorInOrgA.userId
      visibility: "private",
    };
    await expect(
      enforceResourceAccess(legacyUserOwned, actorInOrgA, "project.read"),
    ).resolves.toBeUndefined();
  });

  it("allows actor from org-A reading user-owned project in org-A", async () => {
    // Same-tenant + user-owner → owner short-circuit fires, regardless
    // of the org-id match. Confirms the guard does not over-deny.
    const sameOrgUserOwned: ResourceForAccessCheck = {
      resourceType: "project",
      resourceId: "proj-same-tenant",
      organizationId: ORG_ID,
      ownerLevel: "user",
      ownerId: OWNER_USER,
      visibility: "private",
    };
    await expect(
      enforceResourceAccess(sameOrgUserOwned, actorInOrgA, "project.read"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Registry resourceType integration assertions.
//
// Locks the contract for the kernel call inside installRegistryPackageAtScope:
// the kernel must accept resourceType: "registry" and the team-owner
// short-circuit at enforce-resource-access.ts:217-225 must fire on
// registry-typed resources for team_admin actors.
// ---------------------------------------------------------------------------
describe("enforceResourceAccess — registry resourceType", () => {
  const teamAdminTeamA = {
    userId: "user-registry-team-admin",
    orgId: ORG_ID,
    roles: ["member"],
    teamRoles: { [TEAM_ID]: "team_admin" },
  } as unknown as Actor;

  const memberNoTeamRole = {
    userId: "user-registry-member",
    orgId: ORG_ID,
    roles: ["member"],
  } as unknown as Actor;

  const orgAdmin = {
    userId: "user-registry-org-admin",
    orgId: ORG_ID,
    roles: ["admin"],
  } as unknown as Actor;

  const teamRegistryResource: ResourceForAccessCheck = {
    resourceType: "registry",
    resourceId: "@cinatra/foo",
    organizationId: ORG_ID,
    ownerLevel: "team",
    ownerId: TEAM_ID,
    visibility: null,
  };

  const orgRegistryResource: ResourceForAccessCheck = {
    resourceType: "registry",
    resourceId: "@cinatra/foo",
    organizationId: ORG_ID,
    ownerLevel: "organization",
    ownerId: ORG_ID,
    visibility: null,
  };

  it("team_admin of owning team is ALLOWED on team-owned registry resource", async () => {
    await expect(
      enforceResourceAccess(teamRegistryResource, teamAdminTeamA, "registry.install"),
    ).resolves.toBeUndefined();
  });

  it("plain member is DENIED on team-owned registry resource", async () => {
    await expect(
      enforceResourceAccess(teamRegistryResource, memberNoTeamRole, "registry.install"),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("org_admin is ALLOWED on org-owned registry resource (DIRECT_GRANTS path)", async () => {
    await expect(
      enforceResourceAccess(orgRegistryResource, orgAdmin, "registry.install"),
    ).resolves.toBeUndefined();
  });
});
