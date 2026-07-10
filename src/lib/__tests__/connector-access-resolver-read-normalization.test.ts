// Read-time policy normalization at the connector-access-resolver path
// (multi-scope). `resolveConnectorCanonicalAccessSync` runs the canonical
// `AgentAuthPolicySchema` over the stored `extension_access_policy` row, so a
// legacy SCALAR visibility field coerces to a NON-EMPTY token array and a
// schema-invalid stored policy fails CLOSED (policy stays null → the caller
// applies the fail-closed default). The DB layer is mocked (two sequential
// runPostgresQueriesSync calls: installed_extension, then policy + co-owners).

import { describe, it, expect, vi, beforeEach } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));

import { resolveConnectorCanonicalAccessSync } from "@/lib/connector-access-resolver";

const ORG = "org-1";
const PKG = "@cinatra-ai/x-connector";

const installedRow = (over: Record<string, unknown> = {}) => ({
  id: "inst-1",
  owner_level: "organization",
  owner_id: ORG,
  organization_id: ORG,
  access_declaration: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveConnectorCanonicalAccessSync — read-time normalization (multi-scope)", () => {
  it("coerces a stored SCALAR policy to non-empty token arrays", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [installedRow()] }])
      .mockReturnValueOnce([
        {
          rows: [
            {
              policy: {
                runListVisibility: "workspace",
                runDataVisibility: "admin",
                runExecuteVisibility: "workspace",
                allowRunSharing: false,
              },
              installed_by_user_id: null,
            },
          ],
        },
        { rows: [] },
      ]);
    const res = resolveConnectorCanonicalAccessSync(ORG, PKG);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.access.policy?.runListVisibility).toEqual(["workspace"]);
      expect(res.access.policy?.runDataVisibility).toEqual(["admin"]);
    }
  });

  it("parses a STRINGIFIED jsonb policy and coerces it", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [installedRow()] }])
      .mockReturnValueOnce([
        {
          rows: [
            {
              policy: JSON.stringify({
                runListVisibility: "owner",
                runDataVisibility: "owner",
                runExecuteVisibility: "owner",
                allowRunSharing: false,
              }),
              installed_by_user_id: "u-1",
            },
          ],
        },
        { rows: [] },
      ]);
    const res = resolveConnectorCanonicalAccessSync(ORG, PKG);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.access.policy?.runDataVisibility).toEqual(["owner"]);
      expect(res.access.installedByUserId).toBe("u-1");
    }
  });

  it("fails a schema-INVALID stored policy CLOSED (policy stays null)", () => {
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [installedRow()] }])
      .mockReturnValueOnce([
        {
          rows: [
            {
              policy: {
                runListVisibility: "nonsense!!",
                runDataVisibility: "owner",
                runExecuteVisibility: "owner",
                allowRunSharing: false,
              },
              installed_by_user_id: null,
            },
          ],
        },
        { rows: [] },
      ]);
    const res = resolveConnectorCanonicalAccessSync(ORG, PKG);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.access.policy).toBeNull();
    }
  });

  it("returns absent when no canonical install row exists", () => {
    runPostgresQueriesSync.mockReturnValueOnce([{ rows: [] }]);
    expect(resolveConnectorCanonicalAccessSync(ORG, PKG).status).toBe("absent");
  });
});
