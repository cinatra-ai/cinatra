// Managed-endpoint containment (cinatra#2015 S0 deliverable 3) + the
// WordPress-credential single-path pin (deliverable 4).
//
// Managed and BYO registrations of the same site endpoint must not coexist:
// every registry write refuses a BYO row whose canonical URL matches a managed
// connector instance's endpoint, and the once-per-process sweep disables
// pre-existing matches (audit + admin notification). BYO rows for unrelated
// servers are unaffected — containment, not capability-hiding.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type QueryCall = { text: string; values?: unknown[] };
let queryLog: QueryCall[][] = [];
let nextResults: Array<{ rows: Array<Record<string, unknown>>; rowCount: number }> = [];

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: QueryCall[] }) => {
    queryLog.push(input.queries);
    const result = nextResults.shift() ?? { rows: [], rowCount: 0 };
    return [result];
  },
}));

// The managed WordPress instances the containment must protect. The registry
// consumes the vendor-neutral capability surface, which returns BOTH endpoint
// URL forms per instance (pretty-permalink + query-string) — mirrored here.
let wpInstances: Array<{ siteUrl: string }> = [];
vi.mock("@/lib/connector-client-providers", () => ({
  listManagedExternalMcpEndpointUrls: () =>
    wpInstances.flatMap(({ siteUrl }) => {
      const trimmed = siteUrl.replace(/\/+$/, "");
      return [
        `${trimmed}/wp-json/mcp/mcp-adapter-default-server`,
        `${trimmed}/index.php?rest_route=/mcp/mcp-adapter-default-server`,
      ];
    }),
}));

const notifications: Array<{ title: string; body: string }> = [];
vi.mock("@/lib/notifications", () => ({
  createNotification: async (input: { title: string; body: string }) => {
    notifications.push(input);
  },
}));

const {
  canonicalizeMcpEndpointUrl,
  insertExternalMcpServerStrict,
  upsertExternalMcpServer,
  listExternalMcpServers,
  ExternalMcpServerManagedEndpointError,
} = await import("@/lib/external-mcp-registry");

const byoRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "byo-1",
  label: "My Server",
  serverUrl: "https://elsewhere.example.com/mcp",
  nangoConnectionId: null,
  scope: "user" as const,
  orgId: null,
  userId: "u1" as string | null,
  enabled: true,
  ...over,
});

beforeEach(() => {
  queryLog = [];
  nextResults = [];
  notifications.length = 0;
  wpInstances = [];
  // Reset the registry's in-process cache between tests.
  (globalThis as Record<string, unknown>)["__cinatraExternalMcpServerCache"] = null;
});

describe("canonicalizeMcpEndpointUrl", () => {
  it("equates the WordPress query-string endpoint form with its pretty-permalink twin", () => {
    const pretty = canonicalizeMcpEndpointUrl(
      "https://Site.example.com/wp-json/mcp/mcp-adapter-default-server",
    );
    const queryForm = canonicalizeMcpEndpointUrl(
      "https://site.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
    );
    expect(pretty).not.toBeNull();
    expect(queryForm).toEqual(pretty);
  });

  it("equates default-port, trailing-slash, and host-case variants", () => {
    const canonical = canonicalizeMcpEndpointUrl("https://site.example.com/mcp");
    expect(canonicalizeMcpEndpointUrl("https://SITE.example.com:443/mcp/")).toEqual(canonical);
    expect(canonicalizeMcpEndpointUrl("https://site.example.com/mcp///")).toEqual(canonical);
  });

  it("keeps genuinely different endpoints distinct (port, path case, other query)", () => {
    const base = canonicalizeMcpEndpointUrl("https://site.example.com/mcp");
    expect(canonicalizeMcpEndpointUrl("https://site.example.com:8443/mcp")).not.toEqual(base);
    expect(canonicalizeMcpEndpointUrl("https://site.example.com/MCP")).not.toEqual(base);
    expect(canonicalizeMcpEndpointUrl("https://site.example.com/mcp?x=1")).not.toEqual(base);
  });

  it("returns null for non-http(s) or relative input", () => {
    expect(canonicalizeMcpEndpointUrl("ftp://site.example.com/mcp")).toBeNull();
    expect(canonicalizeMcpEndpointUrl("not a url")).toBeNull();
  });
});

describe("BYO write containment", () => {
  it("refuses a BYO row targeting a managed instance's endpoint — in EITHER URL form", () => {
    wpInstances = [{ siteUrl: "https://managed.example.com" }];
    for (const serverUrl of [
      "https://managed.example.com/wp-json/mcp/mcp-adapter-default-server",
      "https://managed.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
      "https://MANAGED.example.com:443/wp-json/mcp/mcp-adapter-default-server/",
    ]) {
      expect(() => insertExternalMcpServerStrict(byoRow({ serverUrl }))).toThrow(
        ExternalMcpServerManagedEndpointError,
      );
      expect(() => upsertExternalMcpServer(byoRow({ serverUrl }))).toThrow(
        ExternalMcpServerManagedEndpointError,
      );
    }
    // Refused BEFORE any SQL was issued.
    expect(queryLog).toEqual([]);
  });

  it("BYO rows for unrelated servers are unaffected (containment, not capability-hiding)", () => {
    wpInstances = [{ siteUrl: "https://managed.example.com" }];
    nextResults = [{ rows: [{ id: "byo-1" }], rowCount: 1 }];
    expect(() => insertExternalMcpServerStrict(byoRow())).not.toThrow();
  });

  it("no managed instances (connector absent) ⇒ nothing is refused", () => {
    wpInstances = [];
    nextResults = [{ rows: [{ id: "byo-1" }], rowCount: 1 }];
    expect(() =>
      insertExternalMcpServerStrict(
        byoRow({ serverUrl: "https://managed.example.com/wp-json/mcp/mcp-adapter-default-server" }),
      ),
    ).not.toThrow();
  });
});

describe("migration sweep", () => {
  const managedMatchRaw = {
    id: "legacy-1",
    label: "Legacy WP row",
    server_url: "https://managed.example.com/index.php?rest_route=/mcp/mcp-adapter-default-server",
    nango_connection_id: null,
    scope: "user",
    org_id: null,
    user_id: "u1",
    enabled: true,
    allowed_tools: null,
    allowed_catalog_tools: null,
    transport: "unknown",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const unrelatedRaw = {
    ...managedMatchRaw,
    id: "keep-1",
    label: "Unrelated",
    server_url: "https://elsewhere.example.com/mcp",
  };

  it("disables pre-existing enabled rows matching a managed endpoint, audits each, notifies admins — unrelated rows untouched", async () => {
    wpInstances = [{ siteUrl: "https://managed.example.com" }];
    nextResults = [
      { rows: [managedMatchRaw, unrelatedRaw], rowCount: 2 }, // the list SELECT
      { rows: [], rowCount: 1 }, // the sweep UPDATE
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rows = listExternalMcpServers();

    // The matching row is disabled in the returned set AND via SQL; the
    // unrelated row keeps its state.
    expect(rows.find((r) => r.id === "legacy-1")?.enabled).toBe(false);
    expect(rows.find((r) => r.id === "keep-1")?.enabled).toBe(true);
    const sweepUpdate = queryLog.flat().find((q) => q.text.includes("SET enabled = false"));
    expect(sweepUpdate).toBeDefined();
    expect(sweepUpdate?.values?.[0]).toEqual(["legacy-1"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("AUDIT"))).toBe(true);
    // The admin notification is fire-and-forget — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toContain("Legacy WP row");
    warn.mockRestore();
  });

  it("runs ONCE per process — a later uncached list does not re-sweep", () => {
    wpInstances = [{ siteUrl: "https://managed.example.com" }];
    nextResults = [
      { rows: [], rowCount: 0 },
      { rows: [managedMatchRaw], rowCount: 1 },
    ];
    listExternalMcpServers(); // first read arms + runs the sweep (no matches)
    (globalThis as Record<string, unknown>)["__cinatraExternalMcpServerCache"] = null;
    const rows = listExternalMcpServers(); // second uncached read: NO sweep
    expect(rows.find((r) => r.id === "legacy-1")?.enabled).toBe(true);
    expect(queryLog.flat().some((q) => q.text.includes("SET enabled = false"))).toBe(false);
  });
});

describe("WordPress credential single-path pin (cinatra#2015 S0 deliverable 4)", () => {
  it("no toolbox provider surface carries WordPress wiring — WP tools ride ONLY the guarded manifest toolbox", () => {
    // The S0 hard guard lives on the WP connector's manifest-resolved toolbox.
    // If a WordPress `llm-toolbox` capability provider were ever registered,
    // its credentialed tools would ride the legacy always-inject set and
    // BYPASS that guard. Pin: the provider surface has no WordPress wiring
    // (comments stripped — prose mentions don't count).
    const source = readFileSync(join(process.cwd(), "src/lib/llm-toolbox-providers.ts"), "utf-8");
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/wordpress/i);
  });

  it("the generated manifest routes the WP connector through the manifest toolbox marker", () => {
    const manifest = readFileSync(
      join(process.cwd(), "src/lib/generated/extensions.server.ts"),
      "utf-8",
    );
    const record = manifest
      .split("\n")
      .find((line) => line.includes('"@cinatra-ai/wordpress-mcp-connector":'));
    expect(record).toBeDefined();
    expect(record).toContain('"providesExternalMcpToolbox":true');
  });
});
