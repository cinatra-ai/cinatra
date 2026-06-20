import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guard composes four real pieces (session resolve, platform-admin check,
// org-role resolve, dev-admin bypass). We mock the SESSION + ROLE sources and
// run the REAL `isTrustedDevHost` / `shouldGrantDevAdminBypass` policy so the
// loopback bypass path is exercised end-to-end, not stubbed.

const getSessionMock = vi.fn();
const resolveOrgRoleMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionMock(...args) } },
}));

vi.mock("@/lib/auth-session", async () => {
  // Keep the REAL isPlatformAdmin (pure) + mock the DB-backed org-role lookup.
  const actual = await vi.importActual<typeof import("@/lib/auth-session")>(
    "@/lib/auth-session",
  );
  return {
    isPlatformAdmin: actual.isPlatformAdmin,
    resolveOrgRoleForUser: (...args: unknown[]) => resolveOrgRoleMock(...args),
  };
});

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

import { authorizeCliRequest } from "../route-guard";

function fakeHeaders(map: Record<string, string> = {}) {
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
  };
}

function req(url = "https://instance.cinatra.ai/api/cli/status"): Request {
  return new Request(url, { method: "GET" });
}

describe("authorizeCliRequest", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    resolveOrgRoleMock.mockReset();
    headersMock.mockReset();
    headersMock.mockResolvedValue(fakeHeaders());
    // Default: no bypass.
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "");
    vi.stubEnv("CINATRA_MCP_DEV_TRUSTED_HOSTS", "");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("401s when no session and no bypass", async () => {
    getSessionMock.mockResolvedValue(null);
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("authorizes a platform admin session", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u1", role: "admin" },
      session: { activeOrganizationId: null },
    });
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.userId).toBe("u1");
      expect(result.actor.isPlatformAdmin).toBe(true);
      expect(result.actor.via).toBe("session");
    }
  });

  it("authorizes an org_owner session", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u2", role: "user" },
      session: { activeOrganizationId: "org1" },
    });
    resolveOrgRoleMock.mockResolvedValue("org_owner");
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actor.orgRole).toBe("org_owner");
  });

  it("authorizes an org_admin session", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u3", role: "user" },
      session: { activeOrganizationId: "org1" },
    });
    resolveOrgRoleMock.mockResolvedValue("org_admin");
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(true);
  });

  it("403s an authenticated but under-privileged member", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u4", role: "user" },
      session: { activeOrganizationId: "org1" },
    });
    resolveOrgRoleMock.mockResolvedValue("member");
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("403s an authenticated user with no resolvable org role", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u5", role: "user" },
      session: { activeOrganizationId: null },
    });
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("grants the dev-admin loopback bypass when all three guards pass", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    const result = await authorizeCliRequest(
      req("http://localhost:3000/api/cli/status"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.via).toBe("dev-admin-bypass");
      expect(result.actor.userId).toBeNull();
      expect(result.actor.isPlatformAdmin).toBe(true);
    }
  });

  it("does NOT grant the bypass in production even on loopback", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    const result = await authorizeCliRequest(
      req("http://localhost:3000/api/cli/status"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("does NOT grant the bypass for a non-loopback host", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    const result = await authorizeCliRequest(
      req("https://public.example.com/api/cli/status"),
    );
    expect(result.ok).toBe(false);
  });

  it("403s an org_admin when the endpoint requires platform-admin tier", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u6", role: "user" },
      session: { activeOrganizationId: "org1" },
    });
    resolveOrgRoleMock.mockResolvedValue("org_admin");
    const result = await authorizeCliRequest(req(), {
      minTier: "platform-admin",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("authorizes a platform_admin under the platform-admin tier", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u7", role: "admin" },
      session: { activeOrganizationId: "org1" },
    });
    const result = await authorizeCliRequest(req(), {
      minTier: "platform-admin",
    });
    expect(result.ok).toBe(true);
  });

  it("the loopback dev-admin bypass still satisfies the platform-admin tier", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    const result = await authorizeCliRequest(
      req("http://localhost:3000/api/cli/agents/export?query=x"),
      { minTier: "platform-admin" },
    );
    expect(result.ok).toBe(true);
  });

  it("fails closed on an unresolved Authorization header (no false-accept)", async () => {
    // A bogus Bearer that getSession does not resolve must NOT authorize.
    // Remote OAuth Bearer resolution is out of scope for this guard (lands with
    // `cinatra login`); until then such a token fails closed to 401.
    getSessionMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      fakeHeaders({ authorization: "Bearer not.a.real.token" }),
    );
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
