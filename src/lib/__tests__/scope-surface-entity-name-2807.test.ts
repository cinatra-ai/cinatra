// cinatra#2807 (per-scope surfaces S1, fix leg 2) — the page heading's name
// read is GATED.
//
// The heading now names the entity on every scoped tab, which makes the name a
// disclosure. This suite holds the one reader behind that heading to each
// scope's own read gate: a caller who may not read the entity is told nothing,
// and the header falls back to the scope's kind noun instead.
//
// Every gate stand-in below answers the ARGUMENTS it is given rather than a
// fixed value, and each refusal test also asserts which entity the gate was
// asked about. A reader that gated the wrong entity — asked for a grant on some
// other project, or for membership of some other organization — would return a
// name it must not, so the mocks are the assertion, not just a switch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  getActorContext: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("@/lib/auth-session", () => session);

const authDb = vi.hoisted(() => ({
  betterAuthDb: { execute: vi.fn() },
  readUserIsOrgMember: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => authDb);

const store = vi.hoisted(() => {
  const rows: { value: unknown[] } = { value: [] };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows.value,
  };
  return { rows, projectsDb: { select: () => chain }, projects: {} };
});
vi.mock("@/lib/projects-store", () => ({
  projectsDb: store.projectsDb,
  projects: store.projects,
}));

const gate = vi.hoisted(() => ({ actorHoldsProjectGrant: vi.fn() }));
vi.mock("@/lib/authz/project-read-gate", () => gate);

const teamAuthority = vi.hoisted(() => ({ canManageTeamMembers: vi.fn() }));
vi.mock(
  "@/app/teams/[teamId]/settings/team-member-authority",
  () => teamAuthority,
);

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

import { readScopeSurfaceEntityName } from "@/lib/scope-surface-entity-name";

const SIGNED_IN = {
  user: { id: "u1" },
  session: { activeOrganizationId: "org_1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  store.rows.value = [];
  session.getAuthSession.mockResolvedValue(SIGNED_IN);
  session.isPlatformAdmin.mockReturnValue(false);
  session.resolveOrgRoleForUser.mockResolvedValue("member");
  teamAuthority.canManageTeamMembers.mockReturnValue(false);
});

describe("the scopes the drawing names itself need no read at all", () => {
  it("returns no name for the workspace scope and touches no store", async () => {
    expect(await readScopeSurfaceEntityName({ kind: "workspace" })).toBeNull();
    expect(session.getAuthSession).not.toHaveBeenCalled();
    expect(authDb.betterAuthDb.execute).not.toHaveBeenCalled();
  });

  it("returns no name for the personal scope and touches no store", async () => {
    expect(await readScopeSurfaceEntityName({ kind: "personal" })).toBeNull();
    expect(authDb.betterAuthDb.execute).not.toHaveBeenCalled();
  });
});

describe("the organization name is told only to a member OF THAT organization", () => {
  beforeEach(() => {
    // Membership answers the pair it is asked about: u1 belongs to o1 only.
    authDb.readUserIsOrgMember.mockImplementation(
      async (userId: string, orgId: string) => userId === "u1" && orgId === "o1",
    );
    authDb.betterAuthDb.execute.mockResolvedValue({
      rows: [{ name: "Acme Corp" }],
    });
  });

  it("names the organization for a member, gating on the requested organization", async () => {
    expect(
      await readScopeSurfaceEntityName({ kind: "organization", id: "o1" }),
    ).toBe("Acme Corp");
    expect(authDb.readUserIsOrgMember).toHaveBeenCalledWith("u1", "o1");
  });

  it("tells a member of a DIFFERENT organization nothing about this one", async () => {
    expect(
      await readScopeSurfaceEntityName({ kind: "organization", id: "o2" }),
    ).toBeNull();
    expect(authDb.readUserIsOrgMember).toHaveBeenCalledWith("u1", "o2");
    expect(authDb.betterAuthDb.execute).not.toHaveBeenCalled();
  });

  it("tells a non-member nothing", async () => {
    authDb.readUserIsOrgMember.mockResolvedValue(false);
    expect(
      await readScopeSurfaceEntityName({ kind: "organization", id: "o1" }),
    ).toBeNull();
    expect(authDb.betterAuthDb.execute).not.toHaveBeenCalled();
  });

  it("tells a signed-out caller nothing", async () => {
    session.getAuthSession.mockResolvedValue(null);
    expect(
      await readScopeSurfaceEntityName({ kind: "organization", id: "o1" }),
    ).toBeNull();
    expect(authDb.readUserIsOrgMember).not.toHaveBeenCalled();
  });
});

describe("the project name is told only to a holder of a grant for THAT project", () => {
  beforeEach(() => {
    session.getActorContext.mockResolvedValue({ id: "u1" });
    // The grant stand-in answers the project id it is asked about: the caller
    // holds a grant on p1 and on nothing else.
    gate.actorHoldsProjectGrant.mockImplementation(
      (_actor: unknown, projectId: string) => projectId === "p1",
    );
  });

  it("names the project for a grant holder, gating on the requested project", async () => {
    store.rows.value = [{ id: "p1", name: "Apollo" }];
    expect(
      await readScopeSurfaceEntityName({ kind: "project", id: "p1" }),
    ).toBe("Apollo");
    expect(gate.actorHoldsProjectGrant).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
    );
  });

  it("tells a holder of a grant on a DIFFERENT project nothing about this one", async () => {
    store.rows.value = [{ id: "p2", name: "Nebula" }];
    expect(
      await readScopeSurfaceEntityName({ kind: "project", id: "p2" }),
    ).toBeNull();
    expect(gate.actorHoldsProjectGrant).toHaveBeenCalledWith(
      expect.anything(),
      "p2",
    );
  });

  it("tells a caller without a grant nothing", async () => {
    store.rows.value = [{ id: "p1", name: "Apollo" }];
    gate.actorHoldsProjectGrant.mockReturnValue(false);
    expect(
      await readScopeSurfaceEntityName({ kind: "project", id: "p1" }),
    ).toBeNull();
  });

  it("tells a caller with no resolved actor nothing", async () => {
    store.rows.value = [{ id: "p1", name: "Apollo" }];
    session.getActorContext.mockResolvedValue(null);
    expect(
      await readScopeSurfaceEntityName({ kind: "project", id: "p1" }),
    ).toBeNull();
  });
});

describe("the team name is told only inside the active tenant, to a member or manager", () => {
  const teamRow = (over: Record<string, unknown> = {}) => ({
    rows: [
      { name: "Growth", organizationId: "org_1", is_member: true, ...over },
    ],
  });

  it("names the team for a member of the active tenant's team", async () => {
    authDb.betterAuthDb.execute.mockResolvedValue(teamRow());
    expect(await readScopeSurfaceEntityName({ kind: "team", id: "t1" })).toBe(
      "Growth",
    );
  });

  it("tells a caller whose active tenant is a different organization nothing", async () => {
    authDb.betterAuthDb.execute.mockResolvedValue(
      teamRow({ organizationId: "org_2" }),
    );
    expect(
      await readScopeSurfaceEntityName({ kind: "team", id: "t1" }),
    ).toBeNull();
  });

  it("tells a non-member without manager authority nothing", async () => {
    authDb.betterAuthDb.execute.mockResolvedValue(teamRow({ is_member: false }));
    expect(
      await readScopeSurfaceEntityName({ kind: "team", id: "t1" }),
    ).toBeNull();
  });

  it("names the team for a non-member who MAY manage it, on the authority the org role gives", async () => {
    authDb.betterAuthDb.execute.mockResolvedValue(teamRow({ is_member: false }));
    session.resolveOrgRoleForUser.mockResolvedValue("owner");
    teamAuthority.canManageTeamMembers.mockReturnValue(true);
    expect(await readScopeSurfaceEntityName({ kind: "team", id: "t1" })).toBe(
      "Growth",
    );
    expect(session.resolveOrgRoleForUser).toHaveBeenCalledWith("org_1", "u1");
    expect(teamAuthority.canManageTeamMembers).toHaveBeenCalledWith({
      platformAdmin: false,
      orgRole: "owner",
    });
  });
});

describe("a store failure never takes the page down", () => {
  it("returns no name when the read throws", async () => {
    authDb.readUserIsOrgMember.mockRejectedValue(new Error("store down"));
    expect(
      await readScopeSurfaceEntityName({ kind: "organization", id: "o1" }),
    ).toBeNull();
  });
});
