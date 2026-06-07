import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// resolveActorIdentity composition tests (5 cases)
//
// resolveActorIdentity is a pure function that composes 3 identity sources:
//   1. cookie session (sessionUser.id)        — wins
//   2. Bearer JWT clientId → service_accounts.created_by
//   3. localhost dev fallback (A2A_DEV_BYPASS + isLocalhostRequest) → first admin
//
// Wired into mcpRequestContextStorage.userId by the transport handler in
// packages/mcp-server/src/index.tsx.
// ---------------------------------------------------------------------------

const queryMock = vi.fn();

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthPool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
  betterAuthDb: {},
}));

import { resolveActorIdentity } from "../actor-identity";

function makeRequest(host: string = "localhost"): Request {
  return new Request(`http://${host}/api/mcp`, { method: "POST" });
}

describe("resolveActorIdentity composition", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns sessionUser.id when cookie session present (regression)", async () => {
    const userId = await resolveActorIdentity({
      sessionUser: { id: "session-user-1" },
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => ({ userId: "sa-user", organizationId: "sa-org" }),
      pool: { query: queryMock as never },
    });
    expect(userId).toBe("session-user-1");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("resolves Bearer JWT clientId → service_accounts.created_by when no cookie", async () => {
    const userId = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-xyz",
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async (cid: string) => {
        expect(cid).toBe("client-xyz");
        return { userId: "sa-user-42", organizationId: "sa-org" };
      },
      pool: { query: queryMock as never },
    });
    expect(userId).toBe("sa-user-42");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("resolves first-admin id when no cookie + A2A_DEV_BYPASS + localhost", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "admin-1" }] });
    const userId = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(userId).toBe("admin-1");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when Bearer with inactive service-account + non-localhost", async () => {
    const userId = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: "client-revoked",
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "false" },
      isLocalhost: false,
      readServiceAccount: async () => null, // inactive returns null
      pool: { query: queryMock as never },
    });
    expect(userId).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns null when no cookie + no token + non-localhost", async () => {
    const userId = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest("example.com"),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: false, // not localhost — fallback must NOT fire
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(userId).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns null when localhost + A2A_DEV_BYPASS but DB lookup throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const userId = await resolveActorIdentity({
      sessionUser: undefined,
      requestClientId: undefined,
      request: makeRequest(),
      env: { A2A_DEV_BYPASS: "true" },
      isLocalhost: true,
      readServiceAccount: async () => null,
      pool: { query: queryMock as never },
    });
    expect(userId).toBeNull();
  });
});
