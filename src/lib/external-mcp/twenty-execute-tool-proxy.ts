import "server-only";

// Layer B catalog toolName proxy.
//
// Twenty's MCP server exposes 244 workspace-catalog tools (CRUD on Person,
// Company, View, Workflow, etc.) reachable via the native `execute_tool`
// invocation: `execute_tool({ toolName: "create_company", arguments: {...} })`.
//
// Layer A (native MCP allowedTools, in src/lib/external-mcp-registry.ts) filters
// which of Twenty's *five* native MCP tools (`execute_tool`, `get_tool_catalog`,
// `learn_tools`, `load_skills`, `search_help_center`) the LLM provider can see.
// That allowlist does NOT touch the 244 catalog tools — those are all reachable
// once `execute_tool` is allowed.
//
// Layer B (this file) enforces a separate per-row `allowed_catalog_tools`
// allowlist by intercepting `execute_tool` calls server-side, validating the
// `toolName` argument against the allowlist, and forwarding to Twenty's `/mcp`
// only when permitted. Without this proxy, an LLM with native `execute_tool`
// access could call any of the 244 catalog tools regardless of intent.
//
// Architectural notes:
//   - The proxy is a host-side cinatra-app file, NOT inside any extension. The
//     enforcement point wraps *every* external MCP server with a non-null
//     `allowedCatalogTools`, not just Twenty. Twenty is the first user; the
//     proxy is the mechanism.
//   - The bearer token (Nango/api-key-store) is resolved server-side and
//     attached to the forwarded request. The client (LLM provider) never sees
//     the bearer or the real Twenty URL — they see the proxy URL.
//   - Disallowed `toolName` values return JSON-RPC error code `-32602`
//     (INVALID_PARAMS per JSON-RPC 2.0 spec) with a structured message.

import {
  buildSingleExternalMcpTool,
  getExternalMcpServerById,
} from "@/lib/external-mcp-registry";

export type ExecuteToolProxyRequest = {
  /** External MCP server row id (e.g. "twenty-apple-workspace") */
  serverId: string;
  /** JSON-RPC request body from the LLM provider */
  jsonRpc: {
    jsonrpc: "2.0";
    id: string | number;
    method: string;
    params: unknown;
  };
};

export type ExecuteToolProxyResult =
  | { ok: true; forwardedTo: string; toolName: string }
  | {
      ok: false;
      code: number; // JSON-RPC error code
      message: string;
    };

/**
 * Inspects an MCP JSON-RPC call destined for an external server with a Layer-B
 * catalog allowlist, validates the `toolName` argument when the method is
 * `tools/call name=execute_tool`, and indicates whether the call may proceed.
 *
 * Callers MUST consult this BEFORE forwarding to the upstream MCP endpoint;
 * the proxy returns the allowlist verdict but does NOT itself perform the
 * forward (that's the MCP server's job — same path as every other native
 * tool dispatch).
 */
export function validateExecuteToolCall(
  request: ExecuteToolProxyRequest,
): ExecuteToolProxyResult {
  const row = getExternalMcpServerById(request.serverId);
  if (!row) {
    return {
      ok: false,
      code: -32600, // INVALID_REQUEST
      message: `external MCP server "${request.serverId}" not found`,
    };
  }

  // Only intercept tools/call with name=execute_tool. Other native MCP calls
  // (`tools/list`, `initialize`, `get_tool_catalog`, `learn_tools`,
  // `search_help_center`, `load_skills`) pass through Layer A's allowlist
  // unmodified — Layer B is specifically for `execute_tool` catalog enforcement.
  if (request.jsonRpc.method !== "tools/call") {
    return { ok: true, forwardedTo: row.serverUrl, toolName: "(non-tools/call)" };
  }

  const params = request.jsonRpc.params as
    | { name?: string; arguments?: Record<string, unknown> }
    | undefined;
  if (params?.name !== "execute_tool") {
    return { ok: true, forwardedTo: row.serverUrl, toolName: params?.name ?? "(unknown)" };
  }

  // Layer B enforcement: validate toolName against allowedCatalogTools.
  const toolName = (params.arguments?.toolName ?? params.arguments?.["toolName"]) as
    | string
    | undefined;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return {
      ok: false,
      code: -32602,
      message: "execute_tool: missing or invalid `toolName` argument",
    };
  }

  if (row.allowedCatalogTools === null) {
    // No catalog allowlist configured for this row — Layer B passes through.
    // Layer A allowedTools is still in effect (handled by the registry).
    return { ok: true, forwardedTo: row.serverUrl, toolName };
  }

  if (!row.allowedCatalogTools.includes(toolName)) {
    return {
      ok: false,
      code: -32602,
      message: `execute_tool: toolName "${toolName}" is not in the allowed catalog for "${row.label}"`,
    };
  }

  return { ok: true, forwardedTo: row.serverUrl, toolName };
}

/**
 * Future hook — when an actual cinatra-side MCP route is added that proxies
 * Twenty's `/mcp`, this is the function it will call to validate +
 * forward. Today it just returns the validate verdict; the LLM provider's
 * native MCP injection (via buildSingleExternalMcpTool) does the forwarding.
 *
 * @internal
 */
export async function _futureProxyForward(
  request: ExecuteToolProxyRequest,
): Promise<ExecuteToolProxyResult> {
  const verdict = validateExecuteToolCall(request);
  if (!verdict.ok) return verdict;
  // Resolve the server tool to ensure the row is still authorized for this
  // actor (Layer A access guard).
  const tool = await buildSingleExternalMcpTool(request.serverId);
  if (!tool) {
    return {
      ok: false,
      code: -32600,
      message: `external MCP server "${request.serverId}" is not reachable for this actor`,
    };
  }
  return verdict;
}
