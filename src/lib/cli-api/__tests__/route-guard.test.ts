import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guard composes four real pieces (session resolve, platform-admin check,
// org-role resolve, dev-admin bypass). We mock the SESSION + ROLE sources and
// run the REAL `isTrustedDevHost` / `shouldGrantDevAdminBypass` policy so the
// loopback bypass path is exercised end-to-end, not stubbed.

const getSessionMock = vi.fn();
const resolveOrgRoleMock = vi.fn();
// The verified-Bearer resolver is unit-tested separately (verified-bearer.test).
// Here we mock it to drive the guard's wiring: order (session → bearer →
// bypass → deny), the per-route requiredScope gate, and that the resolved
// actor still clears the SAME minTier role gate.
const resolveCliBearerActorMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSessionMock(...args) } },
}));

vi.mock("@/lib/cli-api/verified-bearer", () => ({
  resolveCliBearerActor: (...args: unknown[]) =>
    resolveCliBearerActorMock(...args),
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
    resolveCliBearerActorMock.mockReset();
    resolveCliBearerActorMock.mockResolvedValue(null);
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
    // A bogus Bearer the resolver does not resolve must NOT authorize. With no
    // requiredScope the Bearer arm is skipped entirely; even with one, a null
    // resolver result fails closed to 401.
    getSessionMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      fakeHeaders({ authorization: "Bearer not.a.real.token" }),
    );
    const result = await authorizeCliRequest(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  // ---- CLI Class-A: verified remote-Bearer arm -------------------------

  describe("verified remote Bearer", () => {
    it("does NOT invoke the Bearer arm when the endpoint declares no requiredScope", async () => {
      getSessionMock.mockResolvedValue(null);
      const result = await authorizeCliRequest(req()); // no requiredScope
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(401);
      // The Bearer resolver must never be consulted without a requiredScope.
      expect(resolveCliBearerActorMock).not.toHaveBeenCalled();
    });

    it("authorizes a platform-admin Bearer when scope + audience + tier all hold", async () => {
      getSessionMock.mockResolvedValue(null);
      resolveCliBearerActorMock.mockResolvedValue({
        userId: "u-bearer",
        isPlatformAdmin: true,
        organizationId: "org1",
        via: "bearer",
      });
      const result = await authorizeCliRequest(req(), {
        minTier: "platform-admin",
        requiredScope: "cli:status",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.actor.via).toBe("bearer");
        expect(result.actor.userId).toBe("u-bearer");
      }
      expect(resolveCliBearerActorMock).toHaveBeenCalledWith(
        expect.anything(),
        "cli:status",
      );
    });

    it("403s a Bearer actor that resolves below the platform-admin tier (role gate still applies)", async () => {
      getSessionMock.mockResolvedValue(null);
      // e.g. a service-account / org-admin Bearer — resolved but NOT platform-admin.
      resolveCliBearerActorMock.mockResolvedValue({
        userId: "u-orgadmin",
        isPlatformAdmin: false,
        orgRole: "org_admin",
        organizationId: "org1",
        via: "bearer",
      });
      const result = await authorizeCliRequest(req(), {
        minTier: "platform-admin",
        requiredScope: "cli:agent:read",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(403);
    });

    it("a session takes precedence over the Bearer arm (session resolved first)", async () => {
      getSessionMock.mockResolvedValue({
        user: { id: "u-session", role: "admin" },
        session: { activeOrganizationId: null },
      });
      const result = await authorizeCliRequest(req(), {
        minTier: "platform-admin",
        requiredScope: "cli:status",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.actor.via).toBe("session");
      // Session won — the Bearer resolver was never consulted.
      expect(resolveCliBearerActorMock).not.toHaveBeenCalled();
    });

    it("PRODUCTION + no dev-bypass: a remote Bearer that does not resolve fails closed (401)", async () => {
      // Distrust-the-insecure-path: assert the production config keeps a remote
      // Bearer fail-closed unless the resolver proves aud+scope+role.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true"); // must NOT fire in prod
      getSessionMock.mockResolvedValue(null);
      resolveCliBearerActorMock.mockResolvedValue(null); // unverified
      const result = await authorizeCliRequest(
        req("https://public.example.com/api/cli/status"),
        { minTier: "platform-admin", requiredScope: "cli:status" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(401);
    });

    it("PRODUCTION: a verified platform-admin Bearer authorizes (the intended remote path)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      getSessionMock.mockResolvedValue(null);
      resolveCliBearerActorMock.mockResolvedValue({
        userId: "u-bearer",
        isPlatformAdmin: true,
        organizationId: "org1",
        via: "bearer",
      });
      const result = await authorizeCliRequest(
        req("https://public.example.com/api/cli/status"),
        { minTier: "platform-admin", requiredScope: "cli:status" },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.actor.via).toBe("bearer");
    });
  });
});
