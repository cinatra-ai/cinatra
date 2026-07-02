import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for POST /api/wizard/[type]/[id]/activate.
// Activation promotes a staged resource to a real one — a privileged mutation
// that previously relied solely on the cookie-existence middleware. This test
// pins the in-handler gate: a validated session AND platform admin; a denied
// caller never reaches handler.activate.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const getConfigHandler = vi.fn();
const isStagedResource = vi.fn();
const getMergedStagedConfig = vi.fn();
const removeStagedResource = vi.fn();
const activate = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/wizard-config-handler-campaign", () => ({}));
vi.mock("@/lib/wizard-config-handlers", () => ({
  getConfigHandler: (t: string) => getConfigHandler(t),
}));
vi.mock("@/lib/wizard-staging-store", () => ({
  isStagedResource: (t: string, i: string) => isStagedResource(t, i),
  getMergedStagedConfig: (t: string, i: string) => getMergedStagedConfig(t, i),
  removeStagedResource: (t: string, i: string) => removeStagedResource(t, i),
}));

import { POST } from "../route";

function params(resourceType: string, resourceId: string) {
  return { params: Promise.resolve({ resourceType, resourceId }) };
}
function req() {
  return new Request("https://app.test/api/wizard/campaign/c1/activate", { method: "POST" });
}

describe("POST /api/wizard/[resourceType]/[resourceId]/activate", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    isStagedResource.mockReturnValue(true);
    getMergedStagedConfig.mockReturnValue({ some: "config" });
    getConfigHandler.mockReturnValue({ activate });
    activate.mockResolvedValue("real-id-1");
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never activates", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(req(), params("campaign", "c1"));
    expect(res.status).toBe(401);
    expect(activate).not.toHaveBeenCalled();
  });

  it("403s a non-admin authenticated caller and never activates", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    isPlatformAdmin.mockReturnValue(false);
    const res = await POST(req(), params("campaign", "c1"));
    expect(res.status).toBe(403);
    expect(activate).not.toHaveBeenCalled();
    expect(removeStagedResource).not.toHaveBeenCalled();
  });

  it("404s when no staged resource exists (admin)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "admin-1" } });
    isPlatformAdmin.mockReturnValue(true);
    isStagedResource.mockReturnValue(false);
    const res = await POST(req(), params("campaign", "c1"));
    expect(res.status).toBe(404);
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates for a platform admin with a staged resource", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "admin-1" } });
    isPlatformAdmin.mockReturnValue(true);
    const res = await POST(req(), params("campaign", "c1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, resourceId: "real-id-1" });
    expect(activate).toHaveBeenCalledWith("c1", { some: "config" });
    expect(removeStagedResource).toHaveBeenCalledWith("campaign", "c1");
  });
});
