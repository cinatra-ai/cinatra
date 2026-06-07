// Unauthenticated MCP-side reachability probe.
//
// `cinatra clone start` probes `<funnelUrl>/api/mcp/health` AFTER the
// Tailscale sidecar publishes a Funnel URL, to prove the public tunnel
// can actually reach the Cinatra-side MCP plumbing. Returns 200 + a
// shape that confirms the MCP handler is wired (the route registration
// itself is the proof — there's no point round-tripping the JSON-RPC
// handler just to assert reachability).
//
// Must NOT require auth — the probe runs from the operator's host, not
// from a logged-in browser. Added to PUBLIC_API_PATHS so the Better-Auth
// route guard passes through.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    mcpHandlerWired: true,
    serverInfo: {
      name: "cinatra-mcp",
      // Static — bumped manually alongside any MCP server contract change.
      version: "0.1.0",
    },
  });
}
