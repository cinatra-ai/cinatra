import "server-only";
import { NextResponse } from "next/server";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import {
  resolveWayflowUrl,
  WAYFLOW_UNDICI_TIMEOUT_MS,
} from "@cinatra-ai/agents/wayflow-url";

// ---------------------------------------------------------------------------
// /api/a2a/agents/[...slug] — WayFlow A2A proxy by vendor/slug
//
// WayFlow A2AAgent stubs in agents/<vendor>/<slug>/cinatra/agent.json declare
//   agent_url: "{{CINATRA_BASE_URL}}/api/a2a/agents/{vendor}/{slug}"
// This proxy extracts the first two path segments, composes
//   `${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/`
// via the canonical resolveWayflowUrl helper, and forwards:
//   - POST: A2A JSON-RPC envelope verbatim (opaque to the proxy).
//   - GET:  agent-card discovery — strips both proxy segments so upstream
//           sees /.well-known/agent-card.json.
//
// The route uses Next.js catch-all (`[...slug]`) so multi-segment URLs like
// `/api/a2a/extensions/cinatra-ai/email-outreach-agent/.well-known/agent-card.json`
// reach the handler instead of 404'ing at the route segment match. Vendor +
// slug are always the first two segments; trailing segments are preserved
// by the GET prefix-strip regex when forwarding upstream.
//
// Fewer than 2 path segments → 404. Malformed packageName → 502 (resolver
// throw text). Upstream throw → 502.
//
// Auth: same X-Cinatra-Bridge-Token shared-secret used by /api/llm-bridge.
// Both POST and GET reject with 403 when the gate fails. The auth gate runs
// BEFORE the segment-count check so unauthorized requests cannot probe for
// route existence.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared timeout constant + lazy dispatcher init.
//
// WAYFLOW_UNDICI_TIMEOUT_MS lives in @cinatra-ai/agents/wayflow-url
// so this route and execution.ts stay in lockstep with the WayFlow blocking
// cap (currently 720s). A future tuning of the cap requires editing one
// place rather than hunting through call sites.
//
// Module-level instantiation creates a global undici Agent pool that
// is never closed; under Turbopack hot-reload and test re-imports this
// piles up sockets in TIME_WAIT. Lazy-init via `getWayflowAgent()` so each
// module reload only allocates on first request rather than at import time.
// We deliberately do NOT export a closer — Next.js route files reject
// arbitrary named exports. Tests that need to drop the pool can do so via
// the shared dispatcher exported from packages/agents/src/execution.ts.
let _wayflowAgent: UndiciAgent | null = null;
function getWayflowAgent(): UndiciAgent {
  return (_wayflowAgent ??= new UndiciAgent({
    headersTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
    bodyTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
  }));
}

const SEGMENT_ERROR_BODY = {
  error:
    "URL must include vendor and agent slug, e.g. /api/a2a/agents/<vendor>/<slug>",
};

// Cap inbound body to 1 MB. A2A JSON-RPC envelopes are
// well under 10 KB; 1 MB leaves headroom for unusual payloads while bounding
// worker memory. The Content-Length precheck only rejects honest clients —
// chunked-encoding requests have no Content-Length and a lying Content-Length
// header is not validated against actual bytes received. The race timeout
// below provides a complementary slow-loris bound; full streaming-byte
// enforcement is deferred (would require switching from req.text() to
// req.body.getReader() with a manual byte counter).
const MAX_INBOUND_BODY_BYTES = 1_000_000;

// Best-effort inbound read timeout. The undici Agent's
// bodyTimeout (WAYFLOW_UNDICI_TIMEOUT_MS = 720s) only governs OUTBOUND fetches;
// it does not bound `req.text()`. Race req.text() against a 60s timer so a
// slow-loris client cannot hold a worker arbitrarily long. For honest clients
// the body read is bounded by MAX_INBOUND_BODY_BYTES; for dishonest clients
// the worker still returns within 60s (the original req.text() may continue
// in the background until the socket closes, but produces no further effect).
const INBOUND_BODY_TIMEOUT_MS = 60_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  // Auth gate. Same shared-secret contract as /api/llm-bridge. Runs
  // BEFORE the segment-count check so 403 takes precedence over 404 for
  // unauthenticated probes.
  if (!isAuthorizedBridgeRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { slug: slugSegments } = await params;
  if (slugSegments.length < 2) {
    return NextResponse.json(SEGMENT_ERROR_BODY, { status: 404 });
  }
  const [vendor, slug] = slugSegments;
  let wayflowUrl: string;
  try {
    wayflowUrl = resolveWayflowUrl(`@${vendor}/${slug}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Content-Length precheck returns 413 before allocating. Reject honest
  // oversize clients (and negative-Content-Length oddities) upfront.
  const contentLengthHeader = req.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_INBOUND_BODY_BYTES
  ) {
    return NextResponse.json(
      {
        error: "Body too large",
        limit: MAX_INBOUND_BODY_BYTES,
        received: contentLength,
      },
      { status: 413 },
    );
  }

  // Race req.text() against a 60s timer. The original req.text() promise
  // will keep reading in the background if the timer wins, but the worker
  // returns promptly and the body is bounded by MAX_INBOUND_BODY_BYTES (for
  // honest clients). Always clear the timer to avoid leaking a Node timer
  // handle on the success path.
  let body: string;
  let inboundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    body = await Promise.race<string>([
      req.text(),
      new Promise<never>((_, reject) => {
        inboundTimer = setTimeout(
          () => reject(new Error("inbound body timeout")),
          INBOUND_BODY_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "inbound body timeout") {
      return NextResponse.json(
        { error: "Inbound body timeout", limitMs: INBOUND_BODY_TIMEOUT_MS },
        { status: 408 },
      );
    }
    throw err;
  } finally {
    if (inboundTimer !== undefined) clearTimeout(inboundTimer);
  }

  // Forward an allowlisted set of
  // inbound headers. Strip hop-by-hop and the bridge token (must NOT leak
  // to upstream).
  const fwdHeaders: Record<string, string> = {};
  const ct = req.headers.get("content-type");
  fwdHeaders["Content-Type"] = ct ?? "application/json";
  const accept = req.headers.get("accept");
  if (accept) fwdHeaders["Accept"] = accept;
  for (const [k, v] of req.headers.entries()) {
    // Forward all X-Cinatra-* headers EXCEPT the bridge token (don't leak upstream).
    if (k.startsWith("x-cinatra-") && k !== "x-cinatra-bridge-token") {
      fwdHeaders[k] = v;
    }
  }

  try {
    const upstream = await undiciFetch(wayflowUrl, {
      method: "POST",
      headers: fwdHeaders,
      body,
      dispatcher: getWayflowAgent(),
    });
    const upstreamBody = await upstream.text();
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[a2a-proxy] upstream error for vendor=${vendor} slug=${slug}:`,
      message,
    );
    return NextResponse.json(
      { error: "Upstream service unavailable" },
      { status: 502 },
    );
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
  // Auth gate. Same shared-secret contract as /api/llm-bridge.
  if (!isAuthorizedBridgeRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { slug: slugSegments } = await params;
  if (slugSegments.length < 2) {
    return NextResponse.json(SEGMENT_ERROR_BODY, { status: 404 });
  }
  const [vendor, slug] = slugSegments;
  let wayflowUrl: string;
  try {
    wayflowUrl = resolveWayflowUrl(`@${vendor}/${slug}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Strip the proxy prefix so upstream sees a path starting at root.
  // e.g. /api/a2a/extensions/cinatra-ai/email-recipient-selection-agent/.well-known/agent-card.json
  //   -> /.well-known/agent-card.json
  // wayflowUrl already includes a trailing slash + the mount prefix
  // /agents/<vendor>/<slug>/, so the upstreamPath must be root-relative when
  // appended without producing a double slash.
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(
    /^\/api\/a2a\/agents\/[^/]+\/[^/]+/,
    "",
  );
  // Avoid double slash when joining: wayflowUrl ends with "/", upstreamPath
  // starts with "/" (or is empty).
  const baseNoTrail = wayflowUrl.replace(/\/+$/, "");
  const upstreamUrl = `${baseNoTrail}${upstreamPath}${url.search}`;
  try {
    const upstream = await undiciFetch(upstreamUrl, {
      method: "GET",
      dispatcher: getWayflowAgent(),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[a2a-proxy] upstream error for vendor=${vendor} slug=${slug}:`,
      message,
    );
    return NextResponse.json(
      { error: "Upstream service unavailable" },
      { status: 502 },
    );
  }
}
