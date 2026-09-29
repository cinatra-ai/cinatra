// cinatra#3787: an entity ref may carry its OWN organization, and the generic
// entity-dashboard delegate then files and lists under that one.
//
// The delegate derived its tenant from the session's active organization alone.
// That is right for the personal and index surfaces, where the entity IS the
// active organization, and wrong for a team: the owner's decision on cinatra#3693
// puts a scope's surface under the scope's organization, whatever the session
// has active. So the ref carries an optional organization, the delegate honours
// it ahead of the session-derived default, and a ref without one keeps today's
// behaviour exactly.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/db", () => ({
  auditEvents: {},
  dashboardRevisions: {},
  dashboards: {},
  getDashboardsDb: () => {
    throw new Error("unexpected direct db access in this test");
  },
}));

const service = vi.hoisted(() => ({
  listDashboardsForEntity: vi.fn(),
  createEntityDashboard: vi.fn(),
}));
vi.mock("../mutation-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mutation-service")>();
  return {
    ...original,
    listDashboardsForEntity: service.listDashboardsForEntity,
    createEntityDashboard: service.createEntityDashboard,
  };
});

const ACTIVE_ORG = "org_active";
const TEAM_ORG = "org_team";

const sessionActor = vi.hoisted(() => ({
  buildDashboardActorFromSession: vi.fn(),
}));
vi.mock("@/lib/dashboards/dashboard-actor", () => sessionActor);

const auth = vi.hoisted(() => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "u1" } })),
  resolveOrgRoleForUser: vi.fn(
    async (): Promise<string | undefined> => "org_owner",
  ),
}));
vi.mock("@/lib/auth-session", () => auth);

const orgWrite = vi.hoisted(() => ({
  sessionAuthorityFromResolvedRole: vi.fn((orgId: string) => ({
    orgId,
    can: () => true,
  })),
}));
vi.mock("@/lib/org-write/authority", () => orgWrite);

import { createEntityDashboardAction, listEntityDashboardsAction } from "../actions";
import type { DashboardEntityRef } from "../store/entity-identity";

const TEAM_REF: DashboardEntityRef = {
  entityType: "team",
  entityId: "t1",
  ownerLevel: "user",
  ownerId: "u1",
  organizationId: TEAM_ORG,
};

const PERSONAL_REF: DashboardEntityRef = {
  entityType: "personal",
  entityId: ACTIVE_ORG,
  ownerLevel: "user",
  ownerId: "u1",
};

const row = (organizationId: string) => ({
  id: "dash:team:t1:user:u1:overview",
  name: "Overview",
  isDefault: true,
  organizationId,
  entityType: "team",
  entityId: "t1",
  ownerLevel: "user",
  ownerId: "u1",
  projectId: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionActor.buildDashboardActorFromSession.mockResolvedValue({
    actor: { userId: "u1", orgId: ACTIVE_ORG, organizationId: ACTIVE_ORG, teamIds: ["t_other"], orgRole: "member" },
    orgId: ACTIVE_ORG,
    userId: "u1",
    authority: { orgId: ACTIVE_ORG, can: () => true },
  });
  auth.resolveOrgRoleForUser.mockResolvedValue("org_owner");
  orgWrite.sessionAuthorityFromResolvedRole.mockImplementation((orgId: string) => ({
    orgId,
    can: () => true,
  }));
  service.listDashboardsForEntity.mockResolvedValue([row(TEAM_ORG)]);
  service.createEntityDashboard.mockResolvedValue(row(TEAM_ORG));
});

describe("a ref carrying its own organization files and lists under that one", () => {
  it("lists under the ref's organization while another one is active", async () => {
    const result = await listEntityDashboardsAction(TEAM_REF);
    expect(service.listDashboardsForEntity).toHaveBeenCalledTimes(1);
    const actor = service.listDashboardsForEntity.mock.calls[0][1];
    expect(actor.organizationId).toBe(TEAM_ORG);
    expect(result.dashboards[0]?.id).toBe("dash:team:t1:user:u1:overview");
  });

  it("creates under the ref's organization while another one is active", async () => {
    await createEntityDashboardAction(TEAM_REF, "Weekly");
    expect(service.createEntityDashboard).toHaveBeenCalledTimes(1);
    const actor = service.createEntityDashboard.mock.calls[0][1];
    expect(actor.organizationId).toBe(TEAM_ORG);
  });

  it("resolves the caller's organization role against the ref's organization", async () => {
    await listEntityDashboardsAction(TEAM_REF);
    expect(auth.resolveOrgRoleForUser).toHaveBeenCalledWith(TEAM_ORG, "u1");
    const actor = service.listDashboardsForEntity.mock.calls[0][1];
    expect(actor.orgRole).toBe("owner");
  });

  it("carries a write authority minted for the ref's organization", async () => {
    await listEntityDashboardsAction(TEAM_REF);
    expect(orgWrite.sessionAuthorityFromResolvedRole).toHaveBeenCalledWith(
      TEAM_ORG,
      "org_owner",
    );
    const actor = service.listDashboardsForEntity.mock.calls[0][1];
    expect(actor.authority?.orgId).toBe(TEAM_ORG);
  });

  it("asserts no team axis for an organization whose teams it did not read", async () => {
    await listEntityDashboardsAction(TEAM_REF);
    const actor = service.listDashboardsForEntity.mock.calls[0][1];
    expect(actor.teamIds).toEqual([]);
  });

});

// Every export of `actions.ts` is a server action, so a ref is an argument and
// never a fact. A ref may therefore choose the TENANT and nothing else: it must
// name the session user's own rows, and the session must hold a role in the
// organization it names. Both refusals happen before any read.
describe("a named organization chooses the tenant, never the authority", () => {
  it("refuses a ref whose caller holds no role in the organization it names", async () => {
    auth.resolveOrgRoleForUser.mockResolvedValue(undefined);
    await expect(listEntityDashboardsAction(TEAM_REF)).rejects.toThrow(
      /holds no role in the organization/,
    );
    expect(service.listDashboardsForEntity).not.toHaveBeenCalled();
  });

  it("refuses an ORGANIZATION-owned ref that names another organization", async () => {
    // Without this refusal the named organization would land in
    // `actor.organizationId`, and that tier's member arm reads
    // `row.ownerId === actor.organizationId` with no role at all.
    const orgOwnedRef = {
      entityType: "organization",
      entityId: TEAM_ORG,
      ownerLevel: "organization",
      ownerId: TEAM_ORG,
      organizationId: TEAM_ORG,
    } as unknown as DashboardEntityRef;
    await expect(listEntityDashboardsAction(orgOwnedRef)).rejects.toThrow(
      /the session user's own rows/,
    );
    expect(service.listDashboardsForEntity).not.toHaveBeenCalled();
    expect(auth.resolveOrgRoleForUser).not.toHaveBeenCalled();
  });

  it("refuses a ref that names another organization for somebody else's rows", async () => {
    await expect(
      listEntityDashboardsAction({ ...TEAM_REF, ownerId: "u2" }),
    ).rejects.toThrow(/the session user's own rows/);
    expect(service.listDashboardsForEntity).not.toHaveBeenCalled();
  });

  it("refuses a create the same way, before the writer is reached", async () => {
    auth.resolveOrgRoleForUser.mockResolvedValue(undefined);
    await expect(createEntityDashboardAction(TEAM_REF, "Weekly")).rejects.toThrow(
      /holds no role in the organization/,
    );
    expect(service.createEntityDashboard).not.toHaveBeenCalled();
  });
});

describe("a ref without an organization keeps the session-derived tenant", () => {
  it("lists the personal surface under the session's active organization", async () => {
    service.listDashboardsForEntity.mockResolvedValue([]);
    await listEntityDashboardsAction(PERSONAL_REF);
    const actor = service.listDashboardsForEntity.mock.calls[0][1];
    expect(actor.organizationId).toBe(ACTIVE_ORG);
    expect(actor.teamIds).toEqual(["t_other"]);
    expect(auth.resolveOrgRoleForUser).not.toHaveBeenCalled();
    expect(actor.authority?.orgId).toBe(ACTIVE_ORG);
  });
});
