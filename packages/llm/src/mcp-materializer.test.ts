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
        requireApproval: "never",
        transport: "streamable-http",
      }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.servers[0]).toEqual({
      serverLabel: "twenty_crm",
      serverUrl: "https://twenty.example/mcp",
      authorization: "Bearer tok_1",
      serverDescription: "External MCP server: Twenty",
      allowedTools: ["find_people"],
      requireApproval: "never",
      transport: "streamable-http",
    });
    expect(res.attribution).toEqual({ twenty_crm: "Twenty CRM" });
  });

  it("preserves input order and omits absent optional fields", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "First", serverUrl: "https://first.example/mcp" }),
      base({ serverLabel: "Second", serverUrl: "https://second.example/mcp" }),
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.servers.map((s) => s.serverLabel)).toEqual(["first", "second"]);
    expect(res.servers[0]).toEqual({ serverLabel: "first", serverUrl: "https://first.example/mcp" });
  });

  it("fails closed on an invalid URL", () => {
    const res = materializeExternalMcpServers([base({ serverUrl: "not-a-url" })]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_url");
  });

  it("fails closed on an empty-normalizing label", () => {
    const res = materializeExternalMcpServers([base({ serverLabel: "***" })]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("empty_label");
  });

  it("fails closed on a dual authorization source", () => {
    const res = materializeExternalMcpServers([
      base({ authorization: "tok", headers: { Authorization: "Bearer other" } }),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("authorization_conflict");
  });

  it("detects a normalized-name collision across distinct labels and reports both", () => {
    const res = materializeExternalMcpServers([
      base({ serverLabel: "Server A", serverUrl: "https://a.example/mcp" }),
      base({ serverLabel: "server-a", serverUrl: "https://b.example/mcp" }),
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("name_collision");
    if (res.error.code !== "name_collision") return;
    expect(res.error.normalized).toBe("server_a");
    expect(res.error.labels).toEqual(["Server A", "server-a"]);
  });

  it("returns an empty result set for no inputs", () => {
    expect(materializeExternalMcpServers([])).toEqual({ ok: true, servers: [], attribution: {} });
  });
});
