// cinatra#274 — saveWordPressInstanceAction persists the configuring admin's
// {orgId, runBy} install→org binding captured from the session.
//
// Asserts the action:
//   - requires an admin session (identity capture also enforces the gate),
//   - threads session.session.activeOrganizationId → orgId and session.user.id →
//     runBy into saveWordPressInstance.

import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminSession = vi.fn();
const saveWordPressInstance = vi.fn().mockResolvedValue({ id: "wp-1" });
const redirect = vi.fn((url: string) => {
  // next/navigation redirect throws a control-flow signal in real Next; here we
  // just record the destination so the action body runs to the redirect line.
  throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
});

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: () => requireAdminSession(),
  // Other named exports the module re-exports; not used by this action.
  requireAuthSession: vi.fn(),
}));

vi.mock("@/lib/wordpress-api", () => ({
  saveWordPressInstance: (...a: unknown[]) => saveWordPressInstance(...a),
  listWordPressInstances: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

beforeEach(() => {
  vi.clearAllMocks();
  saveWordPressInstance.mockResolvedValue({ id: "wp-1" });
  redirect.mockImplementation((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { __redirectTo: url });
  });
});

describe("saveWordPressInstanceAction — install→org binding capture (cinatra#274)", () => {
  it("captures the admin session's org/user and passes them into saveWordPressInstance", async () => {
    requireAdminSession.mockResolvedValue({
      user: { id: "u_admin_42" },
      session: { activeOrganizationId: "org_42" },
    });

    const { saveWordPressInstanceAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("siteUrl", "https://tenant-42.example");
    form.set("username", "operator");
    form.set("applicationPassword", "app-password");

    await expect(saveWordPressInstanceAction(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(requireAdminSession).toHaveBeenCalledTimes(1);
    expect(saveWordPressInstance).toHaveBeenCalledTimes(1);
    const arg = saveWordPressInstance.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.orgId).toBe("org_42");
    expect(arg.runBy).toBe("u_admin_42");
    expect(arg.siteUrl).toBe("https://tenant-42.example");
  });

  it("passes orgId undefined when the session has no active organization (still saves)", async () => {
    requireAdminSession.mockResolvedValue({
      user: { id: "u_admin_42" },
      session: { activeOrganizationId: null },
    });

    const { saveWordPressInstanceAction } = await import("@/app/campaigns/actions");

    const form = new FormData();
    form.set("siteUrl", "https://tenant-42.example");
    form.set("username", "operator");
    form.set("applicationPassword", "app-password");

    await expect(saveWordPressInstanceAction(form)).rejects.toThrow("NEXT_REDIRECT");

    const arg = saveWordPressInstance.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.orgId).toBeUndefined();
    expect(arg.runBy).toBe("u_admin_42");
  });
});
