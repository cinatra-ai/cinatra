// restoreObjectToVersionAction authz + MutationResult coverage.
//
// cinatra#2700 (epic #2699): the action's session gate is the PLATFORM-ADMIN
// gate — `/configuration/artifacts` is admin-only throughout and a server action
// never passes through the segment layout, so member self-service restore
// retires HERE, not only on the page. `requireAdminSession` is therefore the
// mocked entry gate below, and the per-object `object.update` check keeps
// running on top of it (an admin gets NO per-object bypass).
//
// Mirrors the existing test precedent (mock the substrate, exercise the action's
// guards): orgless caller rejected, not-found hidden, object.update denial
// surfaced as an error (not a throw), happy path returns the
// MutationResult shape ({ ok, data, changeSetId, objectId }). Confirms the
// action threads roleHints into enforceResourceAccess so org-owned objects
// aren't over-denied (the over-deny class).

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  // AuthzError shape: the action narrows on `instanceof AuthzError`, so the
  // mocked module must export the SAME class identity used at the call site.
  // Defined inside vi.hoisted so it survives the mock-factory lift.
  class FakeAuthzError extends Error {
    statusCode = 403;
    reason = "forbidden";
    constructor(message: string) {
      super(message);
      this.name = "AuthzError";
    }
  }
  return {
    requireAdminSession: vi.fn(),
    resolveOrgRoleForSession: vi.fn(),
    getObjectById: vi.fn(),
    enforceResourceAccess: vi.fn(),
    restoreObjectToVersion: vi.fn(),
    // cinatra#1939 wave 3 Stage D: the action mints an org-write authority
    // for the now-guarded restore engine. The stub carries a marker so the
    // happy-path assertion can pin the threading.
    verifySessionAuthority: vi.fn(async (_userId: string, orgId: string) => ({
      orgId,
      can: () => true,
    })),
    FakeAuthzError,
  };
});

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: mocks.requireAdminSession,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
}));

vi.mock("@/lib/object-history", () => ({
  restoreObjectToVersion: mocks.restoreObjectToVersion,
}));

vi.mock("@/lib/objects-store", () => ({
  getObjectById: mocks.getObjectById,
}));

vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: mocks.enforceResourceAccess,
}));

vi.mock("@/lib/authz/resource-ref", () => ({
  normalizeOwnerLevel: (v: string) => v,
}));

vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: (s: { user: { id: string } }) => ({
    actorType: "human",
    userId: s.user.id,
    organizationId: "org_1",
    roles: [],
  }),
}));

vi.mock("@/lib/authz/errors", () => ({ AuthzError: mocks.FakeAuthzError }));

vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: mocks.verifySessionAuthority,
}));

import { restoreObjectToVersionAction } from "../restore-object-version-action";

// The gate has already passed by the time the action body runs, so this fixture
// carries the admin role Better Auth stores as a comma-separated string.
const SESSION_WITH_ORG = {
  user: { id: "user_1", role: "user,admin" },
  session: { activeOrganizationId: "org_1" },
};

/** What `requireAdminSession()` does to a non-admin caller: redirect, by throw. */
class NotAuthorizedRedirect extends Error {
  digest = "NEXT_REDIRECT;replace;/not-authorized";
  constructor() {
    super("NEXT_REDIRECT");
  }
}

const LIVE_OBJECT = {
  id: "obj_1",
  orgId: "org_1",
  ownerLevel: "organization",
  ownerId: "",
  visibility: "organization",
  version: 3,
};

describe("restoreObjectToVersionAction", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) {
      if (typeof (m as { mockReset?: unknown }).mockReset === "function") {
        (m as { mockReset: () => void }).mockReset();
      }
    }
    mocks.resolveOrgRoleForSession.mockResolvedValue("org_admin");
    mocks.getObjectById.mockReturnValue(LIVE_OBJECT);
    mocks.enforceResourceAccess.mockResolvedValue(undefined);
    mocks.restoreObjectToVersion.mockResolvedValue({
      restoreChangeSetId: "cs_restore_1",
      appliedEventCount: 1,
      affectedObjects: ["obj_1"],
    });
  });

  it("cinatra#2700: a NON-ADMIN session is refused by the gate before any read or write", async () => {
    mocks.requireAdminSession.mockRejectedValue(new NotAuthorizedRedirect());
    await expect(
      restoreObjectToVersionAction({ objectId: "obj_1", targetVersion: 2 }),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/not-authorized" });
    expect(mocks.getObjectById).not.toHaveBeenCalled();
    expect(mocks.enforceResourceAccess).not.toHaveBeenCalled();
    expect(mocks.restoreObjectToVersion).not.toHaveBeenCalled();
  });

  it("rejects an orgless session", async () => {
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "user_1" },
      session: { activeOrganizationId: null },
    });
    const result = await restoreObjectToVersionAction({
      objectId: "obj_1",
      targetVersion: 2,
    });
    expect(result).toEqual({
      ok: false,
      error: "no active organization on session",
    });
    expect(mocks.restoreObjectToVersion).not.toHaveBeenCalled();
  });

  it("hides a not-found / cross-org object (returns not-found, not a 403 leak)", async () => {
    mocks.requireAdminSession.mockResolvedValue(SESSION_WITH_ORG);
    mocks.getObjectById.mockReturnValue(null);
    const result = await restoreObjectToVersionAction({
      objectId: "obj_other_org",
      targetVersion: 2,
    });
    expect(result).toEqual({ ok: false, error: "object not found" });
    expect(mocks.enforceResourceAccess).not.toHaveBeenCalled();
    expect(mocks.restoreObjectToVersion).not.toHaveBeenCalled();
  });

  it("surfaces an object.update denial as an error (not a throw)", async () => {
    mocks.requireAdminSession.mockResolvedValue(SESSION_WITH_ORG);
    mocks.enforceResourceAccess.mockRejectedValue(
      new mocks.FakeAuthzError("no object.update"),
    );
    const result = await restoreObjectToVersionAction({
      objectId: "obj_1",
      targetVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/authz denied/);
    expect(mocks.restoreObjectToVersion).not.toHaveBeenCalled();
  });

  it("threads resolved orgRole hints into enforceResourceAccess (no over-deny on org-owned)", async () => {
    mocks.requireAdminSession.mockResolvedValue(SESSION_WITH_ORG);
    await restoreObjectToVersionAction({ objectId: "obj_1", targetVersion: 2 });
    expect(mocks.enforceResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: "object", resourceId: "obj_1" }),
      expect.anything(),
      "object.update",
      { orgRole: "org_admin" },
    );
  });

  it("happy path returns the MutationResult shape with changeSetId + objectId", async () => {
    mocks.requireAdminSession.mockResolvedValue(SESSION_WITH_ORG);
    const result = await restoreObjectToVersionAction({
      objectId: "obj_1",
      targetVersion: 2,
    });
    expect(result).toEqual({
      ok: true,
      data: { restoreChangeSetId: "cs_restore_1", appliedEventCount: 1 },
      // The NEW restore change-set is what an Undo would target.
      changeSetId: "cs_restore_1",
      objectId: "obj_1",
    });
    expect(mocks.restoreObjectToVersion).toHaveBeenCalledWith({
      objectId: "obj_1",
      targetVersion: 2,
      actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
      // #1939 Stage D: the freshly minted org-write authority rides along.
      authority: expect.objectContaining({ orgId: "org_1" }),
    });
    expect(mocks.verifySessionAuthority).toHaveBeenCalledWith("user_1", "org_1");
  });

  it("surfaces a RestoreNotEligibleError message from the engine as an error", async () => {
    mocks.requireAdminSession.mockResolvedValue(SESSION_WITH_ORG);
    mocks.restoreObjectToVersion.mockRejectedValue(
      new Error("object_version_restore: external-source-changed"),
    );
    const result = await restoreObjectToVersionAction({
      objectId: "obj_1",
      targetVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/external-source-changed/);
  });
});
