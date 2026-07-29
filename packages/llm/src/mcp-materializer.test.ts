import { describe, it, expect } from "vitest";
import {
  normalizeMcpServerName,
  validateMcpServerUrl,
  resolveSingleAuthorization,
  materializeExternalMcpServers,
  type McpMaterializerInput,
} from "./mcp-materializer";

describe("normalizeMcpServerName", () => {
  it("lower-cases, collapses non-alphanumeric runs to _, trims edge underscores", () => {
    expect(normalizeMcpServerName("Twenty CRM")).toBe("twenty_crm");
    expect(normalizeMcpServerName("  external-ABC/123  ")).toBe("external_abc_123");
    expect(normalizeMcpServerName("a...b---c")).toBe("a_b_c");
    expect(normalizeMcpServerName("__weird__")).toBe("weird");
  });

  it("is deterministic and idempotent", () => {
    const once = normalizeMcpServerName("Foo Bar!!");
    expect(normalizeMcpServerName("Foo Bar!!")).toBe(once);
    expect(normalizeMcpServerName(once)).toBe(once);
  });

  it("returns empty for a label with no alphanumeric characters", () => {
    expect(normalizeMcpServerName("---")).toBe("");
    expect(normalizeMcpServerName("   ")).toBe("");
  });
});

describe("validateMcpServerUrl", () => {
  it("accepts absolute http(s) URLs and returns the canonical href", () => {
    expect(validateMcpServerUrl("https://example.com/api/mcp")).toEqual({
      ok: true,
      href: "https://example.com/api/mcp",
    });
    expect(validateMcpServerUrl("http://localhost:3000/mcp")).toEqual({
      ok: true,
      href: "http://localhost:3000/mcp",
    });
  });

  it("rejects non-URLs, relative paths, and non-http schemes", () => {
    expect(validateMcpServerUrl("not a url").ok).toBe(false);
    expect(validateMcpServerUrl("/api/mcp").ok).toBe(false);
    expect(validateMcpServerUrl("ftp://example.com").ok).toBe(false);
    expect(validateMcpServerUrl("ws://example.com").ok).toBe(false);
  });
});

describe("resolveSingleAuthorization", () => {
  it("applies the explicit Bearer rule to a bare token in the field", () => {
    expect(resolveSingleAuthorization({ authorization: "tok_123" })).toEqual({
      ok: true,
      authorization: "Bearer tok_123",
    });
  });

  it("normalizes an existing Bearer/Basic scheme in case, preserving it", () => {
    expect(resolveSingleAuthorization({ authorization: "bearer TOK" })).toEqual({
      ok: true,
      authorization: "Bearer TOK",
    });
    expect(resolveSingleAuthorization({ authorization: "BASIC dXNlcg==" })).toEqual({
      ok: true,
      authorization: "Basic dXNlcg==",
    });
  });

  it("lifts an Authorization header (any case) into the single authorization value", () => {
    const r = resolveSingleAuthorization({ headers: { Authorization: "Bearer abc" } });
    expect(r).toEqual({ ok: true, authorization: "Bearer abc" });
    const lower = resolveSingleAuthorization({ headers: { authorization: "xyz" } });
    expect(lower).toEqual({ ok: true, authorization: "Bearer xyz" });
  });

  it("keeps non-auth headers as residual and drops the auth header", () => {
    const r = resolveSingleAuthorization({
      headers: { "X-Api-Version": "2", authorization: "Bearer abc" },
    });
    expect(r).toEqual({ ok: true, authorization: "Bearer abc", headers: { "X-Api-Version": "2" } });
  });

  it("refuses when BOTH an authorization field and an Authorization header are present", () => {
    const r = resolveSingleAuthorization({
      authorization: "tok",
      headers: { AUTHORIZATION: "Bearer other" },
    });
    expect(r.ok).toBe(false);
  });

  it("refuses two case-variant Authorization headers (fail-closed, order-independent)", () => {
    const r = resolveSingleAuthorization({
      headers: { Authorization: "Bearer A", authorization: "Bearer B" },
    });
    expect(r.ok).toBe(false);
  });

  it("ignores an empty-string Authorization header (not a source)", () => {
    expect(resolveSingleAuthorization({ headers: { Authorization: "   " } })).toEqual({ ok: true });
  });

  it("passes through with no authorization when neither source is present", () => {
    expect(resolveSingleAuthorization({ headers: { "X-Foo": "1" } })).toEqual({
      ok: true,
      headers: { "X-Foo": "1" },
    });
    expect(resolveSingleAuthorization({})).toEqual({ ok: true });
  });
});

describe("materializeExternalMcpServers", () => {
  const base = (over: Partial<McpMaterializerInput>): McpMaterializerInput => ({
    serverLabel: "Server A",
    serverUrl: "https://a.example.com/mcp",
    ...over,
  });

  it("materializes the validated serialization shape and the attribution map", () => {
    const res = materializeExternalMcpServers([
      base({
        serverLabel: "Twenty CRM",
        serverUrl: "https://twenty.example/mcp",
        authorization: "tok_1",
        serverDescription: "External MCP server: Twenty",
        allowedTools: ["find_people"],
        approval: "auto_execute",
        transport: "streamable-http",
      }),
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.servers[0]).toEqual({
      serverLabel: "twenty_crm",
      serverUrl: "https://twenty.example/mcp",
      authorization: "Bearer tok_1",
      serverDescription: "External MCP server: Twenty",
      allowedTools: ["find_people"],
      approval: "auto_execute",
      transport: "streamable-http",
    });
    expect(res.attribution).toEqual({ twenty_crm: "Twenty CRM" });
  });

  it("preserves input order and omits absent optional fields", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "First", serverUrl: "https://first.example/mcp" }),
      base({ serverLabel: "Second", serverUrl: "https://second.example/mcp" }),
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.servers.map((s) => s.serverLabel)).toEqual(["first", "second"]);
    expect(res.servers[0]).toEqual({ serverLabel: "first", serverUrl: "https://first.example/mcp" });
  });

  it("carries approval_required through untouched — enforcement is the adapters' job (#1713 AC2)", () => {
    const res = materializeExternalMcpServers([base({ approval: "approval_required" })]);
    expect(res.skipped).toEqual([]);
    expect(res.servers[0].approval).toBe("approval_required");
  });

  // === Per-entry skip scope (cinatra#2015 S0) — one bad row must never drop
  // === every other server. Previously ANY failure aborted the whole batch.
  it("an invalid URL suppresses ONLY that entry — the rest of the batch materializes", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "Good One", serverUrl: "https://good.example/mcp" }),
      base({ serverLabel: "Bad", serverUrl: "not-a-url" }),
      base({ serverLabel: "Good Two", serverUrl: "https://good2.example/mcp" }),
    ]);
    expect(res.servers.map((s) => s.serverLabel)).toEqual(["good_one", "good_two"]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].code).toBe("invalid_url");
    expect(res.skipped[0].label).toBe("Bad");
  });

  it("an empty-normalizing label suppresses only itself", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "***" }),
      base({ serverLabel: "Survivor", serverUrl: "https://s.example/mcp" }),
    ]);
    expect(res.servers.map((s) => s.serverLabel)).toEqual(["survivor"]);
    expect(res.skipped[0].code).toBe("empty_label");
  });

  it("a dual authorization source suppresses only itself", () => {
    const res = materializeExternalMcpServers([
      base({
        serverLabel: "Conflicted",
        authorization: "tok",
        headers: { Authorization: "Bearer other" },
      }),
      base({ serverLabel: "Clean", serverUrl: "https://c.example/mcp" }),
    ]);
    expect(res.servers.map((s) => s.serverLabel)).toEqual(["clean"]);
    expect(res.skipped[0].code).toBe("authorization_conflict");
    expect(res.skipped[0].label).toBe("Conflicted");
  });

  it("a normalized-name collision keeps the FIRST entry and suppresses the later one, naming the winner", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "Server A", serverUrl: "https://a.example/mcp" }),
      base({ serverLabel: "server-a", serverUrl: "https://b.example/mcp" }),
    ]);
    expect(res.servers.map((s) => s.serverUrl)).toEqual(["https://a.example/mcp"]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({
      code: "name_collision",
      label: "server-a",
      winnerLabel: "Server A",
    });
  });

  it("a MANAGED entry wins a collision against an earlier BYO row (managed over BYO)", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "WordPress X", serverUrl: "https://byo.example/mcp", origin: "byo" }),
      base({ serverLabel: "wordpress-x", serverUrl: "https://managed.example/mcp", origin: "managed" }),
    ]);
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0].serverUrl).toBe("https://managed.example/mcp");
    expect(res.attribution).toEqual({ wordpress_x: "wordpress-x" });
    expect(res.skipped[0]).toMatchObject({
      code: "name_collision",
      label: "WordPress X",
      winnerLabel: "wordpress-x",
    });
  });

  it("an UNTAGGED origin ranks as BYO — it never displaces a managed entry", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "Thing", serverUrl: "https://managed.example/mcp", origin: "managed" }),
      base({ serverLabel: "thing", serverUrl: "https://untagged.example/mcp" }),
    ]);
    expect(res.servers[0].serverUrl).toBe("https://managed.example/mcp");
    expect(res.skipped[0].label).toBe("thing");
  });

  it("returns an empty result set for no inputs", () => {
    expect(materializeExternalMcpServers([])).toEqual({ servers: [], attribution: {}, skipped: [] });
  });
});
