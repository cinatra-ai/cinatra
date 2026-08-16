/**
 * PER-ACTION fixtures for the data-safety half of the `/configuration` action
 * sweep (cinatra#2700, epic #2699).
 *
 * `/configuration/artifacts` and its nested restore route are admin-only, and a
 * server action never passes through the segment layout — so member
 * self-service restore retires AT THE ACTION, not merely in the UI. Without
 * that, removing the member-facing affordances (S2) would leave the endpoints
 * they used to call invokable underneath.
 *
 * Covered here: `restoreChangeSetAction` (the confirm path shared by the undo
 * chip, the undo toast and the console's Restore tab) and `freshnessCheckAction`
 * (the console's remote-freshness probe). `restoreObjectToVersionAction` is
 * covered by its own suite, `./restore-object-version-action.test.ts`.
 *
 * NOT changed by the sweep, and asserted here so it stays that way: the
 * per-object authorization that runs AFTER the gate. An admin gets no
 * per-object bypass — `assertChangeSetRestoreAccess` still decides every
 * affected object.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** What `requireAdminSession()` does to a non-admin caller: redirect, by throw. */
class NotAuthorizedRedirect extends Error {
  digest = "NEXT_REDIRECT;replace;/not-authorized";
  constructor() {
    super("NEXT_REDIRECT");
  }
}

const mocks = vi.hoisted(() => {
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
    resolveOrgRoleForSession: vi.fn(async () => "org_admin"),
    resolveSessionRestoreAuthz: vi.fn(async () => ({
      primitiveActor: { userId: "user_1" },
      roleHints: { orgRole: "org_admin" },
    })),
    isSessionEligibleForTargetedRestore: vi.fn(async () => true),
    loadChangeSet: vi.fn(() => ({ changeSet: { id: "cs_1" }, events: [] })),
    restoreChangeSet: vi.fn(() => ({ restoreChangeSetId: "cs_restore_1", appliedEventCount: 2 })),
    resolveExternalFreshness: vi.fn(async () => ({})),
    freshnessCheckForChangeSet: vi.fn(async () => []),
    assertChangeSetRestoreAccess: vi.fn(async () => undefined),
    filterEventsForReadAccess: vi.fn(async () => []),
    verifySessionAuthority: vi.fn(async (_userId: string, orgId: string) => ({ orgId })),
    actorFromSession: vi.fn(() => ({ userId: "user_1" })),
    FakeAuthzError,
  };
});

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: mocks.requireAdminSession,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
}));

vi.mock("@/lib/object-history", () => ({
  loadChangeSet: mocks.loadChangeSet,
  restoreChangeSet: mocks.restoreChangeSet,
  resolveExternalFreshness: mocks.resolveExternalFreshness,
  freshnessCheckForChangeSet: mocks.freshnessCheckForChangeSet,
}));

vi.mock("@/lib/object-history/server-views", () => ({
  assertChangeSetRestoreAccess: mocks.assertChangeSetRestoreAccess,
  filterEventsForReadAccess: mocks.filterEventsForReadAccess,
}));

vi.mock("@/lib/object-history/restore-eligibility", () => ({
  resolveSessionRestoreAuthz: mocks.resolveSessionRestoreAuthz,
  isSessionEligibleForTargetedRestore: mocks.isSessionEligibleForTargetedRestore,
}));

vi.mock("@/lib/authz/errors", () => ({ AuthzError: mocks.FakeAuthzError }));
vi.mock("@/lib/authz/build-actor-context", () => ({ actorFromSession: mocks.actorFromSession }));
vi.mock("@/lib/org-write/authority", () => ({ verifySessionAuthority: mocks.verifySessionAuthority }));

import { restoreChangeSetAction } from "../restore-change-set-action";
import { freshnessCheckAction } from "../freshness-actions";

const ADMIN_SESSION = {
  user: { id: "user_1", role: "user,admin" },
  session: { activeOrganizationId: "org_1" },
};

describe("cinatra#2700 — restoreChangeSetAction requires the platform-admin session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a non-admin BEFORE the change set is even loaded", async () => {
    mocks.requireAdminSession.mockRejectedValue(new NotAuthorizedRedirect());
    await expect(restoreChangeSetAction({ changeSetId: "cs_1" })).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/not-authorized",
    });
    expect(mocks.loadChangeSet).not.toHaveBeenCalled();
    expect(mocks.assertChangeSetRestoreAccess).not.toHaveBeenCalled();
    expect(mocks.restoreChangeSet).not.toHaveBeenCalled();
  });

  it("an admin passes the gate and the restore runs", async () => {
    mocks.requireAdminSession.mockResolvedValue(ADMIN_SESSION);
    const result = await restoreChangeSetAction({ changeSetId: "cs_1" });
    expect(result).toEqual({
      ok: true,
      restoreChangeSetId: "cs_restore_1",
      appliedEventCount: 2,
    });
    expect(mocks.restoreChangeSet).toHaveBeenCalledTimes(1);
  });

  it("the admin gate does NOT bypass the per-object authorization (both must pass)", async () => {
    mocks.requireAdminSession.mockResolvedValue(ADMIN_SESSION);
    mocks.assertChangeSetRestoreAccess.mockRejectedValue(
      new mocks.FakeAuthzError("object obj_1 denied"),
    );
    const result = await restoreChangeSetAction({ changeSetId: "cs_1" });
    expect(result).toEqual({
      ok: false,
      reason: "authz denied for one or more affected objects: object obj_1 denied",
    });
    expect(mocks.restoreChangeSet).not.toHaveBeenCalled();
  });
});

describe("cinatra#2700 — freshnessCheckAction requires the platform-admin session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a non-admin before any change-set read", async () => {
    mocks.requireAdminSession.mockRejectedValue(new NotAuthorizedRedirect());
    await expect(freshnessCheckAction({ changeSetId: "cs_1" })).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/not-authorized",
    });
    expect(mocks.loadChangeSet).not.toHaveBeenCalled();
    expect(mocks.freshnessCheckForChangeSet).not.toHaveBeenCalled();
  });

  it("an admin passes the gate and the probe runs on read-filtered events", async () => {
    mocks.requireAdminSession.mockResolvedValue(ADMIN_SESSION);
    const result = await freshnessCheckAction({ changeSetId: "cs_1" });
    expect(result).toEqual({ ok: true, data: [] });
    // The per-event read redaction still runs on top of the gate.
    expect(mocks.filterEventsForReadAccess).toHaveBeenCalledTimes(1);
    expect(mocks.freshnessCheckForChangeSet).toHaveBeenCalledTimes(1);
  });
});
