import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The guard composes four real pieces (session resolve, platform-admin check,
// org-role resolve, dev-admin bypass). We mock the SESSION + ROLE sources and
// run the REAL `grantDevAdminBypassForRequest` policy so the local-operator
// bypass path is exercised end-to-end, not stubbed — including its refusal of
// a request that merely CLAIMS to be local in its headers.

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
import { DEV_LOCAL_TOKEN_HEADER } from "@cinatra-ai/mcp-server/dev-admin-bypass";
import {
  mintDevLocalToken,
  resetDevLocalTokenForTest,
} from "@cinatra-ai/mcp-server/dev-local-token";
import { runWithLocalConnection } from "@cinatra-ai/mcp-server/local-connection";

let tokenDir: string;
let bootToken: string;

/**
 * Run the guard as the LOCAL OPERATOR would reach it: over a loopback socket
 * peer. The peer comes from the runtime's connection info, never a header, so
 * a test that wants the bypass has to stand in that position deliberately.
 */
function asLocalOperator<T>(fn: () => Promise<T>): Promise<T> {
  return runWithLocalConnection(
    { remoteAddress: "127.0.0.1", forwardedHeaderPresent: false },
    fn,
  );
}

function fakeHeaders(map: Record<string, string> = {}) {
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
  };
}

function req(url = "https://instance.cinatra.ai/api/cli/status"): Request {
  return new Request(url, { method: "GET" });
}

describe("authorizeCliRequest", () => {
  beforeAll(() => {
    tokenDir = mkdtempSync(path.join(tmpdir(), "cinatra-cli-guard-"));
    resetDevLocalTokenForTest();
    bootToken = mintDevLocalToken({
      NODE_ENV: "development",
      CINATRA_MCP_DEV_ADMIN_BYPASS: "true",
      CINATRA_DATA_DIR: tokenDir,
    } as NodeJS.ProcessEnv) as string;
  });

  afterAll(() => {
    rmSync(tokenDir, { recursive: true, force: true });
    resetDevLocalTokenForTest();
  });

  beforeEach(() => {
    getSessionMock.mockReset();
    resolveOrgRoleMock.mockReset();
    resolveCliBearerActorMock.mockReset();
    resolveCliBearerActorMock.mockResolvedValue(null);
    headersMock.mockReset();
    headersMock.mockResolvedValue(fakeHeaders());
    // Default: no bypass.
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CINATRA_DATA_DIR", tokenDir);
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

  it("grants the local operator: loopback socket peer + this boot's credential", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({ [DEV_LOCAL_TOKEN_HEADER]: bootToken }),
    );
    const result = await asLocalOperator(() =>
      authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.via).toBe("dev-admin-bypass");
      expect(result.actor.userId).toBeNull();
      expect(result.actor.isPlatformAdmin).toBe(true);
    }
  });

  // THE DEFECT. A caller anywhere can write `Host: localhost` and the
  // development server synthesises the forwarded chain from it. Neither the
  // URL nor a header is read any more, so this request is refused.
  it("REFUSES a request that only CLAIMS to be local in its headers", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({
        host: "localhost",
        "x-forwarded-host": "localhost",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "http",
      }),
    );
    const result = await authorizeCliRequest(
      req("http://localhost:3000/api/cli/status"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("REFUSES a loopback socket peer with no credential, and with a wrong one", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    const noCredential = await asLocalOperator(() =>
      authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(noCredential.ok).toBe(false);
    headersMock.mockResolvedValue(
      fakeHeaders({ [DEV_LOCAL_TOKEN_HEADER]: "b".repeat(64) }),
    );
    const wrongCredential = await asLocalOperator(() =>
      authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(wrongCredential.ok).toBe(false);
  });

  it("REFUSES the credential over a REMOTE socket peer", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({ [DEV_LOCAL_TOKEN_HEADER]: bootToken }),
    );
    const result = await runWithLocalConnection(
      { remoteAddress: "203.0.113.7", forwardedHeaderPresent: false },
      () => authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(result.ok).toBe(false);
  });

  // The forwarded-header refusal is keyed on what arrived AT INGRESS, because
  // the development server synthesises the chain on the way into a handler —
  // reading it off the handler's own headers would refuse the local operator on
  // every real boot. So the hop is stated on the connection, where it is true.
  it("REFUSES a credentialed local operator whose CONNECTION carried a forwarded header", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "forwarded",
    ]) {
      headersMock.mockResolvedValue(
        fakeHeaders({
          [DEV_LOCAL_TOKEN_HEADER]: bootToken,
          [name]: "127.0.0.1",
        }),
      );
      const result = await runWithLocalConnection(
        { remoteAddress: "127.0.0.1", forwardedHeaderPresent: true },
        () => authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
      );
      expect(result.ok).toBe(false);
    }
  });

  // The other half of that rule, and the one a real dev boot depends on: the
  // framework's OWN synthesised chain is on every handler's headers, and it
  // must not be read as a proxy hop the caller made.
  it("GRANTS the local operator whose handler headers carry the framework's synthesised chain", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({
        [DEV_LOCAL_TOKEN_HEADER]: bootToken,
        host: "localhost:3000",
        "x-forwarded-host": "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "http",
      }),
    );
    const result = await asLocalOperator(() =>
      authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.via).toBe("dev-admin-bypass");
      expect(result.actor.userId).toBeNull();
    }
  });

  it("does NOT grant the bypass in production even for the local operator", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({ [DEV_LOCAL_TOKEN_HEADER]: bootToken }),
    );
    const result = await asLocalOperator(() =>
      authorizeCliRequest(req("http://localhost:3000/api/cli/status")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("does NOT grant the bypass for a non-loopback request", async () => {
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

  it("the local-operator dev-admin bypass still satisfies the platform-admin tier", async () => {
    getSessionMock.mockResolvedValue(null);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CINATRA_MCP_DEV_ADMIN_BYPASS", "true");
    headersMock.mockResolvedValue(
      fakeHeaders({ [DEV_LOCAL_TOKEN_HEADER]: bootToken }),
    );
    const result = await asLocalOperator(() =>
      authorizeCliRequest(
        req("http://localhost:3000/api/cli/agents/export?query=x"),
        { minTier: "platform-admin" },
      ),
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
