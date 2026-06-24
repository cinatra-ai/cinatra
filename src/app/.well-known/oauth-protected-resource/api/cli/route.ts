// ---------------------------------------------------------------------------
// GET /.well-known/oauth-protected-resource/api/cli — RFC 9728 protected-
// resource metadata for the `/api/cli/*` CLI control plane (eng#231).
//
// Lets the CLI / OAuth SDK discover that `<origin>/api/cli` is a protected
// resource served by this instance's authorization server, and which scopes
// it understands. The CLI requests `resource=<origin>/api/cli` (RFC 8707) at
// authorize-time so the minted token is bound to the dedicated `/api/cli`
// audience — distinct from `/api/mcp` (reciprocal audience isolation).
//
// `scopes_supported` lists the EXACT CLI scopes (not a wildcard) — the AS does
// not support wildcard scopes.
// ---------------------------------------------------------------------------

import { CLI_SCOPES } from "@cinatra-ai/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLI_BASE_PATH = "/api/cli";
const AUTH_BASE_PATH = "/api/auth";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
  };
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function GET(request: Request): Response {
  const origin = safeOrigin(request);
  const metadata = {
    resource: `${origin}${CLI_BASE_PATH}`,
    authorization_servers: [`${origin}${AUTH_BASE_PATH}`],
    scopes_supported: [...CLI_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cinatra CLI control plane",
  };
  return Response.json(metadata, { status: 200, headers: corsHeaders() });
}

function safeOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return (
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ??
      "http://localhost:3000"
    );
  }
}
