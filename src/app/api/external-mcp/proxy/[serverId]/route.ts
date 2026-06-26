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
//
// Authorization (fail-closed, enforced server-side BEFORE the stored upstream
// bearer is resolved or any request is forwarded):
//   1. A VALIDATED Better Auth session is required. Cookie presence (the
//      global middleware's only check) is not authentication — `getActorContext`
//      validates the session and resolves an ActorContext, returning undefined
//      for a forged/expired/absent session. No session => 401, and we do not
//      leak row existence.
//   2. `guardConnectorAccess(row.id, actor)` enforces tenant/ownership/role
//      visibility through the canonical authorization kernel — the SAME path
//      the intended LLM-injection flow uses (external-mcp-registry.ts). Deny
//      => 403, before bearer resolution.
//   3. Native `allowedTools` (Layer A) is re-enforced at the proxy boundary
//      for every `tools/call` — the LLM provider could be pointed at this
//      route directly, so we cannot rely on injection-time filtering alone.
//   4. JSON-RPC batch arrays, notifications, and non-tool methods are
//      explicitly allowlisted rather than passed through.

import type { NextRequest } from "next/server";

import { getActorContext } from "@/lib/auth-session";
import { CONNECTOR_ACCESS_DENIED, guardConnectorAccess } from "@/lib/connectors-scope-guard";
import { validateExecuteToolCall } from "@/lib/external-mcp/twenty-execute-tool-proxy";
import {
  getExternalMcpServerById,
  resolveExternalMcpServerBearer,
  type ExternalMcpServerRecord,
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

// Methods that carry no upstream credential exposure / catalog reach and may
// pass through once the actor is authorized for the row. `tools/call` is NOT
// here — it is gated explicitly below against native `allowedTools` and the
// Layer-B catalog allowlist.
const PASSTHROUGH_METHODS = new Set<string>([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
]);

/**
 * Re-enforce native Layer-A `allowedTools` at the proxy boundary. The LLM
 * provider — or any caller — could POST a `tools/call` for a native tool the
 * row never allowed; injection-time filtering does not protect this route.
 *
 * Returns null when the method/tool is permitted, or a JSON-RPC error Response
 * when it must be rejected (fail-closed).
 */
function enforceNativeAllowedTools(
  body: JsonRpcRequest,
  row: ExternalMcpServerRecord,
): Response | null {
  // Only `tools/call` reaches a named tool; everything else is gated by the
  // PASSTHROUGH allowlist at the call site.
  if (body.method !== "tools/call") return null;

  const params = body.params as { name?: unknown } | undefined;
  const toolName = params?.name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return jsonRpcError(body.id, -32602, "tools/call: missing or invalid `name`");
  }

  // null `allowedTools` => no native restriction configured for this row;
  // Layer-B catalog enforcement (below) still applies. A non-null allowlist
  // is enforced strictly: anything not listed is rejected, fail-closed.
  if (row.allowedTools !== null && !row.allowedTools.includes(toolName)) {
    return jsonRpcError(
      body.id,
      -32601,
      `tool "${toolName}" is not in the allowed tools for "${row.label}"`,
    );
  }

  return null;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ serverId: string }> },
): Promise<Response> {
  const { serverId } = await ctx.params;

  // --- AuthN: require a VALIDATED session, not mere cookie presence. ---
  // getActorContext resolves an ActorContext from a validated Better Auth
  // session and returns undefined when there is no valid session. We reject
  // BEFORE looking up or revealing anything about the row.
  const actor = await getActorContext().catch(() => undefined);
  if (!actor) {
    // Plain HTTP 401 — do not emit a JSON-RPC error envelope (which is 200)
    // and do not leak whether the serverId exists.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }

  // Explicitly reject JSON-RPC batch arrays. The proxy enforces per-call
  // authorization and a batch would smuggle un-gated calls; deny rather than
  // pass through.
  if (Array.isArray(parsed)) {
    return jsonRpcError(null, -32600, "JSON-RPC batch requests are not supported");
  }

  const body = parsed as JsonRpcRequest;
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

  // --- AuthZ: tenant/ownership/role visibility via the canonical kernel,
  // BEFORE the stored upstream bearer is resolved. Mirrors the intended
  // LLM-injection path in external-mcp-registry.ts. Fail-closed. ---
  try {
    await guardConnectorAccess(row.id, actor);
  } catch (guardErr) {
    const code = (guardErr as Error & { code?: string }).code;
    if (code === CONNECTOR_ACCESS_DENIED || code === "ACTOR_CONTEXT_MISSING") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    // Unexpected guard failure: fail closed.
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Method allowlist: only known-safe methods, `tools/call`, pass beyond here.
  // Notifications and unknown methods are denied rather than forwarded.
  if (body.method !== "tools/call" && !PASSTHROUGH_METHODS.has(body.method)) {
    return jsonRpcError(body.id, -32601, `method not supported by proxy: ${body.method}`);
  }

  // Layer A re-enforcement at the proxy boundary: native `allowedTools`.
  const nativeVerdict = enforceNativeAllowedTools(body, row);
  if (nativeVerdict) return nativeVerdict;

  // Layer B validation: gate `tools/call name=execute_tool` against the
  // row's allowed_catalog_tools.
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

  // Resolve the upstream bearer server-side. The LLM provider never sees it,
  // and we only reach here for an authenticated + authorized caller.
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
