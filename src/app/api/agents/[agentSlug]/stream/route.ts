import { NextResponse } from "next/server";

import {
  stream as orchestrateStream,
  buildSkillTools,
} from "@cinatra-ai/llm";
import type { LlmTool } from "@cinatra-ai/llm";
import { ensureSkillForCapability } from "@cinatra-ai/skills";

import {
  resolveWidgetStreamAgent,
  buildWidgetChatTool,
} from "@/lib/widget-stream-agents.server";
import { ExtensionModuleAbsentError } from "@/lib/extension-load-guard";
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
// subjectNoun, skillCapability, contextFields, auth policy) and ships a
// `widget-chat-tool` factory; the generated manifest carries the slug-keyed
// entry and this route resolves it generically. Adding a widget-stream
// extension requires NO edit to this file (or to the auth-route-guard — its
// public-path list is generated from the same declarations).
//
// Auth: route-level CORS Origin allowlist + Bearer token, both driven by the
// entry's declared auth policy (instances config key + validity fields, token
// config key). The route's path is whitelisted via the generated
// PUBLIC_AGENT_STREAM_PATHS in src/lib/auth-route-guard.ts so unauthenticated
// browser widgets reach this handler instead of being redirected to /sign-in.
//
// The route calls stream with the extension's widget-chat function tool and
// skill tool (resolved + self-healed through the generic
// extension-skill-resolver via the declared skillCapability). The LLM decides
// whether to chat conversationally or call the content-editor tool.
// SSE wire format on the widget side is FROZEN: text/changes/error/done frames
// only, and the `changes` frame keeps its `fields`/`nodeId`/`postId` shape.
// ---------------------------------------------------------------------------

type StreamRequestBody = {
  contractVersion?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context?: Record<string, unknown>;
};

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

  // Resolve the skill THROUGH the declared capability key (generic
  // extension-skill-resolver: maps the capability to the active skill-bearing
  // extension and lazily registers its SKILL.md — the prod self-heal). The
  // skill may be co-located in the connector itself or in a sibling skill
  // package, hence both kinds are allowed. FAIL LOUD pre-SSE: no active
  // extension providing the capability is a configuration/install error the
  // admin must see as a clean JSON 500, not an aborted half-opened stream.
  let skillId: string;
  try {
    skillId = await ensureSkillForCapability(entry.skillCapability, {
      allowKinds: ["skill", "connector"],
    });
  } catch (err) {
    console.error(`[agent-stream:${agentSlug}] skill capability resolution failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to resolve widget skill" },
      { status: 500, headers: corsHeaders },
    );
  }

  // Build the extension's widget-chat function tool from the manifest loader
  // entry. FAIL LOUD pre-SSE (import/factory/shape errors are host wiring
  // bugs, not user errors — surface them as a clean 500). ONE deliberate
  // exception (cinatra#7): an ABSENT optional widget module (typed
  // ExtensionModuleAbsentError from the guarded loader) is a legitimate
  // post-build state, not a wiring bug — degrade to a defined 503 so the
  // embedding CMS widget sees "temporarily unavailable", never a generic 500.
  let tool;
  try {
    tool = await buildWidgetChatTool(agentSlug, entry, context);
  } catch (err) {
    if (err instanceof ExtensionModuleAbsentError) {
      console.warn(
        `[agent-stream:${agentSlug}] widget-chat tool module is absent post-build — degrading to 503:`,
        err.message,
      );
      return NextResponse.json(
        { error: "This widget's extension is not available on this deployment" },
        { status: 503, headers: corsHeaders },
      );
    }
    console.error(`[agent-stream:${agentSlug}] widget-chat tool build failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build widget tool" },
      { status: 500, headers: corsHeaders },
    );
  }

  // Sanitize client-supplied context strings before embedding in the system
  // prompt. Strips CR/LF/tabs (so attacker-controlled strings can't add
  // fake instructions on a new line) and bounds length (so a 1MB href can't
  // dominate the system-prompt window). The factory tool path uses identity
  // override on its own and is unaffected — this sanitiser is for
  // system-prompt embedding only.
  const safe = (s: unknown, max = 200): string =>
    String(s ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, max);

  // Build the system prompt with explicit CMS context from the declared
  // contextFields. Full routing rules live in the SKILL.md the LLM reads via
  // the skill tool.
  const cmsContextBlock =
    `\n\nCurrent ${entry.label} context:\n` +
    entry.contextFields
      .map((field) => `- ${field.key}: ${safe(context[field.key], field.maxLength)}\n`)
      .join("");

  const systemPrompt =
    `You are the Cinatra in-CMS assistant embedded in a ${entry.label} content editor. ` +
    `Read the widget-chat skill using the provided skill tool for routing rules. ` +
    `When the user asks for any change to the current ${entry.subjectNoun}, ` +
    `call the content-editor tool with their instructions. ` +
    `When the user is conversational (greeting, question, discussion), answer directly without calling tools. ` +
    `Never paste tool-result JSON into your reply — write a natural-language summary instead.` +
    cmsContextBlock;

  // Build the tools array. Use ONLY the single function tool plus skill tools.
  // Pitfall 7 — widget chat is scoped narrowly to the current node/post; do NOT
  // expose the full primitive-handlers surface to the LLM here.
  // buildSkillTools returns [] (with a warning) when no skill resolved with an
  // on-disk sourcePath — the self-heal above should make that impossible, but
  // on failure return a JSON error BEFORE the SSE stream is constructed so the
  // client sees a clean 500 rather than a silently skill-less assistant.
  let skillTools;
  try {
    skillTools = await buildSkillTools({ skillIds: [skillId] });
  } catch (err) {
    console.error(`[agent-stream:${agentSlug}] buildSkillTools threw:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build skill tools" },
      { status: 500, headers: corsHeaders },
    );
  }
  if (skillTools.length === 0) {
    console.error(
      `[agent-stream:${agentSlug}] no mountable skill tools for "${skillId}" — ` +
        "widget skill delivery failed (registration self-heal did not produce a deliverable skill)",
    );
    return NextResponse.json(
      { error: "Widget skill is unavailable. Please try again." },
      { status: 500, headers: corsHeaders },
    );
  }
  const tools: LlmTool[] = [tool, ...skillTools];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: string, data: unknown): void {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      let emittedAnyText = false;
      let emittedAnyChanges = false;

      try {
        await orchestrateStream({
          system: systemPrompt,
          // Sanitize: drop system-role injection attacks, bound history to last
          // 20 messages, drop messages with non-string content.
          messages: (body.messages as Array<{ role: string; content: string }>)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .filter((m) => typeof m.content === "string")
            .slice(-20)
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
          tools,
          maxSteps: 6,
          signal: AbortSignal.timeout(360_000), // 6 min covers 300s tool budget + slack
          logLabel: `widget:${agentSlug}`,
          preserveFunctionTools: true,            // Pitfall 4 — keep our function tool when MCP is injected
          skipMcpInjection: true,                 // Block full Cinatra MCP surface; only the hardened function tool path is exposed to the LLM.
          onTextDelta: (delta) => {
            if (delta) {
              emittedAnyText = true;
              send("text", { content: delta });
            }
          },
          onToolCall: () => {
            // Widget bundle has no tool-call UI — no SSE frame emitted here.
          },
          onToolResult: (result) => {
            // Only the widget's own content-editor tool can emit a `changes`
            // frame — gate on the BUILT tool's name (no per-CMS literals).
            if (result.name !== tool.name) {
              return;
            }
            let parsed:
              | {
                  nodeId?: string | number;
                  postId?: string | number;
                  changes?: Array<{ field: string; before: string; after: string }>;
                }
              | undefined;
            try {
              parsed = JSON.parse(result.result);
            } catch {
              return; // tool result wasn't JSON — text path handles it
            }
            // The text-fallback result `{ result: <text> }` is also valid JSON,
            // so gate on a real `changes` array: only a structured edit emits a
            // `changes` SSE frame. A text-only reply must NOT trigger the
            // widget's reload-to-apply path.
            if (parsed && Array.isArray(parsed.changes) && !emittedAnyChanges) {
              emittedAnyChanges = true;
              send("changes", {
                fields: parsed.changes,
                nodeId: String(parsed.nodeId ?? ""),
                postId: String(parsed.postId ?? ""), // Pitfall 6 — always String()
              });
            }
          },
          onStepStart: () => {
            // No widget UI for thinking-step boundaries — frames omitted to keep wire format frozen.
          },
          onStepEnd: () => {},
          onError: (error) => {
            console.error(`[agent-stream:${agentSlug}] stream error:`, error);
            send("error", {
              message: "An error occurred processing your request. Please try again.",
            });
          },
        });
        // Successful path — emit done. If the LLM produced no text and no changes
        // (rare — abort or tool-only error), include fallback so widget drops the
        // empty assistant turn from history (Pitfall 5).
        if (!emittedAnyText && !emittedAnyChanges) {
          send("done", { fallback: true });
        } else {
          send("done", {});
        }
      } catch (err) {
        const internalMessage = err instanceof Error ? err.message : String(err);
        console.error(`[agent-stream:${agentSlug}] dispatch failed:`, internalMessage);
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
