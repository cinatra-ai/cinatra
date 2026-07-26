import { describe, expect, it } from "vitest";
import {
  callConnectorInstanceMcpTool,
  classifyTransportError,
  InvokerError,
  type ConnectorInstanceMcpClient,
} from "@/lib/connector-instance-mcp-transport";

// cinatra#2017 S2 slice K5 — transport unwrap + typed absent-stack errors (§1.3).

function fakeClient(behavior: {
  connectError?: unknown;
  callResult?: unknown;
  callError?: unknown;
}): { factory: () => ConnectorInstanceMcpClient; closed: () => boolean } {
  let closed = false;
  const factory = (): ConnectorInstanceMcpClient => ({
    connect: async () => {
      if (behavior.connectError) throw behavior.connectError;
    },
    callTool: async () => {
      if (behavior.callError) throw behavior.callError;
      return behavior.callResult;
    },
    close: async () => {
      closed = true;
    },
  });
  return { factory, closed: () => closed };
}

async function call(behavior: Parameters<typeof fakeClient>[0]) {
  const { factory } = fakeClient(behavior);
  return callConnectorInstanceMcpTool({
    endpoint: "https://site/x",
    authHeader: "Basic secret-never-in-errors",
    name: "mcp-adapter-execute-ability",
    arguments: { ability_name: "core/get-site-info", parameters: {} },
    clientFactory: factory,
  });
}

describe("callConnectorInstanceMcpTool — unwrap", () => {
  it("prefers structuredContent (object)", async () => {
    await expect(call({ callResult: { structuredContent: { success: true, data: { a: 1 } } } })).resolves.toEqual({
      success: true,
      data: { a: 1 },
    });
  });
  it("falls back to the first text content parsed as JSON", async () => {
    await expect(
      call({ callResult: { content: [{ type: "text", text: '{"ok":true}' }] } }),
    ).resolves.toEqual({ ok: true });
  });
  it("empty response → empty_response", async () => {
    await expect(call({ callResult: { content: [] } })).rejects.toMatchObject({ code: "empty_response" });
  });
  it("non-JSON text → invalid_response", async () => {
    await expect(call({ callResult: { content: [{ type: "text", text: "not json" }] } })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("callConnectorInstanceMcpTool — tool error (WP_Error passthrough)", () => {
  it("isError result → tool_error with code + message", async () => {
    await expect(
      call({ callResult: { isError: true, structuredContent: { error: { code: "rest_forbidden", message: "no" } } } }),
    ).rejects.toMatchObject({ code: "tool_error", wpErrorCode: "rest_forbidden", message: "no" });
  });
});

describe("callConnectorInstanceMcpTool — absent-stack typed errors (§1.3)", () => {
  it("400 no-session (Missing Mcp-Session-Id) → session_required, distinct from network", async () => {
    await expect(
      call({ connectError: new Error("HTTP 400: Missing Mcp-Session-Id header (-32600)") }),
    ).rejects.toMatchObject({ code: "session_required", httpStatus: 400 });
  });
  it("AbortError → timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    await expect(call({ connectError: err })).rejects.toMatchObject({ code: "timeout" });
  });
  it("generic connection failure → network_error", async () => {
    await expect(call({ connectError: new Error("ECONNREFUSED") })).rejects.toMatchObject({ code: "network_error" });
  });
  it("never leaks the auth header in the error message", async () => {
    try {
      await call({ connectError: new Error("boom Basic secret-never-in-errors") });
    } catch (e) {
      // The classifier composes its OWN message; it does not echo the raw error.
      expect((e as InvokerError).message).not.toContain("secret-never-in-errors");
    }
  });
});

describe("classifyTransportError", () => {
  it("maps the three absent-stack classes", () => {
    expect(classifyTransportError(new Error("Mcp-Session-Id missing")).code).toBe("session_required");
    expect(classifyTransportError(Object.assign(new Error("x"), { name: "AbortError" })).code).toBe("timeout");
    expect(classifyTransportError(new Error("socket hang up")).code).toBe("network_error");
  });
});
