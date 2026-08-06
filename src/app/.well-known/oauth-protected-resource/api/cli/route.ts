// ---------------------------------------------------------------------------
// GET /.well-known/oauth-protected-resource/api/cli — RFC 9728 protected-
// resource metadata for the `/api/cli/*` CLI control plane.
//
// Lets the CLI / OAuth SDK discover that `<origin>/api/cli` is a protected
// resource served by this instance's authorization server, and which scopes
// it understands. The CLI requests `resource=<origin>/api/cli` (RFC 8707) at
// authorize-time so the minted token is bound to the dedicated `/api/cli`
// audience — distinct from `/api/mcp` (reciprocal audience isolation).
//
// `scopes_supported` lists the EXACT CLI scopes (not a wildcard) — the AS does
// not support wildcard scopes.
//
// ADVERTISED ORIGINS (cinatra#2478). The URLs in this document are what a
// client dials next, so they must be the PUBLIC origin, not whatever internal
// address this process happens to be reached at.
//
// This route derived them from raw `new URL(request.url).origin`. Behind an
// nginx `proxy_pass` that does not preserve the client `Host`, that origin is
// the app's own bind address, and the document advertised
// `https://0.0.0.0:3102/api/cli` — reported out of cinatra-cli#204 and
// re-measured on the deployed instance 2026-08-06, where the SAME request
// showed the two origins diverging: `request.url` pinned at
// `https://0.0.0.0:3102` (invariant even to an injected `x-forwarded-host`)
// while the `/api/mcp` sibling, which reads the forwarded pair, correctly
// returned `https://cinatra.ossflywheel.com`. Unusable discovery output — which
// is why that CLI hard-codes the `/api/auth` mount instead of discovering it.
//
// The response therefore goes through `rewriteJsonOriginResponse`, the SAME
// treatment the sibling authorization-server-metadata route already applies,
// which takes the public origin from the same trusted source
// (`x-forwarded-proto` + `x-forwarded-host` when both are present, the request
// URL's own origin otherwise). Stripping client-supplied forwarded headers
// remains the reverse proxy's job — this route adopts the trust policy the
// `/api/mcp`, authorization-server, and OpenID-configuration documents already
// apply, it does not invent a new one.
//
// Imported from the leaf `@cinatra-ai/mcp-server/origin-rewrite` subpath, not
// the barrel: the leaf is app-graph-free, so this route module stays directly
// loadable (the `__tests__` sibling exercises the real rewrite, not a stub).
// ---------------------------------------------------------------------------

import { CLI_SCOPES } from "@cinatra-ai/mcp-server/auth-plugins";
import { rewriteJsonOriginResponse } from "@cinatra-ai/mcp-server/origin-rewrite";

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

export async function GET(request: Request): Promise<Response> {
  const requestOrigin = requestUrlOrigin(request);
  const metadata = {
    resource: `${requestOrigin ?? fallbackOrigin()}${CLI_BASE_PATH}`,
    authorization_servers: [`${requestOrigin ?? fallbackOrigin()}${AUTH_BASE_PATH}`],
    scopes_supported: [...CLI_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cinatra CLI control plane",
  };
  const response = Response.json(metadata, { status: 200, headers: corsHeaders() });

  // `rewriteJsonOriginResponse` derives the origin to rewrite FROM out of
  // `request.url` itself. When that URL does not parse there is nothing to
  // rewrite from, so the configured-fallback document is served as-is rather
  // than letting the shared helper throw on the same malformed URL.
  //
  // Unreachable via a conforming Next.js request (the server always hands a
  // handler an absolute URL). It is carried forward, not newly introduced —
  // the pre-#2478 route had the same fallback — so this change does not decide
  // that question either way. It is deliberately NOT presented as proxy-shape
  // support: this branch skips forwarded-origin inference entirely.
  return requestOrigin === null ? response : rewriteJsonOriginResponse({ request, response });
}

/** The request URL's own origin, or `null` when `request.url` does not parse. */
function requestUrlOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

function fallbackOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ??
    "http://localhost:3000"
  );
}
