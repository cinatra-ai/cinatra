import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// verifyCliBearer unit tests (the CLI-audience decision record §2d). We mock the JWKS verifier (the
// resource-client's verifyAccessToken), the trusted-origin source, the
// service-account lookup, and the DB role helpers — exercising the REAL
// fail-closed composition: audience binding, scope enforcement, the post-verify
// /api/mcp rejection, and actor resolution that never defaults to admin.
// ---------------------------------------------------------------------------

const verifyAccessTokenMock = vi.fn();
const readUserIsPlatformAdminMock = vi.fn();
const readServiceAccountMock = vi.fn();
const resolveOrgRoleMock = vi.fn();
const poolQueryMock = vi.fn();

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  }),
}));
vi.mock("@better-auth/oauth-provider/resource-client", () => ({
  oauthProviderResourceClient: () => ({}),
}));

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getTrustedTokenOrigins: () => ["http://localhost:3000", "https://app.example.com"],
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));

vi.mock("@cinatra-ai/mcp-server/service-accounts", () => ({
  readServiceAccountByClientId: (...a: unknown[]) => readServiceAccountMock(...a),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readUserIsPlatformAdmin: (...a: unknown[]) => readUserIsPlatformAdminMock(...a),
  betterAuthPool: { query: (...a: unknown[]) => poolQueryMock(...a) },
}));

vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleMock(...a),
}));

import { verifyCliBearer } from "../verify-cli-bearer";

const CLI_AUD = "https://app.example.com/api/cli";
const MCP_AUD = "https://app.example.com/api/mcp";

function reqWithBearer(token = "tok"): Request {
  return new Request("https://app.example.com/api/cli/status", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readUserIsPlatformAdminMock.mockResolvedValue(false);
  resolveOrgRoleMock.mockResolvedValue(undefined);
  poolQueryMock.mockResolvedValue({ rows: [] });
  readServiceAccountMock.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("verifyCliBearer — fail-closed gates", () => {
  it("denies when there is no Authorization header", async () => {
    const req = new Request("https://app.example.com/api/cli/status");
    expect(await verifyCliBearer(req, "cli:status")).toBeNull();
    expect(verifyAccessTokenMock).not.toHaveBeenCalled();
  });

  it("denies when the token fails verification at every origin (unverified/expired)", async () => {
    verifyAccessTokenMock.mockRejectedValue(new Error("token invalid"));
    expect(await verifyCliBearer(reqWithBearer(), "cli:status")).toBeNull();
  });

  it("denies an MCP-only token (verifier rejects the /api/cli audience)", async () => {
    verifyAccessTokenMock.mockRejectedValue(new Error("unexpected audience"));
    expect(await verifyCliBearer(reqWithBearer(), "cli:agent:read")).toBeNull();
  });

  it("REJECTS a deliberately multi-audience token that also carries /api/mcp", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      sub: "user-1",
      scope: "cli:status",
      aud: [CLI_AUD, MCP_AUD],
    });
    readUserIsPlatformAdminMock.mockResolvedValue(true);
    expect(await verifyCliBearer(reqWithBearer(), "cli:status")).toBeNull();
  });

  it("denies when the required scope is absent (belt-and-suspenders re-check)", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      sub: "user-1",
      scope: "cli:status",
      aud: CLI_AUD,
    });
    expect(await verifyCliBearer(reqWithBearer(), "cli:agent:write")).toBeNull();
  });
});

describe("verifyCliBearer — actor resolution (authorization_code / sub)", () => {
  it("resolves a platform-admin actor from a verified sub", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      sub: "user-1",
      scope: "cli:status cli:agent:read",
      aud: CLI_AUD,
    });
    readUserIsPlatformAdminMock.mockResolvedValue(true);
    poolQueryMock.mockResolvedValue({ rows: [{ activeOrganizationId: "org-1" }] });
    resolveOrgRoleMock.mockResolvedValue("org_admin");

    const actor = await verifyCliBearer(reqWithBearer(), "cli:status");
    expect(actor).toMatchObject({
      userId: "user-1",
      isPlatformAdmin: true,
      orgRole: "org_admin",
      organizationId: "org-1",
      grantType: "authorization_code",
    });
    expect(readUserIsPlatformAdminMock).toHaveBeenCalledWith("user-1");
  });

  it("never defaults to admin — a non-admin sub resolves isPlatformAdmin=false", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      sub: "user-2",
      scope: "cli:status",
      aud: CLI_AUD,
    });
    readUserIsPlatformAdminMock.mockResolvedValue(false);
    const actor = await verifyCliBearer(reqWithBearer(), "cli:status");
    expect(actor?.isPlatformAdmin).toBe(false);
  });

  it("fails platform-admin closed when the DB lookup throws", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      sub: "user-3",
      scope: "cli:status",
      aud: CLI_AUD,
    });
    readUserIsPlatformAdminMock.mockRejectedValue(new Error("db down"));
    const actor = await verifyCliBearer(reqWithBearer(), "cli:status");
    expect(actor?.isPlatformAdmin).toBe(false);
  });
});

describe("verifyCliBearer — actor resolution (client_credentials / service account)", () => {
  it("resolves via the service account's created_by user when there is no sub", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      client_id: "sa-client",
      scope: "cli:status",
      aud: CLI_AUD,
    });
    readServiceAccountMock.mockResolvedValue({ userId: "owner-1", organizationId: "org-9" });
    readUserIsPlatformAdminMock.mockResolvedValue(false);

    const actor = await verifyCliBearer(reqWithBearer(), "cli:status");
    expect(actor).toMatchObject({
      userId: "owner-1",
      organizationId: "org-9",
      grantType: "client_credentials",
      isPlatformAdmin: false,
    });
    expect(readServiceAccountMock).toHaveBeenCalledWith("sa-client");
  });

  it("DENIES a client_credentials token with no service-account row (fail closed)", async () => {
    verifyAccessTokenMock.mockResolvedValue({
      client_id: "ghost-client",
      scope: "cli:status",
      aud: CLI_AUD,
    });
    readServiceAccountMock.mockResolvedValue(null);
    expect(await verifyCliBearer(reqWithBearer(), "cli:status")).toBeNull();
  });

  it("DENIES a sub-less token with no client_id", async () => {
    verifyAccessTokenMock.mockResolvedValue({ scope: "cli:status", aud: CLI_AUD });
    expect(await verifyCliBearer(reqWithBearer(), "cli:status")).toBeNull();
  });
});

describe("verifyCliBearer — audience binding is passed to the verifier", () => {
  it("verifies against each trusted origin's /api/cli audience + required scope", async () => {
    verifyAccessTokenMock
      .mockRejectedValueOnce(new Error("aud mismatch (localhost)"))
      .mockResolvedValueOnce({ sub: "user-1", scope: "cli:agent:read", aud: CLI_AUD });
    readUserIsPlatformAdminMock.mockResolvedValue(true);

    const actor = await verifyCliBearer(reqWithBearer(), "cli:agent:read");
    expect(actor?.userId).toBe("user-1");

    const calls = verifyAccessTokenMock.mock.calls;
    const opts = calls[calls.length - 1][1] as {
      verifyOptions: { audience: string };
      scopes: string[];
    };
    expect(opts.verifyOptions.audience).toBe(CLI_AUD);
    expect(opts.scopes).toEqual(["cli:agent:read"]);
  });
});
