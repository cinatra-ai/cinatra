import "server-only";

// Generic Layer B proxy for external MCP servers with a dispatcher tool
// (e.g. Twenty's `execute_tool` that opens 244 catalog tools, or any other
// external MCP server with similar shape).
//
// Why this exists:
//   - Native MCP `allowedTools` (Layer A) only restricts the 5 native tools
//     of a dispatcher server. Once `execute_tool` is allowed, any of the
//     244 catalog tools is reachable through it — bypassing any intended
//     per-row tool restrictions.
//   - This proxy intercepts the JSON-RPC `tools/call name=execute_tool`
//     pattern, validates the `toolName` argument against the row's
//     `allowed_catalog_tools` allowlist, and forwards to the upstream
//     `/mcp` ONLY when validation passes.
//   - The proxy URL is what gets injected to the LLM provider, NOT the raw
//     `row.serverUrl`. That makes the catalog allowlist unbypassable from
//     the LLM side — the LLM has no way to discover or reach the upstream
//     directly.

import type { NextRequest } from "next/server";

import { validateExecuteToolCall } from "@/lib/external-mcp/twenty-execute-tool-proxy";
import {
  getExternalMcpServerById,
  resolveExternalMcpServerBearer,
} from "@/lib/external-mcp-registry";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    },
    { status: 200 },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ serverId: string }> },
): Promise<Response> {
  const { serverId } = await ctx.params;

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }

  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id ?? null, -32600, "invalid JSON-RPC request");
  }

  const row = getExternalMcpServerById(serverId);
  if (!row) {
    return jsonRpcError(body.id, -32600, `unknown server: ${serverId}`);
  }
  if (!row.enabled) {
    return jsonRpcError(body.id, -32600, `server disabled: ${serverId}`);
  }

  // Layer B validation: gate `tools/call name=execute_tool` against the
  // row's allowed_catalog_tools. Non-execute_tool methods pass through.
  const verdict = validateExecuteToolCall({
    serverId,
    jsonRpc: {
      jsonrpc: body.jsonrpc,
      id: body.id,
      method: body.method,
      params: body.params,
    },
  });
  if (!verdict.ok) {
    return jsonRpcError(body.id, verdict.code, verdict.message);
  }

  // Resolve the upstream bearer server-side. The LLM provider never sees it.
  const bearer = await resolveExternalMcpServerBearer(row);

  const upstreamHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer) upstreamHeaders.authorization = `Bearer ${bearer}`;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(row.serverUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return jsonRpcError(
      body.id,
      -32603,
      `upstream MCP fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "application/json";
  const responseBody = await upstreamResponse.text();
  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { "content-type": contentType },
  });
}
