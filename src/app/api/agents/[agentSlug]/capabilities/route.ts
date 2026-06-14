import { NextResponse } from "next/server";

import { resolveWidgetStreamAgent } from "@/lib/widget-stream-agents.server";
import { buildCapabilities } from "@/lib/widget-capabilities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The local widget fetches this cross-origin at boot. CORS headers are REQUIRED:
// without them the browser blocks the response, which the widget treats as a
// negotiation failure and refuses to mount (showing the unavailable chrome). The
// body is fully-public static contract metadata (no instance data, no secret),
// so a wildcard allow-origin is appropriate and avoids reading any instance
// config here. No credentials are used; GET is the only data method.
const CAPABILITIES_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Capability + version negotiation endpoint (cinatra#220).
//
// GET /api/agents/{agentSlug}/capabilities. AUTH-FREE: returns ONLY static
// contract metadata (supported contract versions + boolean capability flags +
// the frozen SSE frame list + the stream/token sibling paths). It leaks NO
// instance data, NO auth config keys, NO package names, NO extension internals
// — see src/lib/widget-capabilities.ts. The two exact capability paths are on
// the middleware public-path allowlist (GENERATED_WIDGET_STREAM_CAPABILITY_PATHS)
// so the session redirect is suppressed.
//
// A locally-shipped widget calls this once at boot as a HARD PREREQUISITE: it
// picks the highest mutually-supported contract version and gates optional UX
// (apply-changes, markdown) on the returned forward flags. Any failure to fetch
// or validate this response — 404 / 5xx / network / timeout / malformed JSON /
// no mutual version / supportsTokenExchange !== true — makes the widget
// UNAVAILABLE; there is NO optimistic default and NO legacy long-lived fallback.
// (An UNKNOWN agent slug still returns 404 here; that is a server-side not-found,
// which the client likewise treats as unavailable.)
// ---------------------------------------------------------------------------

export async function OPTIONS(
  _request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 200, headers: CAPABILITIES_CORS_HEADERS });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) {
    return NextResponse.json(
      { error: "Unknown agent" },
      { status: 404, headers: CAPABILITIES_CORS_HEADERS },
    );
  }
  return NextResponse.json(buildCapabilities(agentSlug), {
    status: 200,
    headers: CAPABILITIES_CORS_HEADERS,
  });
}
