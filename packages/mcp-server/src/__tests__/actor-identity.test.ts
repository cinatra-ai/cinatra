import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// readServiceAccountByClientId helper tests (4 cases)
//
// Task 2 composition tests live in actor-identity-compose.test.ts.
// ---------------------------------------------------------------------------

// We mock @/lib/better-auth-db so the helper's pool.query is observable.
const queryMock = vi.fn();

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthPool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
  betterAuthDb: {},
}));

// Import after vi.mock so the mocked pool is used.
import { readServiceAccountByClientId } from "../service-accounts";

describe("readServiceAccountByClientId", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("returns { userId, organizationId } for an active row matching client_id", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          created_by: "user-123",
          org_id: "org-abc",
          revoked_at: null,
        },
      ],
    });
    const result = await readServiceAccountByClientId("client-xyz");
    expect(result).toEqual({ userId: "user-123", organizationId: "org-abc" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the row is inactive (revoked_at IS NOT NULL)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          created_by: "user-123",
          org_id: "org-abc",
          revoked_at: new Date("2026-01-01"),
        },
      ],
    });
    const result = await readServiceAccountByClientId("client-xyz");
    expect(result).toBeNull();
  });

  it("returns null when client_id has no matching row", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await readServiceAccountByClientId("client-missing");
    expect(result).toBeNull();
  });

  it("returns null on DB error (non-fatal swallow)", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const result = await readServiceAccountByClientId("client-xyz");
    expect(result).toBeNull();
  });
});
