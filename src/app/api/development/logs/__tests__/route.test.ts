import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for DELETE /api/development/logs.
// Purging provider logs is a destructive, platform-wide action; it previously
// ran behind cookie-existence only. This test pins the in-handler gate: a
// validated session AND platform admin, and NO purge on denial.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const clearAllProviderLogEntries = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/logging", () => ({
  clearAllProviderLogEntries: () => clearAllProviderLogEntries(),
}));

import { DELETE } from "../route";

describe("DELETE /api/development/logs", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    clearAllProviderLogEntries.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never purges", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await DELETE();
    expect(res.status).toBe(401);
    expect(clearAllProviderLogEntries).not.toHaveBeenCalled();
  });

  it("403s a non-admin authenticated caller and never purges", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    isPlatformAdmin.mockReturnValue(false);
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(clearAllProviderLogEntries).not.toHaveBeenCalled();
  });

  it("purges for a platform admin", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "admin-1" } });
    isPlatformAdmin.mockReturnValue(true);
    const res = await DELETE();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(clearAllProviderLogEntries).toHaveBeenCalledTimes(1);
  });
});
