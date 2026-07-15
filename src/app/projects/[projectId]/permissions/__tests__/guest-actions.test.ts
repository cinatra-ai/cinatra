// cinatra#1501 — guest access server actions. The contract under test:
//
//  1. Invite is by EMAIL, project-admin-gated (assertProjectAdmin precedent).
//  2. Existing accounts are CLASSIFIED before any grant: org member →
//     already-member; existing guest here → idempotent refresh; other project
//     access → already-has-access; only a truly external account is granted.
//  3. Unknown emails create the account through the SANCTIONED paths only:
//     signUpEmail (public-path semantics — respects the closed-registration
//     gate) with a ≥12-char random password; on REGISTRATION_CLOSED a
//     platform-admin inviter falls back to the admin plugin's
//     /admin/create-user (D1) with the actor's headers, anyone else gets a
//     structured "registration-closed" error. Create races re-read by email.
//  4. New guests get a password-reset email (redirectTo the reset view); a
//     send failure is surfaced as resetEmailSent:false, never unwound.
//  5. Guests are never org members — no membership write exists in the module.
//
// Driven against explicit mocks; @/lib/auth is never imported for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(),
  resolveOrgRoleForSession: vi.fn(),
  readTeamsForUser: vi.fn(),
  readProjectGrantsForUser: vi.fn(),
  readUserByEmail: vi.fn(),
  readUserIsOrgMember: vi.fn(),
  readProjectById: vi.fn(),
  readUsersByIds: vi.fn(),
  grantCustomerAccess: vi.fn(),
  revokeCustomerAccess: vi.fn(),
  listCustomerGrantsForProject: vi.fn(),
  signUpEmail: vi.fn(),
  createUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  headers: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: h.requireAuthSession,
  isPlatformAdmin: h.isPlatformAdmin,
  resolveOrgRoleForSession: h.resolveOrgRoleForSession,
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: h.readTeamsForUser,
  readProjectGrantsForUser: h.readProjectGrantsForUser,
  readUserByEmail: h.readUserByEmail,
  readUserIsOrgMember: h.readUserIsOrgMember,
  readUsersByIds: h.readUsersByIds,
}));
vi.mock("@/lib/projects-store", () => ({ readProjectById: h.readProjectById }));
vi.mock("@/lib/authz/customer-grant-store", () => ({
  grantCustomerAccess: h.grantCustomerAccess,
  revokeCustomerAccess: h.revokeCustomerAccess,
  listCustomerGrantsForProject: h.listCustomerGrantsForProject,
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      signUpEmail: h.signUpEmail,
      createUser: h.createUser,
      requestPasswordReset: h.requestPasswordReset,
    },
  },
}));
vi.mock("next/headers", () => ({ headers: h.headers }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

import {
  inviteGuestByEmailAction,
  revokeGuestAction,
  listGuestRows,
} from "../guest-actions";

const PROJECT = "proj-1";
const ORG = "org-1";

function primeAdminSession(opts: { platformAdmin?: boolean } = {}) {
  h.requireAuthSession.mockResolvedValue({
    user: { id: "actor-1" },
    // Deliberately a DIFFERENT active org than the project's: the tenant must
    // come from the project row, never the actor's active org.
    session: { activeOrganizationId: "org-elsewhere" },
  });
  h.readProjectById.mockResolvedValue({ id: PROJECT, organizationId: ORG });
  h.isPlatformAdmin.mockReturnValue(opts.platformAdmin ?? false);
  h.readTeamsForUser.mockResolvedValue([]);
  h.resolveOrgRoleForSession.mockResolvedValue("member");
  // The ACTOR's own grant check inside assertProjectAdmin (platform admins
  // short-circuit before this read).
  h.readProjectGrantsForUser.mockResolvedValue([
    { projectId: PROJECT, effectiveRole: "admin" },
  ]);
}

function registrationClosedError() {
  const err = new Error("closed") as Error & { body?: { code?: string } };
  err.body = { code: "REGISTRATION_CLOSED" };
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.headers.mockResolvedValue(new Headers());
  h.listCustomerGrantsForProject.mockResolvedValue([]);
  h.grantCustomerAccess.mockResolvedValue(undefined);
  h.requestPasswordReset.mockResolvedValue(undefined);
});

describe("inviteGuestByEmailAction — gating and validation", () => {
  it("rejects an implausible email before touching auth", async () => {
    primeAdminSession();
    const r = await inviteGuestByEmailAction(PROJECT, "not-an-email", null);
    expect(r).toEqual({ ok: false, error: "invalid-email" });
    expect(h.requireAuthSession).not.toHaveBeenCalled();
  });

  it("returns forbidden when the actor is not a project admin", async () => {
    primeAdminSession();
    h.readProjectGrantsForUser.mockResolvedValueOnce([
      { projectId: PROJECT, effectiveRole: "read" },
    ]);
    const r = await inviteGuestByEmailAction(PROJECT, "x@example.com", null);
    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(h.grantCustomerAccess).not.toHaveBeenCalled();
  });
});

describe("inviteGuestByEmailAction — existing-account classification", () => {
  it("rejects an org member with already-member and never grants", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue({ id: "u-member", name: "M", email: "m@x.com" });
    h.readUserIsOrgMember.mockResolvedValue(true);
    const r = await inviteGuestByEmailAction(PROJECT, "m@x.com", null);
    expect(r).toEqual({ ok: false, error: "already-member" });
    expect(h.grantCustomerAccess).not.toHaveBeenCalled();
  });

  it("refreshes an existing guest idempotently — no reset email", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue({ id: "u-guest", name: "G", email: "g@x.com" });
    h.readUserIsOrgMember.mockResolvedValue(false);
    h.listCustomerGrantsForProject.mockResolvedValue([{ subjectUserId: "u-guest" }]);
    const r = await inviteGuestByEmailAction(PROJECT, "G@X.com", "2027-01-01");
    expect(r).toMatchObject({
      ok: true,
      guest: { userId: "u-guest", existed: true },
      resetEmailSent: false,
    });
    expect(h.grantCustomerAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: "u-guest", projectId: PROJECT, orgId: ORG }),
    );
    expect(h.requestPasswordReset).not.toHaveBeenCalled();
    // classification read the SUBJECT's grants? not needed for existing guest
  });

  it("rejects standard-authorized users with already-has-access", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue({ id: "u-std", name: "S", email: "s@x.com" });
    h.readUserIsOrgMember.mockResolvedValue(false);
    h.listCustomerGrantsForProject.mockResolvedValue([]);
    // Second readProjectGrantsForUser call = the SUBJECT's grants.
    h.readProjectGrantsForUser
      .mockResolvedValueOnce([{ projectId: PROJECT, effectiveRole: "admin" }]) // actor
      .mockResolvedValueOnce([{ projectId: PROJECT, effectiveRole: "write" }]); // subject
    const r = await inviteGuestByEmailAction(PROJECT, "s@x.com", null);
    expect(r).toEqual({ ok: false, error: "already-has-access" });
    expect(h.grantCustomerAccess).not.toHaveBeenCalled();
  });

  it("grants a truly external existing account as guest without a reset email", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue({ id: "u-ext", name: "E", email: "e@x.com" });
    h.readUserIsOrgMember.mockResolvedValue(false);
    h.readProjectGrantsForUser
      .mockResolvedValueOnce([{ projectId: PROJECT, effectiveRole: "admin" }]) // actor
      .mockResolvedValueOnce([]); // subject
    const r = await inviteGuestByEmailAction(PROJECT, "e@x.com", null);
    expect(r).toMatchObject({ ok: true, guest: { userId: "u-ext", existed: true } });
    expect(h.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("inviteGuestByEmailAction — account creation", () => {
  it("creates via signUpEmail (≥12-char random password), grants, and sends the reset email", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue(null);
    h.signUpEmail.mockResolvedValue({ user: { id: "u-new" } });
    const r = await inviteGuestByEmailAction(PROJECT, "New@Guest.com", null);
    expect(r).toEqual({
      ok: true,
      guest: { userId: "u-new", email: "new@guest.com", name: null, existed: false },
      resetEmailSent: true,
    });
    const body = h.signUpEmail.mock.calls[0][0].body;
    expect(body.email).toBe("new@guest.com");
    expect(body.password.length).toBeGreaterThanOrEqual(12);
    expect(h.grantCustomerAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: "u-new" }),
    );
    expect(h.requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "new@guest.com", redirectTo: "/permissions/reset-password" },
    });
    // Guests are never org members: no membership-writing dep even exists here.
    expect(h.createUser).not.toHaveBeenCalled();
  });

  it("REGISTRATION_CLOSED + non-platform-admin → structured registration-closed", async () => {
    primeAdminSession({ platformAdmin: false });
    h.readUserByEmail.mockResolvedValue(null);
    h.signUpEmail.mockRejectedValue(registrationClosedError());
    const r = await inviteGuestByEmailAction(PROJECT, "n@g.com", null);
    expect(r).toEqual({ ok: false, error: "registration-closed" });
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.grantCustomerAccess).not.toHaveBeenCalled();
  });

  it("REGISTRATION_CLOSED + platform admin → sanctioned /admin/create-user fallback with actor headers", async () => {
    primeAdminSession({ platformAdmin: true });
    h.readUserByEmail.mockResolvedValue(null);
    h.signUpEmail.mockRejectedValue(registrationClosedError());
    h.createUser.mockResolvedValue({ user: { id: "u-admin-made" } });
    const r = await inviteGuestByEmailAction(PROJECT, "n@g.com", null);
    expect(r).toMatchObject({ ok: true, guest: { userId: "u-admin-made", existed: false } });
    expect(h.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it("create race: signUpEmail fails, re-read by email finds the row → grant proceeds", async () => {
    primeAdminSession();
    h.readUserByEmail
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce({ id: "u-raced", name: null, email: "r@x.com" }); // post-failure re-read
    h.signUpEmail.mockRejectedValue(new Error("duplicate key"));
    const r = await inviteGuestByEmailAction(PROJECT, "r@x.com", null);
    expect(r).toMatchObject({ ok: true, guest: { userId: "u-raced" } });
    expect(h.grantCustomerAccess).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUserId: "u-raced" }),
    );
  });

  it("reset-email failure is surfaced (resetEmailSent:false) without unwinding the invite", async () => {
    primeAdminSession();
    h.readUserByEmail.mockResolvedValue(null);
    h.signUpEmail.mockResolvedValue({ user: { id: "u-new2" } });
    h.requestPasswordReset.mockRejectedValue(new Error("smtp down"));
    const r = await inviteGuestByEmailAction(PROJECT, "n2@g.com", null);
    expect(r).toMatchObject({ ok: true, resetEmailSent: false });
    expect(h.grantCustomerAccess).toHaveBeenCalled();
  });
});

describe("revokeGuestAction / listGuestRows", () => {
  it("revoke removes exactly the guest-grant rows (store call) under the admin gate", async () => {
    primeAdminSession();
    h.revokeCustomerAccess.mockResolvedValue(undefined);
    const r = await revokeGuestAction(PROJECT, "u-guest");
    expect(r).toEqual({ ok: true });
    expect(h.revokeCustomerAccess).toHaveBeenCalledWith({
      subjectUserId: "u-guest",
      projectId: PROJECT,
    });
  });

  it("revoke reports failure when the actor is not a project admin", async () => {
    primeAdminSession();
    h.readProjectGrantsForUser.mockResolvedValueOnce([
      { projectId: PROJECT, effectiveRole: "read" },
    ]);
    const r = await revokeGuestAction(PROJECT, "u-guest");
    expect(r).toEqual({ ok: false });
    expect(h.revokeCustomerAccess).not.toHaveBeenCalled();
  });

  it("listGuestRows joins user display rows onto the grants", async () => {
    primeAdminSession();
    const granted = new Date("2026-07-01T00:00:00Z");
    h.listCustomerGrantsForProject.mockResolvedValue([
      { subjectUserId: "u-1", grantedAt: granted, expiresAt: null },
    ]);
    h.readUsersByIds.mockResolvedValue([{ id: "u-1", name: "Guest One", email: "one@x.com" }]);
    const rows = await listGuestRows(PROJECT);
    expect(rows).toEqual([
      {
        subjectUserId: "u-1",
        name: "Guest One",
        email: "one@x.com",
        grantedAt: granted.toISOString(),
        expiresAt: null,
      },
    ]);
  });
});
