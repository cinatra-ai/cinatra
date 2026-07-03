// Coverage for the Twenty connect flow that lives in external-mcp-registry.ts
// (issue cinatra-ai/twenty-connector#39): the URL/SSRF guard, the MANDATORY live
// probe before any persistence (fail-closed), the Nango import under the SHARED
// external-MCP provider + readback-verify, and the singleton row write. The key
// must never reach persistence when the probe fails, must never appear in a
// failure message, and the row must carry only the connection id (no key column).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The external-MCP row CRUD (upsert / fresh-read / delete) runs through the
// postgres layer — mock it so we can drive the fresh-read result and capture the
// row INSERT values.
let selectRows: Record<string, unknown>[] = [];
const runPostgresQueriesSync = vi.fn((arg: { queries: { text: string; values?: unknown[] }[] }) => {
  const text = arg.queries[0]?.text ?? "";
  if (/^\s*SELECT/i.test(text)) return [{ rows: selectRows, rowCount: selectRows.length }];
  return [{ rows: [], rowCount: 1 }];
});
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...(a as [never])),
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "public",
}));
vi.mock("@/lib/wordpress-mcp-connection", () => ({ isPrivateUrl: () => false }));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({ getMcpPublicBaseUrl: () => ({ publicBaseUrl: null }) }));

const ensureNangoIntegration = vi.fn();
const importNangoConnection = vi.fn();
const deleteNangoConnection = vi.fn();
const getNangoCredentials = vi.fn();
const isNangoConfigured = vi.fn();
vi.mock("@/lib/nango-system", () => ({
  ensureNangoIntegration: (...a: unknown[]) => ensureNangoIntegration(...a),
  importNangoConnection: (...a: unknown[]) => importNangoConnection(...a),
  deleteNangoConnection: (...a: unknown[]) => deleteNangoConnection(...a),
  getNangoCredentials: (...a: unknown[]) => getNangoCredentials(...a),
  isNangoConfigured: (...a: unknown[]) => isNangoConfigured(...a),
}));

import {
  normalizeTwentyInstanceUrl,
  saveTwentyConnection,
  disconnectTwentyConnection,
  getTwentyConnectionState,
  TwentyConnectionError,
  TWENTY_WORKSPACE_ROW_ID,
} from "@/lib/external-mcp-registry";

const SECRET = "sk-twenty-super-secret-key";

function mockFetch(status: number, ok = status >= 200 && status < 300) {
  const f = vi.fn().mockResolvedValue({ ok, status });
  vi.stubGlobal("fetch", f);
  return f;
}

/** A raw DB row (snake_case) as external_mcp_servers returns for the fresh read. */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TWENTY_WORKSPACE_ROW_ID,
    label: "Twenty CRM",
    server_url: "https://old.example.com/mcp",
    nango_connection_id: "twenty-workspace-oldhash00000000",
    scope: "workspace",
    org_id: null,
    user_id: null,
    enabled: true,
    allowed_tools: null,
    allowed_catalog_tools: ["find_companies"],
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...overrides,
  };
}

/** The captured INSERT/UPDATE row values (upsert) from the postgres mock. */
function upsertValues(): unknown[] | undefined {
  const call = runPostgresQueriesSync.mock.calls.find((c) =>
    /INSERT INTO .*external_mcp_servers/i.test((c[0] as { queries: { text: string }[] }).queries[0].text),
  );
  return call ? (call[0] as { queries: { values?: unknown[] }[] }).queries[0].values : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  selectRows = [];
  // Clear the module's globalThis-anchored 30s row cache so getExternalMcpServerById
  // (used by getTwentyConnectionState) re-reads selectRows each test.
  (globalThis as Record<string, unknown>).__cinatraExternalMcpServerCache = null;
  isNangoConfigured.mockReturnValue(true);
  getNangoCredentials.mockResolvedValue({ apiKey: SECRET });
});

describe("normalizeTwentyInstanceUrl", () => {
  it("accepts https and derives the /mcp endpoint; strips trailing slash + pasted /mcp", () => {
    expect(normalizeTwentyInstanceUrl("https://crm.example.com")).toEqual({
      restBase: "https://crm.example.com",
      mcpUrl: "https://crm.example.com/mcp",
    });
    expect(normalizeTwentyInstanceUrl("https://crm.example.com/mcp/")).toEqual({
      restBase: "https://crm.example.com",
      mcpUrl: "https://crm.example.com/mcp",
    });
  });
  it("allows http only for localhost", () => {
    expect(normalizeTwentyInstanceUrl("http://localhost:3300").mcpUrl).toBe("http://localhost:3300/mcp");
    expect(() => normalizeTwentyInstanceUrl("http://crm.example.com")).toThrow(TwentyConnectionError);
  });
  it("rejects empty / non-URL input", () => {
    expect(() => normalizeTwentyInstanceUrl("")).toThrow(TwentyConnectionError);
    expect(() => normalizeTwentyInstanceUrl("not a url")).toThrow(TwentyConnectionError);
  });
  it("rejects private / link-local / metadata hosts (SSRF guard)", () => {
    for (const bad of [
      "https://10.0.0.5:8443",
      "https://192.168.1.10",
      "https://172.16.0.9",
      "https://169.254.169.254",
      "https://crm.internal",
      "https://box.local",
    ]) {
      expect(() => normalizeTwentyInstanceUrl(bad), bad).toThrow(TwentyConnectionError);
    }
    expect(normalizeTwentyInstanceUrl("https://crm.example.com").mcpUrl).toBe("https://crm.example.com/mcp");
  });
});

describe("saveTwentyConnection", () => {
  it("requires an API key", async () => {
    await expect(saveTwentyConnection({ instanceUrl: "https://x.example", apiKey: "" })).rejects.toThrow(
      TwentyConnectionError,
    );
    expect(importNangoConnection).not.toHaveBeenCalled();
  });

  it("fails closed when Nango is not configured (no probe, no import)", async () => {
    isNangoConfigured.mockReturnValue(false);
    const f = mockFetch(200);
    await expect(
      saveTwentyConnection({ instanceUrl: "https://crm.example.com", apiKey: SECRET }),
    ).rejects.toThrow(TwentyConnectionError);
    expect(f).not.toHaveBeenCalled();
    expect(importNangoConnection).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized key WITHOUT importing or writing the row", async () => {
    mockFetch(401);
    await expect(
      saveTwentyConnection({ instanceUrl: "https://crm.example.com", apiKey: SECRET }),
    ).rejects.toThrow(/rejected/i);
    expect(importNangoConnection).not.toHaveBeenCalled();
    expect(upsertValues()).toBeUndefined();
  });

  it("rejects an unreachable instance WITHOUT importing or writing the row", async () => {
    mockFetch(500);
    await expect(
      saveTwentyConnection({ instanceUrl: "https://crm.example.com", apiKey: SECRET }),
    ).rejects.toThrow(/reach/i);
    expect(importNangoConnection).not.toHaveBeenCalled();
    expect(upsertValues()).toBeUndefined();
  });

  it("imports under the shared provider (URL-derived id) + writes the singleton row on a good probe", async () => {
    mockFetch(200);
    await saveTwentyConnection({ instanceUrl: "https://crm.example.com/", apiKey: SECRET });

    expect(ensureNangoIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ providerConfigKey: "cinatra-external-mcp", provider: "private-api-bearer" }),
    );
    const importArgs = importNangoConnection.mock.calls[0][0];
    expect(importArgs.providerConfigKey).toBe("cinatra-external-mcp");
    expect(importArgs.credentials).toEqual({ type: "API_KEY", apiKey: SECRET });
    expect(importArgs.connectionId).toMatch(/^twenty-workspace-[0-9a-f]{16}$/);

    // Row INSERT values: [id, label, server_url, nango_connection_id, scope, org_id, user_id, enabled, allowed_tools, allowed_catalog_tools]
    const v = upsertValues();
    expect(v).toBeDefined();
    expect(v![0]).toBe(TWENTY_WORKSPACE_ROW_ID);
    expect(v![2]).toBe("https://crm.example.com/mcp");
    expect(v![3]).toBe(importArgs.connectionId); // row binds the same url-derived connection id
    expect(v![4]).toBe("workspace");
    expect(v![9]).toEqual(["find_companies", "find_people", "find_one_company", "find_one_person", "get_views"]);
    // The key is never among the persisted row values.
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  it("fails closed on a readback mismatch and never leaks the key in the message", async () => {
    mockFetch(200);
    getNangoCredentials.mockResolvedValue({ apiKey: "DIFFERENT" });
    const err = await saveTwentyConnection({
      instanceUrl: "https://crm.example.com",
      apiKey: SECRET,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TwentyConnectionError);
    expect(String(err.message)).not.toContain(SECRET);
    expect(upsertValues()).toBeUndefined();
  });

  it("removes the PREVIOUS instance's Nango key after a URL change", async () => {
    mockFetch(200);
    selectRows = [rawRow({ nango_connection_id: "twenty-workspace-oldhash00000000" })];
    await saveTwentyConnection({ instanceUrl: "https://new.example.com", apiKey: SECRET });
    const newConnId = importNangoConnection.mock.calls[0][0].connectionId;
    expect(newConnId).not.toBe("twenty-workspace-oldhash00000000");
    expect(deleteNangoConnection).toHaveBeenCalledWith("cinatra-external-mcp", "twenty-workspace-oldhash00000000");
  });
});

describe("disconnectTwentyConnection", () => {
  it("deletes the row and the bound Nango connection (via a FRESH read)", async () => {
    selectRows = [rawRow({ nango_connection_id: "twenty-workspace-abc123" })];
    await disconnectTwentyConnection();
    const deleted = runPostgresQueriesSync.mock.calls.some((c) =>
      /DELETE FROM .*external_mcp_servers/i.test((c[0] as { queries: { text: string }[] }).queries[0].text),
    );
    expect(deleted).toBe(true);
    expect(deleteNangoConnection).toHaveBeenCalledWith("cinatra-external-mcp", "twenty-workspace-abc123");
  });

  it("still removes the row when there is no bound connection", async () => {
    selectRows = [];
    await disconnectTwentyConnection();
    expect(deleteNangoConnection).not.toHaveBeenCalled();
  });
});

describe("getTwentyConnectionState", () => {
  it("reports connected with the instance URL derived from the row", () => {
    selectRows = [rawRow({ server_url: "https://crm.example.com/mcp", nango_connection_id: "c1", enabled: true })];
    expect(getTwentyConnectionState()).toEqual({ connected: true, instanceUrl: "https://crm.example.com" });
  });
  it("reports not-connected when the row is absent", () => {
    selectRows = [];
    expect(getTwentyConnectionState()).toEqual({ connected: false, instanceUrl: null });
  });
});
