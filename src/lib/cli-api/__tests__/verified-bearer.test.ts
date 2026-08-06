/**
 * resolveCliBearerActor — verified remote-Bearer actor resolver tests
 * (CLI Class-A remote Bearer). Mocks `better-auth/client` (JWKS signature/aud/iss verification),
 * `@/lib/auth-session` (live user/org role resolve), and
 * `@/lib/service-accounts` (service-account row lookup) so the test runs with
 * no DB / live JWKS.
 *
 * The verifier is fail-closed: a valid CLI-audience JWT carrying the EXACT
 * required scope and resolving to a real platform-admin ⇒ actor; everything
 * else ⇒ null. Audience is pinned to `<origin>/api/cli` — an `/api/mcp` token
 * is rejected.
 *
 * GRANT DISCRIMINATION (#2479) is keyed on `sub` PRESENCE, never `azp`: this
 * authorization server stamps `azp = client.clientId` on BOTH grants, so the
 * real interactive shape is `{ sub, azp, aud: [<cli>, <userinfo>] }` and the
 * real machine shape is `{ azp, no sub }`. The suite pins both, the
 * multi-audience-with-azp case measured live in cinatra-cli#204, and the
 * fail-closed verdict on an ambiguous shape.
 *
 * The `verifyAccessToken` mock decodes the token's OWN `aud` claim and accepts
 * only when the requested audience is among its values — so the
 * multi-audience cases exercise real audience membership rather than a
 * constant, and a token minted for a different audience genuinely fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CLI_AUD = "http://localhost:3000/api/cli";
const MCP_AUD = "http://localhost:3000/api/mcp";

/** The userinfo audience Better Auth appends whenever `openid` is requested. */
const USERINFO_AUD = "http://localhost:3000/api/auth/oauth2/userinfo";

/**
 * Stand-in for the real JWKS verifier's audience check (jose accepts when the
 * requested audience is a MEMBER of the token's `aud`). Reads the token's own
 * `aud` claim; a token that declares none is treated as CLI-audience so the
 * pre-existing cases stay unchanged.
 */
function tokenAcceptsAudience(token: string, requested: string): boolean {
  let aud: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return requested === CLI_AUD;
    aud = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.aud;
  } catch {
    return requested === CLI_AUD;
  }
  if (aud === undefined) return requested === CLI_AUD;
  return Array.isArray(aud) ? aud.includes(requested) : aud === requested;
}

const {
  verifyAccessTokenMock,
  resolveUserContextMock,
  resolveOrgRoleMock,
  readServiceAccountByClientIdMock,
} = vi.hoisted(() => ({
  // Placeholder — the real implementation is installed in `beforeEach` (it
  // needs `tokenAcceptsAudience`, which `vi.hoisted` cannot close over).
  verifyAccessTokenMock: vi.fn(
    async (
      _token: string,
      _opts: { verifyOptions: { audience: string } },
    ): Promise<undefined> => {
      throw new Error("audience mismatch");
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
  classifyCliTokenShape,
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
      async (t: string, opts: { verifyOptions: { audience: string } }) => {
        if (!tokenAcceptsAudience(t, opts.verifyOptions.audience)) {
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
    // A REAL mcp token: minted with aud=/api/mcp, so the /api/cli audience is
    // not among its values and the JWKS verify fails on every configured CLI
    // audience. Reciprocal isolation, exercised on the token's own claim.
    const actor = await resolveCliBearerActor(
      bearerReq({ sub: "user-1", aud: MCP_AUD, azp: "cli-dcr", scope: "cli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("rejects an mcp token even when it is multi-audience, as long as /api/cli is absent", async () => {
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "user-1",
        aud: [MCP_AUD, USERINFO_AUD],
        azp: "cli-dcr",
        scope: "cli:status",
      }),
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

  it("a client_credentials token (no sub) is NEVER routed through the user arm", async () => {
    readServiceAccountByClientIdMock.mockResolvedValue({
      id: "acct-1",
      clientId: "cc-client",
      orgId: "org-3",
      createdBy: "creator-1",
      revokedAt: null,
      scopes: "cli:agent:read",
    });
    // The REAL machine shape this AS mints: azp = the service account's
    // client id, `sub` absent (handleClientCredentialsGrant passes no user).
    const actor = await resolveCliBearerActor(
      bearerReq({ azp: "cc-client", aud: CLI_AUD, scope: "cli:agent:read" }),
      "cli:agent:read",
    );
    expect(actor?.userId).toBe("creator-1");
    expect(actor?.isPlatformAdmin).toBe(false);
    expect(resolveUserContextMock).not.toHaveBeenCalled();
    expect(readServiceAccountByClientIdMock).toHaveBeenCalledWith("cc-client");
  });

  // ---- #2479 — the interactive arm, and the fail-closed boundary ----------

  it("#2479 REGRESSION: the real interactive shape (multi-aud + azp, no client_id) takes the USER-DELEGATED arm", async () => {
    // The exact token measured live in cinatra-cli#204: an admin's real
    // `cinatra login` token — correct audience, correct scope, valid
    // signature — which the pre-fix `client_id ?? azp` discriminator routed
    // into the machine arm, found no service_accounts row for the DCR client,
    // and refused with 401.
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "user-1",
        aud: [CLI_AUD, USERINFO_AUD],
        azp: "nWZjSRfBtmGlvBuKCmdJmbkwtFCilKQf", // the DCR client id
        scope:
          "openid profile email offline_access mcp:connect cli:status " +
          "cli:agent:read cli:agent:write cli:extensions:read cli:extensions:write",
        sid: "session-1",
        jti: "a1b2c3",
      }),
      "cli:status",
    );
    expect(actor).not.toBeNull();
    expect(actor?.userId).toBe("user-1");
    expect(actor?.isPlatformAdmin).toBe(true);
    expect(actor?.organizationId).toBe("org-1");
    expect(actor?.via).toBe("bearer");
    // It must NOT have gone anywhere near the service-account lookup: an
    // interactive DCR client has no service_accounts row, and a lookup here
    // is the pre-fix defect itself.
    expect(readServiceAccountByClientIdMock).not.toHaveBeenCalled();
    expect(resolveUserContextMock).toHaveBeenCalledWith("user-1");
  });

  it("#2479: an interactive token still fails closed when its subject names no live user", async () => {
    resolveUserContextMock.mockRejectedValue(new Error("user not found"));
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "ghost",
        aud: [CLI_AUD, USERINFO_AUD],
        azp: "cli-dcr",
        scope: "cli:status",
      }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("#2479: an interactive token still needs the EXACT scope — azp does not excuse it", async () => {
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "user-1",
        aud: [CLI_AUD, USERINFO_AUD],
        azp: "cli-dcr",
        scope: "openid profile cli:agent:read",
      }),
      "cli:status",
    );
    expect(actor).toBeNull();
  });

  it("#2479 FAIL CLOSED: an ambiguous shape (sub AND an explicit client_id) is REJECTED, not routed", async () => {
    // Contradictory: a machine identity claim on a user-subject token. This AS
    // cannot mint it. Denying is strictly stronger than the pre-fix behavior,
    // which silently admitted it through the machine arm.
    readServiceAccountByClientIdMock.mockResolvedValue({
      id: "acct-1",
      clientId: "cc-client",
      orgId: "org-3",
      createdBy: "creator-1",
      revokedAt: null,
      scopes: "cli:agent:read",
    });
    const actor = await resolveCliBearerActor(
      bearerReq({
        client_id: "cc-client",
        sub: "user-1",
        aud: CLI_AUD,
        scope: "cli:agent:read",
      }),
      "cli:agent:read",
    );
    expect(actor).toBeNull();
    expect(resolveUserContextMock).not.toHaveBeenCalled();
    expect(readServiceAccountByClientIdMock).not.toHaveBeenCalled();
  });

  it("#2479 FAIL CLOSED: a token with NO identity claim at all (no sub, no azp, no client_id) is REJECTED", async () => {
    const actor = await resolveCliBearerActor(
      bearerReq({ aud: CLI_AUD, scope: "cli:status" }),
      "cli:status",
    );
    expect(actor).toBeNull();
    expect(resolveUserContextMock).not.toHaveBeenCalled();
    expect(readServiceAccountByClientIdMock).not.toHaveBeenCalled();
  });

  it("#2479 FAIL CLOSED: malformed identity claims do not satisfy either arm", async () => {
    for (const payload of [
      { sub: 12345, azp: "cli-dcr" }, // numeric sub → malformed
      { sub: "   ", azp: "   " }, // whitespace-only → malformed
      { sub: null, azp: null },
      { sub: { id: "user-1" }, azp: ["cli-dcr"] },
      { sub: "user-1", client_id: 42 }, // valid sub + malformed client_id
      { azp: " padded-client " }, // padded → never normalized into an identity
    ]) {
      const actor = await resolveCliBearerActor(
        bearerReq({ ...payload, aud: CLI_AUD, scope: "cli:status" }),
        "cli:status",
      );
      expect(actor).toBeNull();
    }
    expect(resolveUserContextMock).not.toHaveBeenCalled();
  });

  it("#2479 ESCALATION GUARD: a same-JWKS SESSION JWT (better-auth `jwt` plugin) is not a CLI credential", async () => {
    // Measured live on the lane stack: any signed-in user — including a
    // NON-admin — can mint a JWT at `GET /api/auth/token`. It is signed by the
    // SAME JWKS and carries a real-user `sub`, so once `sub` becomes the arm
    // discriminator this is the one realistic way the routing change could
    // have become an escalation. It is closed by the checks this diff does not
    // touch, and each one alone suffices:
    //   * `aud` is `<origin>`, not `<origin>/api/cli`;
    //   * `iss` is `<origin>`, not `<origin>/api/auth`;
    //   * there is no `scope` claim at all.
    // Live result: 401. Pinned here so a future audience/scope relaxation
    // cannot quietly turn every session into CLI control-plane authority.
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "user-1",
        aud: "http://localhost:3000", // the jwt plugin's default audience
        iss: "http://localhost:3000",
        role: "admin", // a role CLAIM must never authorize anything
        email: "member@example.com",
        // note: no `scope`, no `azp`
      }),
      "cli:status",
    );
    expect(actor).toBeNull();
    expect(resolveUserContextMock).not.toHaveBeenCalled();
  });

  it("#2479: a refresh_token-minted token (same user-delegated shape) takes the user arm too", async () => {
    // handleRefreshTokenGrant re-mints through the SAME createJwtAccessToken
    // path with the user row, so the shape is identical to the initial
    // interactive mint. cinatra-cli#204 proved the CLI refresh leg live.
    const actor = await resolveCliBearerActor(
      bearerReq({
        sub: "user-1",
        aud: [CLI_AUD, USERINFO_AUD],
        azp: "cli-dcr",
        scope: "openid offline_access cli:extensions:read",
        sid: "session-1",
      }),
      "cli:extensions:read",
    );
    expect(actor?.userId).toBe("user-1");
    expect(readServiceAccountByClientIdMock).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// classifyCliTokenShape — the pure routing contract (#2479).
//
// Direct unit coverage of the discriminator itself, so a future edit that
// re-introduces `client_id ?? azp` (or otherwise loosens the fail-closed
// bucket) reds a check without needing the whole resolver assembled.
// ---------------------------------------------------------------------------
describe("classifyCliTokenShape", () => {
  it("routes the REAL interactive mint (sub + azp, no client_id) to user-delegated", () => {
    expect(
      classifyCliTokenShape({ sub: "user-1", azp: "cli-dcr" }),
    ).toEqual({ arm: "user-delegated", subject: "user-1" });
  });

  it("routes the REAL client_credentials mint (azp, no sub) to machine-client", () => {
    expect(classifyCliTokenShape({ azp: "cc-client" })).toEqual({
      arm: "machine-client",
      clientIdentity: "cc-client",
    });
  });

  it("preserves the pre-#2479 machine lookup-key precedence (client_id over azp) when there is no sub", () => {
    expect(
      classifyCliTokenShape({ client_id: "explicit", azp: "fallback" }),
    ).toEqual({ arm: "machine-client", clientIdentity: "explicit" });
  });

  it("a sub with no azp at all is still user-delegated (azp is never load-bearing)", () => {
    expect(classifyCliTokenShape({ sub: "user-1" })).toEqual({
      arm: "user-delegated",
      subject: "user-1",
    });
  });

  it("ANTI-REGRESSION: azp alone never diverts a token that carries a sub", () => {
    // The exact defect: `payload.client_id ?? payload.azp` is truthy on EVERY
    // token this AS mints, so this input used to classify as machine.
    const shape = classifyCliTokenShape({ sub: "user-1", azp: "any-client" });
    expect(shape.arm).toBe("user-delegated");
    expect(shape.arm === "machine-client").toBe(false);
  });

  it("fails closed on an ambiguous or empty shape", () => {
    expect(classifyCliTokenShape({})).toEqual({ arm: "unknown" });
    expect(classifyCliTokenShape({ scope: "cli:status" })).toEqual({
      arm: "unknown",
    });
    expect(
      classifyCliTokenShape({ sub: "user-1", client_id: "cc-client" }),
    ).toEqual({ arm: "unknown" });
    expect(
      classifyCliTokenShape({ sub: "user-1", client_id: "cc", azp: "dcr" }),
    ).toEqual({ arm: "unknown" });
  });

  it("fails closed on a PRESENT-but-malformed identity claim (codex round 2)", () => {
    // Absent is legitimate; malformed is not. The classifier must not treat a
    // wrong-typed / empty / padded claim as though the key were missing, and
    // must not normalize it — either would route a shape this AS cannot mint.
    expect(classifyCliTokenShape({ sub: 1, azp: 2 })).toEqual({ arm: "unknown" });
    expect(classifyCliTokenShape({ sub: "", azp: "" })).toEqual({ arm: "unknown" });
    expect(classifyCliTokenShape({ sub: null, azp: "cc" })).toEqual({ arm: "unknown" });
    // padded — NOT trimmed into a usable identifier
    expect(classifyCliTokenShape({ azp: " cc " })).toEqual({ arm: "unknown" });
    expect(classifyCliTokenShape({ sub: " user-1 " })).toEqual({ arm: "unknown" });
    // a malformed client_id alongside a VALID sub must not fall through to the
    // user arm just because the bad claim "looks absent"
    expect(classifyCliTokenShape({ sub: "user-1", client_id: 42 })).toEqual({
      arm: "unknown",
    });
    expect(classifyCliTokenShape({ sub: "user-1", azp: {} })).toEqual({
      arm: "unknown",
    });
  });

  it("is total — every input lands in exactly one arm", () => {
    const values = [undefined, "x", "", 7, null];
    for (const sub of values) {
      for (const azp of values) {
        for (const client_id of values) {
          const shape = classifyCliTokenShape({ sub, azp, client_id });
          expect(["user-delegated", "machine-client", "unknown"]).toContain(
            shape.arm,
          );
        }
      }
    }
  });
});
