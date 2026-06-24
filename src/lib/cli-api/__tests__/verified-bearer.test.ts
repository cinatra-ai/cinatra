/**
 * resolveCliBearerActor — verified remote-Bearer actor resolver tests
 * (eng#231). Mocks `better-auth/client` (JWKS signature/aud/iss verification),
 * `@/lib/auth-session` (live user/org role resolve), and
 * `@/lib/service-accounts` (service-account row lookup) so the test runs with
 * no DB / live JWKS.
 *
 * The verifier is fail-closed: a valid CLI-audience JWT carrying the EXACT
 * required scope and resolving to a real platform-admin ⇒ actor; everything
 * else ⇒ null. Audience is pinned to `<origin>/api/cli` — an `/api/mcp` token
 * is rejected. Grant-type branching is explicit: a client_credentials token
 * (client_id/azp) never falls into the user `sub` arm and carries NO platform
 * role.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CLI_AUD = "http://localhost:3000/api/cli";
const MCP_AUD = "http://localhost:3000/api/mcp";

const {
  verifyAccessTokenMock,
  resolveUserContextMock,
  resolveOrgRoleMock,
  readServiceAccountByClientIdMock,
} = vi.hoisted(() => ({
  // Default: verify only succeeds when the requested audience is the CLI aud
  // (mirrors the real verifier rejecting an `/api/mcp` token at `/api/cli`).
  verifyAccessTokenMock: vi.fn(
    async (_token: string, opts: { verifyOptions: { audience: string } }) => {
      if (opts.verifyOptions.audience !== CLI_AUD) {
        throw new Error("audience mismatch");
      }
      return undefined;
    },
  ),
  resolveUserContextMock: vi.fn(async (_userId: string): Promise<unknown> => undefined),
  resolveOrgRoleMock: vi.fn(
    async (_orgId: string, _userId: string): Promise<unknown> => undefined,
  ),
  readServiceAccountByClientIdMock: vi.fn(
    async (_clientId: string): Promise<unknown> => null,
  ),
}));

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ verifyAccessToken: verifyAccessTokenMock }),
}));
vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({}),
}));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth-session", () => ({
  resolveUserContextForUserId: (userId: string) =>
    resolveUserContextMock(userId),
  resolveOrgRoleForUser: (orgId: string, userId: string) =>
    resolveOrgRoleMock(orgId, userId),
}));
vi.mock("@/lib/service-accounts", () => ({
  readServiceAccountByClientId: (clientId: string) =>
    readServiceAccountByClientIdMock(clientId),
}));

import {
  resolveCliBearerActor,
  type CliScope,
} from "@/lib/cli-api/verified-bearer";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-sig`;
}

function req(authorization?: string): Request {
  return new Request("https://example.com/api/cli/status", {
    headers: authorization ? { authorization } : {},
  });
}

function bearerReq(payload: Record<string, unknown>): Request {
  return req(`Bearer ${makeJwt(payload)}`);
}

const PLATFORM_ADMIN_CTX = {
  actorContext: {} as never,
  platformRole: "platform_admin" as const,
  sessionOrgId: "org-1",
};

describe("resolveCliBearerActor", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    verifyAccessTokenMock.mockReset();
    verifyAccessTokenMock.mockImplementation(
      async (_t: string, opts: { verifyOptions: { audience: string } }) => {
        if (opts.verifyOptions.audience !== CLI_AUD) {
          throw new Error("audience mismatch");
        }
        return undefined;
      },
    );
    resolveUserContextMock.mockReset();
    resolveUserContextMock.mockResolvedValue(PLATFORM_ADMIN_CTX);
    resolveOrgRoleMock.mockReset();
    resolveOrgRoleMock.mockResolvedValue(undefined);
    readServiceAccountByClientIdMock.mockReset();
  });

  it("resolves a valid CLI-audience authorization_code token + correct scope to a platform-admin actor", async () => {
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", scope: "openid cli:status" }),
      "cli:status",
    );
    expect(actor).not.toBeNull();
    expect(actor?.userId).toBe("user-1");
    expect(actor?.isPlatformAdmin).toBe(true);
    expect(actor?.via).toBe("bearer");
    expect(actor?.organizationId).toBe("org-1");
  });

  it("rejects an /api/mcp-audience token (audience confusion) ⇒ null", async () => {
    // verifyAccessToken throws for any audience != CLI_AUD, so an mcp token
    // (issued with aud=/api/mcp) never verifies at /api/cli.
    verifyAccessTokenMock.mockImplementation(
      async (_t: string, opts: { verifyOptions: { audience: string } }) => {
        // Simulate a token that ONLY verifies against the MCP audience.
        if (opts.verifyOptions.audience !== MCP_AUD) {
          throw new Error("audience mismatch");
        }
        return undefined;
      },
    );
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", scope: "cli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("rejects an opaque / unverifiable token ⇒ null", async () => {
    verifyAccessTokenMock.mockRejectedValue(new Error("opaque"));
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", scope: "cli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("rejects a token missing the EXACT required scope ⇒ null (no any-cli:* fallback)", async () => {
    // Carries cli:agent:read but the endpoint demands cli:status.
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", scope: "openid cli:agent:read" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("does not substring-match scopes (exact token match only)", async () => {
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", scope: "cli:status:extra xcli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("rejects a non-Bearer / missing Authorization header ⇒ null", async () => {
    expect(await resolveCliBearerActor(req(), "cli:status")).toBeNull();
    expect(
      await resolveCliBearerActor(req("Basic abc"), "cli:status"),
    ).toBeNull();
    expect(
      await resolveCliBearerActor(req("Bearer "), "cli:status"),
    ).toBeNull();
  });

  it("authorization_code subject with no user row ⇒ fail closed (null)", async () => {
    resolveUserContextMock.mockRejectedValue(new Error("user not found"));
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "ghost", scope: "cli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("resolves a non-admin authorization_code subject (isPlatformAdmin=false) — the route tier then denies", async () => {
    resolveUserContextMock.mockResolvedValue({
      actorContext: {} as never,
      platformRole: "member",
      sessionOrgId: "org-2",
    });
    resolveOrgRoleMock.mockResolvedValue("org_admin");
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-2", scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor).not.toBeNull();
    expect(actor?.isPlatformAdmin).toBe(false);
    expect(actor?.orgRole).toBe("org_admin");
  });

  // ---- client_credentials arm (explicit grant-type branching) ------------

  it("client_credentials token with a valid service_accounts row resolves to created_by but NO platform role", async () => {
    readServiceAccountByClientIdMock.mockResolvedValue({
      id: "acct-1",
      clientId: "cc-client",
      orgId: "org-3",
      createdBy: "creator-1",
      revokedAt: null,
      scopes: "cli:agent:read",
    });
    const actor = await resolveCliBearerActor(
      bearerReq({ client_id: "cc-client", scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor).not.toBeNull();
    expect(actor?.userId).toBe("creator-1");
    // D7: a client_credentials token NEVER carries a platform role.
    expect(actor?.isPlatformAdmin).toBe(false);
    // It must NOT have gone through the user `sub` arm.
    expect(resolveUserContextMock).not.toHaveBeenCalled();
  });

  it("client_credentials token with NO service_accounts row ⇒ fail closed (null)", async () => {
    readServiceAccountByClientIdMock.mockResolvedValue(null);
    const actor = await resolveCliBearerActor(
      bearerReq({ azp: "unknown-client", scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor).toBeNull();
  });

  it("client_credentials token with a REVOKED service account ⇒ fail closed (null)", async () => {
    readServiceAccountByClientIdMock.mockResolvedValue({
      id: "acct-1",
      clientId: "cc-client",
      orgId: "org-3",
      createdBy: "creator-1",
      revokedAt: new Date("2026-01-01"),
      scopes: "cli:agent:read",
    });
    const actor = await resolveCliBearerActor(
      bearerReq({ client_id: "cc-client", scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor).toBeNull();
  });

  it("a client_credentials token (client_id present) is NEVER routed through the user sub arm even if it carries a sub", async () => {
    readServiceAccountByClientIdMock.mockResolvedValue({
      id: "acct-1",
      clientId: "cc-client",
      orgId: "org-3",
      createdBy: "creator-1",
      revokedAt: null,
      scopes: "cli:agent:read",
    });
    const actor = await resolveCliBearerActor(
      // A token carrying BOTH client_id and a sub must use the cc arm.
      bearerReq({ client_id: "cc-client", sub: "user-1", scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor?.userId).toBe("creator-1");
    expect(actor?.isPlatformAdmin).toBe(false);
    expect(resolveUserContextMock).not.toHaveBeenCalled();
  });

  it("a malformed (non-JWT) token that somehow verifies ⇒ fail closed (null)", async () => {
    // verifyAccessToken resolves, but the body is not decodable as a 3-part JWT.
    verifyAccessTokenMock.mockResolvedValue(undefined);
    const actor = await resolveCliBearerActor(
      req("Bearer not-a-jwt"),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("rejects every required scope variant when absent", async () => {
    const scopes: CliScope[] = ["cli:status", "cli:agent:read", "cli:agent:write"];
    for (const required of scopes) {
      const actor = await resolveCliBearerActor(
        bearerReq({ sub: "user-1", scope: "openid profile" }),
        required,
      );
      expect(actor).toBeNull();
    }
  });
});
