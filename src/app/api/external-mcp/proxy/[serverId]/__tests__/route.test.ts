// Regression coverage: the external MCP proxy
// must require a VALIDATED session, enforce row authorization via the canonical
// kernel BEFORE resolving the stored upstream bearer, and re-enforce native +
// catalog tool allowlists at the proxy boundary. Fail-closed throughout.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getActorContext = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));

const guardConnectorAccess = vi.fn();
vi.mock("@/lib/connectors-scope-guard", () => ({
  CONNECTOR_ACCESS_DENIED: "CONNECTOR_ACCESS_DENIED",
  guardConnectorAccess: (...args: unknown[]) => guardConnectorAccess(...args),
}));

const getExternalMcpServerById = vi.fn();
const resolveExternalMcpServerBearer = vi.fn();
vi.mock("@/lib/external-mcp-registry", () => ({
  getExternalMcpServerById: (...args: unknown[]) => getExternalMcpServerById(...args),
  resolveExternalMcpServerBearer: (...args: unknown[]) =>
    resolveExternalMcpServerBearer(...args),
}));

import { POST } from "../route";

const ACTOR = { principalType: "HumanUser", principalId: "user-1" };

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "twenty-apple",
    label: "Twenty (Apple)",
    serverUrl: "https://upstream.example/mcp",
    nangoConnectionId: null,
    scope: "global",
    orgId: null,
    userId: null,
    enabled: true,
    allowedTools: ["execute_tool"],
    allowedCatalogTools: ["create_company"],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function ctx(serverId = "twenty-apple") {
  return { params: Promise.resolve({ serverId }) };
}

function rpcRequest(body: unknown): Request {
  return new Request("http://localhost/api/external-mcp/proxy/twenty-apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function denyAccess() {
  const err = new Error("denied") as Error & { code: string };
  err.code = "CONNECTOR_ACCESS_DENIED";
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  getActorContext.mockResolvedValue(ACTOR);
  guardConnectorAccess.mockResolvedValue(undefined);
  getExternalMcpServerById.mockReturnValue(makeRow());
  resolveExternalMcpServerBearer.mockResolvedValue("upstream-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

const execToolCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "execute_tool", arguments: { toolName: "create_company" } },
};

describe("external MCP proxy — auth & authz", () => {
  it("rejects requests without a validated session (401), no bearer resolved, no upstream call", async () => {
    getActorContext.mockResolvedValue(undefined);
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    expect(res.status).toBe(401);
    expect(resolveExternalMcpServerBearer).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // Must not leak row existence on the unauth path.
    expect(getExternalMcpServerById).not.toHaveBeenCalled();
  });

  it("fails closed (401) when actor resolution throws", async () => {
    getActorContext.mockRejectedValue(new Error("session backend down"));
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects unauthorized callers (403) and does not resolve or attach the bearer", async () => {
    guardConnectorAccess.mockRejectedValue(denyAccess());
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    expect(res.status).toBe(403);
    expect(resolveExternalMcpServerBearer).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("runs the authorization guard BEFORE resolving the bearer", async () => {
    const order: string[] = [];
    guardConnectorAccess.mockImplementation(async () => {
      order.push("guard");
    });
    resolveExternalMcpServerBearer.mockImplementation(async () => {
      order.push("bearer");
      return "upstream-secret";
    });
    await POST(rpcRequest(execToolCall) as never, ctx());
    expect(order).toEqual(["guard", "bearer"]);
  });

  it("any guard failure (not just the typed deny) fails closed with 403", async () => {
    guardConnectorAccess.mockRejectedValue(new Error("unexpected"));
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards an authorized, allowlisted execute_tool call with the bearer attached", async () => {
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer upstream-secret",
    });
  });
});

describe("external MCP proxy — native allowedTools enforcement at the boundary", () => {
  it("rejects a tools/call for a native tool not in allowedTools, even when not execute_tool", async () => {
    getExternalMcpServerById.mockReturnValue(
      makeRow({ allowedTools: ["execute_tool"] }),
    );
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_tool_catalog", arguments: {} },
      }) as never,
      ctx(),
    );
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32601);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a tools/call with a missing/empty name", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }) as never,
      ctx(),
    );
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32602);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("allows a native tool that IS in allowedTools", async () => {
    getExternalMcpServerById.mockReturnValue(
      makeRow({ allowedTools: ["get_tool_catalog"], allowedCatalogTools: null }),
    );
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "get_tool_catalog", arguments: {} },
      }) as never,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("external MCP proxy — method allowlist & batch denial", () => {
  it("denies JSON-RPC batch arrays", async () => {
    const res = await POST(rpcRequest([execToolCall, execToolCall]) as never, ctx());
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32600);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("denies an unknown / non-tool method rather than passing it through", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 11, method: "resources/read", params: {} }) as never,
      ctx(),
    );
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32601);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("allows a passthrough method (tools/list) for an authorized actor", async () => {
    const res = await POST(
      rpcRequest({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }) as never,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("external MCP proxy — disabled & unknown rows fail closed", () => {
  it("fails closed for an unknown row", async () => {
    getExternalMcpServerById.mockReturnValue(undefined);
    const res = await POST(rpcRequest(execToolCall) as never, ctx("does-not-exist"));
    const json = (await res.json()) as { error?: { message: string } };
    expect(json.error?.message).toContain("unknown server");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed for a disabled row, before bearer resolution", async () => {
    getExternalMcpServerById.mockReturnValue(makeRow({ enabled: false }));
    const res = await POST(rpcRequest(execToolCall) as never, ctx());
    const json = (await res.json()) as { error?: { message: string } };
    expect(json.error?.message).toContain("disabled");
    expect(resolveExternalMcpServerBearer).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("external MCP proxy — Layer-B catalog allowlist retained", () => {
  it("rejects an execute_tool toolName not in allowedCatalogTools", async () => {
    getExternalMcpServerById.mockReturnValue(
      makeRow({ allowedCatalogTools: ["create_company"] }),
    );
    const res = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "execute_tool", arguments: { toolName: "delete_everything" } },
      }) as never,
      ctx(),
    );
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32602);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
