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

// ---------------------------------------------------------------------------
// The connect-seed provenance marker (cinatra#3408).
//
// `registerSavedConnectionIdentity`'s one-time grant seed stores
// `seededDefault: true` INSIDE the policy jsonb so the Sharing tab can tell an
// untouched connect seed from an explicit owner save. The canonical
// `AgentAuthPolicySchema` is a `z.object`, so its parse STRIPS every key it
// does not name — the marker included. Read back through this reader the
// marker must survive, or no real panel can ever draw the recommending
// connector's line (§II of the ratified drawing).
// ---------------------------------------------------------------------------

describe("readExtensionAccessPolicies — the connect-seed marker (cinatra#3408)", () => {
  const seededRow = (resourceId: string, policy: unknown) => [
    { rows: [{ resource_id: resourceId, policy }] },
  ];

  it("preserves `seededDefault` across the canonical parse (the untouched-seed reading)", async () => {
    runPostgresQueriesSync.mockReturnValue(
      seededRow("s1", {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: false,
        seededDefault: true,
      }),
    );
    const map = await readExtensionAccessPolicies("connection", ["s1"]);
    const p = map.get("s1");
    expect(p).toBeDefined();
    expect((p as { seededDefault?: unknown }).seededDefault).toBe(true);
    // …and the normalization the reader already owned is unchanged.
    expect(p!.runListVisibility).toEqual(["owner"]);
  });

  it("preserves the marker on a STRINGIFIED jsonb row too", async () => {
    runPostgresQueriesSync.mockReturnValue(
      seededRow(
        "s2",
        JSON.stringify({
          runListVisibility: "owner",
          runDataVisibility: "owner",
          runExecuteVisibility: "owner",
          allowRunSharing: false,
          seededDefault: true,
        }),
      ),
    );
    const map = await readExtensionAccessPolicies("connection", ["s2"]);
    expect((map.get("s2") as { seededDefault?: unknown }).seededDefault).toBe(true);
  });

  it("never invents the marker on an explicitly SAVED policy", async () => {
    runPostgresQueriesSync.mockReturnValue(
      seededRow("s3", {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      }),
    );
    const map = await readExtensionAccessPolicies("connection", ["s3"]);
    expect("seededDefault" in (map.get("s3") as object)).toBe(false);
  });

  it("carries only the literal `true` marker (a truthy lookalike is not a seed)", async () => {
    runPostgresQueriesSync.mockReturnValue(
      seededRow("s4", {
        runListVisibility: ["owner"],
        runDataVisibility: ["owner"],
        runExecuteVisibility: ["owner"],
        allowRunSharing: false,
        seededDefault: "yes",
      }),
    );
    const map = await readExtensionAccessPolicies("connection", ["s4"]);
    expect("seededDefault" in (map.get("s4") as object)).toBe(false);
  });
});
