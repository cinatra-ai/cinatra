/**
 * verifyA2AAccessToken extended ActorContext tests.
 *
 * Mocks `@/lib/service-accounts` (revocation + lookup) and `better-auth/client`
 * (signature/expiry verification) so the test runs without DB or live JWKS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() — referenced by the vi.mock factories below; vi.mock is
// hoisted to the top of the file so any closed-over const must be set up
// via vi.hoisted to be available before the factory runs.
//
// The verifier resolves the principal via
// `client_id ?? azp ?? sub` and looks the row up via
// `readServiceAccountByClientId` (clientId is the JWT identity claim;
// service_accounts.id is the row PK). The mock for the new helper is the
// load-bearing one for the test suite — the legacy `readServiceAccount`
// mock is retained only so unrelated callers do not break.
const {
  verifyAccessTokenMock,
  mockServiceAccount,
  readServiceAccountByClientIdMock,
} = vi.hoisted(() => {
  const acct = {
    id: "acct-test",
    name: "test",
    orgId: "org-test",
    clientId: "client-test",
    scopes: "run.read agent.execute",
    revokedAt: null as Date | null,
    rotatedAt: null as Date | null,
    previousClientId: null as string | null,
    gracePeriodSeconds: 900,
    createdBy: null as string | null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
  return {
    verifyAccessTokenMock: vi.fn(async () => undefined),
    mockServiceAccount: acct,
    readServiceAccountByClientIdMock: vi.fn(async () => acct),
  };
});

vi.mock("@/lib/service-accounts", () => ({
  readServiceAccount: vi.fn(async () => mockServiceAccount),
  readServiceAccountByClientId: readServiceAccountByClientIdMock,
}));

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    verifyAccessToken: verifyAccessTokenMock,
  }),
}));

vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({}),
}));

import { verifyA2AAccessToken } from "@/lib/a2a-auth";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "fake-sig";
  return `${header}.${body}.${sig}`;
}

function makeRequest(jwt: string): Request {
  return new Request("https://example.com/api/a2a", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

describe("verifyA2AAccessToken", () => {
  beforeEach(() => {
    verifyAccessTokenMock.mockReset();
    verifyAccessTokenMock.mockResolvedValue(undefined);
    readServiceAccountByClientIdMock.mockReset();
    // Reset the mock account back to active state after every test
    mockServiceAccount.revokedAt = null;
    readServiceAccountByClientIdMock.mockResolvedValue({ ...mockServiceAccount });
  });

  it("returns ok:true with ActorContext for valid signed token + active service account", async () => {
    // Better Auth client_credentials JWTs carry `azp = clientId`
    // and have no `sub`. The verifier resolves principal via
    // `client_id ?? azp ?? sub`, so a token built with azp must succeed.
    const jwt = makeJwt({
      azp: "client-test",
      org_id: "org-test",
      scope: "run.read agent.execute",
    });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(true);
    if (result.ok && result.actorContext) {
      expect(result.actorContext.principalType).toBe("ServiceAccount");
      expect(result.actorContext.authSource).toBe("a2a");
      // organizationId comes from the service_accounts row, NOT the JWT.
      expect(result.actorContext.organizationId).toBe("org-test");
      // principalId is the stable row PK (account.id), not the
      // JWT's clientId (which rotates).
      expect(result.actorContext.principalId).toBe("acct-test");
      expect(result.actorContext.tokenScopes).toContain("run.read");
      expect(result.actorContext.tokenScopes).toContain("agent.execute");
      // Row lookup is via clientId (the JWT identity claim).
      expect(readServiceAccountByClientIdMock).toHaveBeenCalledWith("client-test");
    } else {
      throw new Error("expected actorContext on success result");
    }
  });

  it("also accepts client_id claim (introspection shape) and falls back to sub", async () => {
    // Precedence order: client_id > azp > sub.
    const jwtWithClientId = makeJwt({
      client_id: "client-test",
      scope: "run.read",
    });
    const r1 = await verifyA2AAccessToken(makeRequest(jwtWithClientId));
    expect(r1.ok).toBe(true);

    const jwtWithSubFallback = makeJwt({
      sub: "client-test",
      scope: "run.read",
    });
    const r2 = await verifyA2AAccessToken(makeRequest(jwtWithSubFallback));
    expect(r2.ok).toBe(true);
  });

  it("returns ok:false (401) for revoked service account", async () => {
    readServiceAccountByClientIdMock.mockResolvedValueOnce({
      ...mockServiceAccount,
      revokedAt: new Date(),
    });
    const jwt = makeJwt({ azp: "client-test" });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns ok:false (401) when service account row not found", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readServiceAccountByClientIdMock.mockResolvedValueOnce(null as any);
    const jwt = makeJwt({ azp: "client-missing" });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns ok:false (401) when verifyAccessToken throws (expired/invalid signature)", async () => {
    verifyAccessTokenMock.mockRejectedValue(new Error("expired"));
    const jwt = makeJwt({ azp: "client-test" });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("normalizes empty/missing scope claim to undefined tokenScopes", async () => {
    const jwt = makeJwt({ azp: "client-test", org_id: "org-test" });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(true);
    if (result.ok && result.actorContext) {
      expect(result.actorContext.tokenScopes).toBeUndefined();
    } else {
      throw new Error("expected actorContext on success result");
    }
  });

  it("filters unknown scope strings out of tokenScopes", async () => {
    const jwt = makeJwt({
      azp: "client-test",
      org_id: "org-test",
      scope: "run.read unknown.foo agent.execute",
    });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(true);
    if (result.ok && result.actorContext) {
      expect(result.actorContext.tokenScopes).toEqual(
        expect.arrayContaining(["run.read", "agent.execute"]),
      );
      expect(result.actorContext.tokenScopes).not.toContain("unknown.foo");
    } else {
      throw new Error("expected actorContext on success result");
    }
  });

  it("propagates delegated_by claim onto ActorContext.delegatedBy", async () => {
    const jwt = makeJwt({
      azp: "client-test",
      org_id: "org-test",
      delegated_by: "user-123",
    });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(true);
    if (result.ok && result.actorContext) {
      expect(result.actorContext.delegatedBy).toBe("user-123");
    } else {
      throw new Error("expected actorContext on success result");
    }
  });

  it("tokenScopes is jwtScopes ∩ account.scopes (intersection enforced)", async () => {
    // Account ceiling = "run.read agent.execute" (mockServiceAccount.scopes).
    // JWT requests "run.read run.list mcp:connect" — only run.read is in
    // both sets, so effectiveScopes = ["run.read"].
    const jwt = makeJwt({
      azp: "client-test",
      scope: "run.read run.list mcp:connect",
    });
    const result = await verifyA2AAccessToken(makeRequest(jwt));
    expect(result.ok).toBe(true);
    if (result.ok && result.actorContext) {
      expect(result.actorContext.tokenScopes).toEqual(["run.read"]);
    } else {
      throw new Error("expected actorContext on success result");
    }
  });
});
