import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Viewed-org management server actions (cinatra#1510). Locks:
//  - every action FAILS CLOSED through the shared viewed-org gate BEFORE
//    touching Better Auth (a denied gate returns { ok:false } and NEVER calls
//    auth.api / revalidatePath);
//  - settings maps to `userCanManageOrganization` (org_admin+); member + invite
//    ops map to `userCanManageOrganizationMembers` (org_owner) — the correct,
//    distinct gates (an org_admin cannot manage members);
//  - each allowed action calls the right Better Auth endpoint with the VIEWED
//    org id in the body and revalidates `/organizations/[id]`;
//  - a Better Auth throw is surfaced as { ok:false } (no error boundary).
// ---------------------------------------------------------------------------

const updateOrganization = vi.fn();
const updateMemberRole = vi.fn();
const removeMember = vi.fn();
const cancelInvitation = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      updateOrganization: (...a: unknown[]) => updateOrganization(...a),
      updateMemberRole: (...a: unknown[]) => updateMemberRole(...a),
      removeMember: (...a: unknown[]) => removeMember(...a),
      cancelInvitation: (...a: unknown[]) => cancelInvitation(...a),
    },
  },
}));

const getAuthSession = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
}));

const userCanManageOrganization = vi.fn();
const userCanManageOrganizationMembers = vi.fn();
vi.mock("@/lib/authz/organization-manage-gate", () => ({
  userCanManageOrganization: (...a: unknown[]) => userCanManageOrganization(...a),
  userCanManageOrganizationMembers: (...a: unknown[]) => userCanManageOrganizationMembers(...a),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import {
  cancelOrganizationInvitationAction,
  removeOrganizationMemberAction,
  updateOrganizationMemberRoleAction,
  updateOrganizationSettingsAction,
} from "../organization-manage-actions";

const SESSION = { user: { id: "user_1" }, session: { activeOrganizationId: "active_org" } };
const ORG = "org_viewed";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue(SESSION);
  userCanManageOrganization.mockResolvedValue(true);
  userCanManageOrganizationMembers.mockResolvedValue(true);
  updateOrganization.mockResolvedValue({});
  updateMemberRole.mockResolvedValue({});
  removeMember.mockResolvedValue({});
  cancelInvitation.mockResolvedValue({});
});

describe("updateOrganizationSettingsAction", () => {
  it("gated on organization.update; sends name + slug and revalidates", async () => {
    const result = await updateOrganizationSettingsAction(
      fd({ organizationId: ORG, name: "Acme", slug: "acme" }),
    );
    expect(result).toEqual({ ok: true });
    expect(userCanManageOrganization).toHaveBeenCalledWith(SESSION, ORG);
    expect(updateOrganization).toHaveBeenCalledWith({
      headers: expect.anything(),
      body: { organizationId: ORG, data: { name: "Acme", slug: "acme" } },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/organizations/${ORG}`);
  });

  it("omits slug from the payload when not provided (never nulls a slug)", async () => {
    await updateOrganizationSettingsAction(fd({ organizationId: ORG, name: "Acme" }));
    expect(updateOrganization).toHaveBeenCalledWith({
      headers: expect.anything(),
      body: { organizationId: ORG, data: { name: "Acme" } },
    });
  });

  it("FAILS CLOSED when the gate denies — no Better Auth call, no revalidate", async () => {
    userCanManageOrganization.mockResolvedValue(false);
    const result = await updateOrganizationSettingsAction(
      fd({ organizationId: ORG, name: "Acme", slug: "acme" }),
    );
    expect(result.ok).toBe(false);
    expect(updateOrganization).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when there is no session", async () => {
    getAuthSession.mockResolvedValue(null);
    const result = await updateOrganizationSettingsAction(fd({ organizationId: ORG, name: "Acme" }));
    expect(result.ok).toBe(false);
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  it("surfaces a Better Auth throw as { ok:false }", async () => {
    updateOrganization.mockRejectedValue(new Error("SLUG_IS_TAKEN"));
    const result = await updateOrganizationSettingsAction(
      fd({ organizationId: ORG, name: "Acme", slug: "taken" }),
    );
    expect(result).toEqual({ ok: false, error: "SLUG_IS_TAKEN" });
  });
});

describe("updateOrganizationMemberRoleAction", () => {
  it("gated on organization.manageMembers; sends memberId + role", async () => {
    const result = await updateOrganizationMemberRoleAction(
      fd({ organizationId: ORG, memberId: "mem_9", role: "admin" }),
    );
    expect(result).toEqual({ ok: true });
    expect(userCanManageOrganizationMembers).toHaveBeenCalledWith(SESSION, ORG);
    // Settings gate must NOT be what authorizes member ops.
    expect(userCanManageOrganization).not.toHaveBeenCalled();
    expect(updateMemberRole).toHaveBeenCalledWith({
      headers: expect.anything(),
      body: { organizationId: ORG, memberId: "mem_9", role: "admin" },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/organizations/${ORG}`);
  });

  it("rejects an invalid role", async () => {
    const result = await updateOrganizationMemberRoleAction(
      fd({ organizationId: ORG, memberId: "mem_9", role: "superuser" }),
    );
    expect(result.ok).toBe(false);
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED for an org_admin (manageMembers denied)", async () => {
    userCanManageOrganizationMembers.mockResolvedValue(false);
    const result = await updateOrganizationMemberRoleAction(
      fd({ organizationId: ORG, memberId: "mem_9", role: "admin" }),
    );
    expect(result.ok).toBe(false);
    expect(updateMemberRole).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("removeOrganizationMemberAction", () => {
  it("gated on manageMembers; passes memberIdOrEmail", async () => {
    const result = await removeOrganizationMemberAction(
      fd({ organizationId: ORG, memberId: "mem_9" }),
    );
    expect(result).toEqual({ ok: true });
    expect(removeMember).toHaveBeenCalledWith({
      headers: expect.anything(),
      body: { organizationId: ORG, memberIdOrEmail: "mem_9" },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/organizations/${ORG}`);
  });

  it("FAILS CLOSED when manageMembers denied", async () => {
    userCanManageOrganizationMembers.mockResolvedValue(false);
    const result = await removeOrganizationMemberAction(
      fd({ organizationId: ORG, memberId: "mem_9" }),
    );
    expect(result.ok).toBe(false);
    expect(removeMember).not.toHaveBeenCalled();
  });
});

describe("cancelOrganizationInvitationAction", () => {
  it("gated on manageMembers; cancels by invitationId", async () => {
    const result = await cancelOrganizationInvitationAction(
      fd({ organizationId: ORG, invitationId: "inv_3" }),
    );
    expect(result).toEqual({ ok: true });
    expect(cancelInvitation).toHaveBeenCalledWith({
      headers: expect.anything(),
      body: { invitationId: "inv_3" },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/organizations/${ORG}`);
  });

  it("FAILS CLOSED when manageMembers denied", async () => {
    userCanManageOrganizationMembers.mockResolvedValue(false);
    const result = await cancelOrganizationInvitationAction(
      fd({ organizationId: ORG, invitationId: "inv_3" }),
    );
    expect(result.ok).toBe(false);
    expect(cancelInvitation).not.toHaveBeenCalled();
  });
});
