import { NextResponse } from "next/server";

import {
  resolveWidgetStreamAgent,
  resolveContentEditorRelay,
} from "@/lib/widget-stream-agents.server";
import { dispatchContentEditorViaA2A } from "@/lib/host-content-editor-dispatch";
import {
  resolveWidgetStreamOrigin,
  validateWidgetStreamToken,
  buildWidgetStreamCorsHeaders,
} from "@/lib/widget-stream-auth";
import {
  consumeWidgetStreamToken,
  isLongLivedTokenPathEnabled,
} from "@/lib/widget-token-broker";
import { validateAuthInitRequest } from "@/lib/wp-drupal-contract";

// Sunset date advertised on the deprecated long-lived path (RFC 1123). The
// legacy path serves only un-upgraded field installs; once a plugin/module
// ships the local broker the browser never holds the long-lived key. This is a
// soft, advisory date (Phase 3 removal is a later major) the local widget reads
// to surface a one-line admin notice — adjust as the migration window firms up.
const LONG_LIVED_SUNSET = "Thu, 31 Dec 2026 23:59:59 GMT";
const SHORT_LIVED_TOKEN_PREFIX = "cit_";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Generic per-agent widget SSE stream. Registration is MANIFEST-DRIVEN: a
// widget-bearing extension declares `cinatra.widgetStream` (agentSlug, label,
// subjectNoun, contextFields, auth policy) and this route resolves it
// generically. Adding a widget-stream extension requires NO edit to this file
// (or to the auth-route-guard — its public-path list is generated from the same
// declarations); a content-editor relay target is the one per-agent fact, kept
// in resolveContentEditorRelay (widget-stream-agents.server.ts).
//
// Auth: route-level CORS Origin allowlist + Bearer token, both driven by the
// entry's declared auth policy (instances config key + validity fields, token
// config key). The route's path is whitelisted via the generated
// PUBLIC_AGENT_STREAM_PATHS in src/lib/auth-route-guard.ts so unauthenticated
// browser widgets reach this handler instead of being redirected to /sign-in.
//
// ARCHITECTURE (cinatra#246): this route is a RELAY, not an LLM. It forwards the
// user's prompt + trusted CMS context to the respective content-editor agent
// (wordpress-content-editor / drupal-content-editor) over A2A and streams the
// agent's reply back. THE AGENT is the single LLM: it has the cinatra MCP
// server injected and is steered by its SKILL.md to call the read/update
// primitives. The host runs NO LLM here and exposes NO function tool — the
// prior host-LLM + `*_content_editor_run` function tool both violated the
// "no function call for an MCP tool" rule and let the agent recurse into its own
// dispatcher. SSE wire format on the widget side is FROZEN: text/changes/error/
// done frames only, and the `changes` frame keeps its `fields`/`nodeId`/`postId`
// shape.
// ---------------------------------------------------------------------------

type StreamRequestBody = {
  contractVersion?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context?: Record<string, unknown>;
};

// Strip Markdown code fences from agent-emitted JSON before parse. The
// content-editor agent's LLM occasionally wraps its JSON output in ```json ...
// ``` fences; the regex only matches at string boundaries so internal triplets
// survive. (Mirrors the connector's prior stripCodeFences.)
function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function OPTIONS(
  request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) return new NextResponse(null, { status: 404 });
  const allowed = resolveWidgetStreamOrigin(request.headers.get("Origin"), entry.auth);
  if (!allowed) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 200, headers: buildWidgetStreamCorsHeaders(allowed) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) {
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }

  // CORS is RESPONSE-HEADER POLICY only — never the authorization mechanism.
  // We resolve the request Origin against the configured-instance allowlist to
  // SOURCE the reflected `Access-Control-Allow-Origin` header (and to keep the
  // legacy long-lived path's defense-in-depth pre-gate). The AUTHORITATIVE gate
  // is the Bearer token, handled per-path below — for the `cit_` path the
  // origin authority is the TOKEN-BOUND origin (checked inside
  // consumeWidgetStreamToken), not this header.
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigin = resolveWidgetStreamOrigin(requestOrigin, entry.auth);
  // Reflect the configured origin when known; otherwise fall back to the raw
  // request Origin so a client still receives readable CORS headers on an error
  // response. A non-configured origin is rejected by the token gate below, not
  // by withholding CORS headers (CORS is not the authz boundary).
  const corsHeaders = buildWidgetStreamCorsHeaders(allowedOrigin ?? requestOrigin ?? "");

  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // Discriminate by Bearer prefix.
  if (bearer.startsWith(SHORT_LIVED_TOKEN_PREFIX)) {
    // ----- SHORT-LIVED PATH (preferred). The token is authoritative: it binds
    // origin/aud/scope/expiry and is re-checked against the STORED row + live
    // config. CORS plays no part in this decision.
    const consumed = consumeWidgetStreamToken({
      token: bearer,
      agentSlug,
      auth: entry.auth,
      routePath: `/api/agents/${agentSlug}/stream`,
      requestOrigin,
    });
    if (!consumed.ok) {
      console.warn(`[agent-stream:${agentSlug}] short-lived token rejected:`, consumed.reason);
      return new NextResponse("Unauthorized", { status: 401, headers: corsHeaders });
    }
  } else {
    // ----- LEGACY LONG-LIVED PATH (back-compat, DEPRECATED). The browser holds
    // the long-lived integration key directly. Retain the configured-origin
    // pre-gate as defense-in-depth (a non-configured origin → 403).
    if (!allowedOrigin) {
      console.warn(`[agent-stream:${agentSlug}] Origin not allowed:`, requestOrigin);
      return new NextResponse("Origin not allowed", { status: 403, headers: corsHeaders });
    }
    // Phase-2 kill switch: an operator may disable the legacy path entirely.
    if (!isLongLivedTokenPathEnabled(entry.auth)) {
      return new NextResponse(
        "The long-lived integration key is no longer accepted for this integration. " +
          "Upgrade the Cinatra plugin/module to use short-lived token exchange.",
        { status: 403, headers: corsHeaders },
      );
    }
    if (!bearer || !validateWidgetStreamToken(bearer, entry.auth)) {
      return new NextResponse("Unauthorized", { status: 401, headers: corsHeaders });
    }
    // Phase-1 deprecation signal: warn + advertise Deprecation/Sunset (exposed
    // via CORS) so the local widget surfaces a one-line admin notice.
    console.warn(
      `[agent-stream:${agentSlug}] long-lived integration key used directly — deprecated, migrate to token exchange`,
    );
    corsHeaders.Deprecation = "true";
    corsHeaders.Sunset = LONG_LIVED_SUNSET;
  }

  let body: StreamRequestBody;
  try {
    body = (await request.json()) as StreamRequestBody;
  } catch {
    return new NextResponse("Invalid JSON body", { status: 400, headers: corsHeaders });
  }

  // Versioned plugin↔core contract gate. Rejects an explicitly-present unknown
  // contractVersion (and a non-conforming versioned body) with a structured,
  // admin-visible 400 — never a 500 — so the CMS admin sees an actionable
  // message in the widget panel. Unversioned legacy callers are not blocked.
  const contractCheck = validateAuthInitRequest(body);
  if (!contractCheck.ok) {
    return NextResponse.json(
      { error: contractCheck.error },
      { status: 400, headers: corsHeaders },
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new NextResponse("messages array required", { status: 400, headers: corsHeaders });
  }

  const context = body.context ?? {};

  // Resolve the relay target (content-editor agent A2A URL + package name) for
  // this slug. A widget-stream agent with no relay configured is a wiring error
  // the admin must see as a clean JSON 500, not a half-opened stream.
  const relay = resolveContentEditorRelay(agentSlug);
  if (!relay) {
    console.error(`[agent-stream:${agentSlug}] no content-editor relay configured for slug`);
    return NextResponse.json(
      { error: "This widget agent has no content-editor relay configured" },
      { status: 500, headers: corsHeaders },
    );
  }

  // The editing instruction is the latest user message. Trusted CMS context
  // (instanceId, postId, …) comes from the AUTHENTICATED request body — there is
  // no model in this path, so there are no model-supplied identity fields to
  // override. Sanitize string context (strip CR/LF/tabs, bound length) the same
  // way the prior system-prompt path did, then forward the declared
  // contextFields plus the instruction as the A2A payload the agent's SKILL.md
  // reads. Undeclared keys are filtered by the agent loader.
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const instructions = typeof lastUser?.content === "string" ? lastUser.content : "";

  const safe = (s: unknown, max = 500): string =>
    String(s ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, max);

  const payload: Record<string, unknown> = { instructions };
  for (const field of entry.contextFields) {
    const value = context[field.key];
    if (value === undefined || value === null) continue;
    payload[field.key] =
      typeof value === "string" ? safe(value, field.maxLength) : value;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: string, data: unknown): void {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // RELAY: blocking A2A dispatch to the content-editor agent. The host
        // helper pre-creates the OBO-carrier agent_run (cinatra#246) so the
        // agent's downstream `/api/mcp` CMS write authorizes via the real
        // agent-run OBO path, then walks the agent's reply for its final text.
        const text = await dispatchContentEditorViaA2A({
          agentUrl: relay.agentUrl,
          payload,
          timeoutMs: 300_000, // aligned with the /chat blocking budget
          packageName: relay.agentPackageName,
        });

        // Parse the agent's reply. A structured `{ postId|nodeId, changes[] }`
        // edit emits a `changes` frame (the widget's reload-to-apply path); a
        // text-only reply (or non-JSON) is surfaced as a `text` frame. The
        // text-fallback shape `{ result: <text> }` is JSON too, so gate the
        // `changes` frame on a real `changes` array.
        let parsed:
          | {
              nodeId?: string | number;
              postId?: string | number;
              changes?: Array<{ field: string; before: string; after: string }>;
              result?: string;
            }
          | undefined;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch {
          parsed = undefined; // reply wasn't JSON — treat as plain text below
        }

        if (parsed && Array.isArray(parsed.changes)) {
          send("changes", {
            fields: parsed.changes,
            nodeId: String(parsed.nodeId ?? ""),
            postId: String(parsed.postId ?? ""), // Pitfall 6 — always String()
          });
          send("done", {});
        } else if (parsed && typeof parsed.result === "string" && parsed.result.trim()) {
          // Agent emitted the text-fallback shape `{ result: <text> }` — surface
          // the inner text, NOT the raw JSON wrapper.
          send("text", { content: parsed.result.trim() });
          send("done", {});
        } else if (!parsed && text.trim()) {
          // Non-JSON conversational reply — surface as a single text frame.
          send("text", { content: text.trim() });
          send("done", {});
        } else {
          // No usable reply (empty, or unexpected structured JSON with neither
          // changes[] nor result) — drop the empty assistant turn from widget
          // history rather than dumping raw JSON (Pitfall 5).
          send("done", { fallback: true });
        }
      } catch (err) {
        const internalMessage = err instanceof Error ? err.message : String(err);
        console.error(`[agent-stream:${agentSlug}] relay failed:`, internalMessage);
        // Sanitize the user-facing error.
        send("error", {
          message: "An error occurred processing your request. Please try again.",
        });
        send("done", { fallback: true }); // Pitfall 5 — drop empty turn
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
