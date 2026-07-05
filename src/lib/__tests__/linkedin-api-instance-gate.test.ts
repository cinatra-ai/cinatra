// cinatra#967 (W3 residue of #952/#953): proves all three LinkedIn raw
// credential-reader call sites route through the W2 owner-aware resolver —
// (1) the account-addressed token mint, (2) the per-user scope:"user"
// connection (real live actor threaded), and (3) the import-seam readback in
// `saveLinkedInAccountFromNangoConnection` — each BEFORE its raw Nango read,
// and each fails closed on a gate deny.

import { describe, expect, it, vi, beforeEach } from "vitest";

let CONFIG_STORE: Record<string, unknown> = {};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T>(key: string, fallback: T): T => {
    return (CONFIG_STORE[key] as T) ?? fallback;
  }),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    CONFIG_STORE[key] = value;
  }),
}));

vi.mock("@/lib/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ sub: "member-1", name: "Ada Lovelace" }),
    text: async () => JSON.stringify({ id: "urn:li:share:123" }),
  })),
}));

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { linkedin: "cinatra-linkedin" },
  deleteNangoConnection: vi.fn(),
  ensureNangoIntegration: vi.fn(async () => null),
  getNangoConnection: vi.fn(async () => ({
    credentials: { type: "OAUTH2", access_token: "token-abc" },
  })),
  getNangoOAuth2IntegrationCredentials: vi.fn(async () => null),
  getNangoOAuthCallbackUrl: vi.fn(() => "https://app.example.com/callback"),
  isNangoConfigured: vi.fn(() => true),
  listSavedNangoConnections: vi.fn(() => []),
  removeNangoConnectionRecord: vi.fn(async () => undefined),
}));

const enforceInstanceConnectionUse = vi.fn(async (..._args: unknown[]) => null);
const enforcePerUserInstanceConnectionUse = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@/lib/instance-connection-actor", () => ({
  enforceInstanceConnectionUse: (...a: unknown[]) => enforceInstanceConnectionUse(...a),
  enforcePerUserInstanceConnectionUse: (...a: unknown[]) => enforcePerUserInstanceConnectionUse(...a),
}));

import { getNangoConnection, listSavedNangoConnections } from "@/lib/nango-system";
import {
  listLinkedInAccounts,
  publishLinkedInPost,
  saveLinkedInAccountFromNangoConnection,
} from "@/lib/linkedin-api";

beforeEach(() => {
  CONFIG_STORE = {};
  vi.clearAllMocks();
  enforceInstanceConnectionUse.mockResolvedValue(null);
  enforcePerUserInstanceConnectionUse.mockResolvedValue(null);
});

describe("resolveLinkedInAccessToken (account-addressed path) — cinatra#967", () => {
  it("gates via enforceInstanceConnectionUse BEFORE the raw getNangoConnection read", async () => {
    CONFIG_STORE.linkedin = {
      accounts: [
        {
          id: "acct-1",
          memberId: "member-1",
          name: "Ada Lovelace",
          destinations: [{ id: "member-1", type: "member", name: "Ada Lovelace" }],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const callOrder: string[] = [];
    enforceInstanceConnectionUse.mockImplementationOnce(async () => {
      callOrder.push("gate");
      return null;
    });
    vi.mocked(getNangoConnection).mockImplementationOnce(async () => {
      callOrder.push("readback");
      return { credentials: { type: "OAUTH2", access_token: "token-abc" } };
    });

    await publishLinkedInPost({
      linkedinAccountId: "acct-1",
      destinationType: "member",
      destinationId: "member-1",
      content: "hello world",
    });

    expect(enforceInstanceConnectionUse).toHaveBeenCalledWith({
      connectorKey: "linkedin",
      connectionId: "acct-1",
      source: "linkedin-api",
    });
    expect(callOrder).toEqual(["gate", "readback"]);
  });

  it("a denied gate propagates (fails closed) and never reaches the raw token read", async () => {
    CONFIG_STORE.linkedin = {
      accounts: [
        {
          id: "acct-1",
          memberId: "member-1",
          name: "Ada Lovelace",
          destinations: [{ id: "member-1", type: "member", name: "Ada Lovelace" }],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    class Denied extends Error {}
    enforceInstanceConnectionUse.mockRejectedValueOnce(new Denied("denied"));

    await expect(
      publishLinkedInPost({
        linkedinAccountId: "acct-1",
        destinationType: "member",
        destinationId: "member-1",
        content: "hello world",
      }),
    ).rejects.toThrow(Denied);
    expect(getNangoConnection).not.toHaveBeenCalled();
  });
});

describe("readLinkedInUserConnection (scope:user path, real live actor) — cinatra#967", () => {
  it("threads the real userId to enforcePerUserInstanceConnectionUse BEFORE the raw read", async () => {
    vi.mocked(listSavedNangoConnections).mockReturnValue([
      { connectionId: "li-user-conn", providerConfigKey: "cinatra-linkedin", scope: "user" } as never,
    ]);
    const callOrder: string[] = [];
    enforcePerUserInstanceConnectionUse.mockImplementationOnce(async () => {
      callOrder.push("gate");
      return null;
    });
    vi.mocked(getNangoConnection).mockImplementationOnce(async () => {
      callOrder.push("readback");
      return { credentials: { type: "OAUTH2", access_token: "token-user" } };
    });

    await publishLinkedInPost({
      linkedinAccountId: "li-user-conn",
      destinationType: "member",
      destinationId: "member-1",
      content: "hello world",
      userId: "user-99",
    });

    expect(enforcePerUserInstanceConnectionUse).toHaveBeenCalledWith({
      connectorKey: "linkedin",
      connectionId: "li-user-conn",
      userId: "user-99",
      source: "linkedin-api",
    });
    expect(callOrder).toEqual(["gate", "readback"]);
  });
});

describe("saveLinkedInAccountFromNangoConnection (Nango materializer seam) — cinatra#967", () => {
  it("does NOT gate here (codex round-1 finding): this is the host materializer the generic /api/nango/connections/save route invokes BEFORE its own real-session identity registration — gating here would self-heal-seed a GUESSED single-tenant owner and race/conflict with that real registration", async () => {
    await saveLinkedInAccountFromNangoConnection({
      providerConfigKey: "cinatra-linkedin",
      connectionId: "new-conn",
    });

    expect(enforceInstanceConnectionUse).not.toHaveBeenCalled();
    expect(getNangoConnection).toHaveBeenCalledWith("cinatra-linkedin", "new-conn", {
      forceRefresh: true,
      refreshToken: true,
    });
    expect((await listLinkedInAccounts())[0]?.id).toBe("new-conn");
  });
});
