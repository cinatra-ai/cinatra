// Read-time policy normalization at the extension permissions-store path
// (multi-scope). `readExtensionAccessPolicies` runs the canonical
// `AgentAuthPolicySchema` over every stored row, so a legacy SCALAR visibility
// field coerces to a NON-EMPTY token array on read and a schema-invalid row is
// dropped (fail-closed → the caller applies the kind's default). The DB layer
// (runPostgresQueriesSync) is mocked so this stays a pure read-path test.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));

import { readExtensionAccessPolicies } from "../permissions-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readExtensionAccessPolicies — read-time normalization (multi-scope)", () => {
  it("coerces a stored SCALAR visibility policy to non-empty token arrays", async () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            resource_id: "r1",
            policy: {
              runListVisibility: "workspace",
              runDataVisibility: "workspace",
              runExecuteVisibility: "admin",
              allowRunSharing: false,
            },
          },
        ],
      },
    ]);
    const map = await readExtensionAccessPolicies("connection", ["r1"]);
    const p = map.get("r1");
    expect(p).toBeDefined();
    expect(p!.runListVisibility).toEqual(["workspace"]);
    expect(p!.runDataVisibility).toEqual(["workspace"]);
    expect(p!.runExecuteVisibility).toEqual(["admin"]);
  });

  it("parses a STRINGIFIED jsonb policy and coerces its scalar fields", async () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            resource_id: "r2",
            policy: JSON.stringify({
              runListVisibility: "owner",
              runDataVisibility: "owner",
              runExecuteVisibility: "owner",
              allowRunSharing: true,
            }),
          },
        ],
      },
    ]);
    const map = await readExtensionAccessPolicies("connection", ["r2"]);
    expect(map.get("r2")!.runDataVisibility).toEqual(["owner"]);
    expect(map.get("r2")!.allowRunSharing).toBe(true);
  });

  it("preserves an already-array (multi-token) stored policy unchanged", async () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            resource_id: "r3",
            policy: {
              runListVisibility: ["team:11111111-1111-1111-1111-111111111111"],
              runDataVisibility: [
                "team:11111111-1111-1111-1111-111111111111",
                "project:22222222-2222-2222-2222-222222222222",
              ],
              runExecuteVisibility: ["team:11111111-1111-1111-1111-111111111111"],
              allowRunSharing: false,
            },
          },
        ],
      },
    ]);
    const map = await readExtensionAccessPolicies("connection", ["r3"]);
    expect(map.get("r3")!.runDataVisibility).toEqual([
      "team:11111111-1111-1111-1111-111111111111",
      "project:22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("treats a schema-INVALID stored row as absent (fail-closed)", async () => {
    runPostgresQueriesSync.mockReturnValue([
      {
        rows: [
          {
            resource_id: "r4",
            policy: {
              runListVisibility: "galaxy:42",
              runDataVisibility: "owner",
              runExecuteVisibility: "owner",
              allowRunSharing: false,
            },
          },
        ],
      },
    ]);
    const map = await readExtensionAccessPolicies("connection", ["r4"]);
    expect(map.has("r4")).toBe(false);
  });
});
