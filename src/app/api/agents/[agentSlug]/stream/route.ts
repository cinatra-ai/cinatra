import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  stream as orchestrateStream,
  buildSkillTools,
} from "@cinatra-ai/llm";
import type { LlmTool, LlmFunctionTool } from "@cinatra-ai/llm";
import { createDrupalWidgetChatTool } from "@cinatra-ai/drupal-mcp-connector/widget-chat-tool";
import { createWordPressWidgetChatTool } from "@cinatra-ai/wordpress-mcp-connector/widget-chat-tool";
import { registerExtensionSkill } from "@cinatra-ai/skills";

import {
  resolveDrupalWidgetOrigin,
  validateDrupalWidgetToken,
  buildDrupalCorsHeaders,
} from "@/lib/drupal-widget-auth";
import {
  resolveWordPressWidgetOrigin,
  validateWordPressWidgetToken,
  buildWordPressCorsHeaders,
} from "@/lib/wordpress-widget-auth";
import { validateAuthInitRequest } from "@/lib/wp-drupal-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Memoized prod self-heal: ensure drupal-widget-chat is registered in the
// skills catalog before buildSkillTools resolves it. Mirrors the proven
// runner.ts ensureChatSkillRegistered pattern exactly.
// ---------------------------------------------------------------------------

const drupalWidgetSkillMdCandidates = [
  path.resolve(process.cwd(), "extensions/cinatra-ai/drupal-skills/skills/drupal-widget-chat/SKILL.md"),
  path.resolve(__dirname, "../../../../extensions/cinatra-ai/drupal-skills/skills/drupal-widget-chat/SKILL.md"),
  path.resolve(__dirname, "../../../../../extensions/cinatra-ai/drupal-skills/skills/drupal-widget-chat/SKILL.md"),
];

let drupalWidgetSkillRegistration: Promise<void> | null = null;
function ensureDrupalWidgetSkillRegistered(): Promise<void> {
  if (drupalWidgetSkillRegistration) return drupalWidgetSkillRegistration;
  drupalWidgetSkillRegistration = (async () => {
    try {
      const skillMdPath = drupalWidgetSkillMdCandidates.find((c) => existsSync(c));
      if (!skillMdPath) {
        console.warn(
          "[agent-stream:drupal-content-editor] drupal-widget-chat SKILL.md not found on disk — " +
            "cannot register into skills layer; skill delivery will degrade until fixed",
        );
        return;
      }
      const { sourcePath } = await registerExtensionSkill({
        skillId: "@cinatra-ai/drupal-skills:drupal-widget-chat",
        packageName: "@cinatra-ai/drupal-skills",
        skillMdPath,
      });
      console.info(
        `[agent-stream:drupal-content-editor] registered drupal-widget-chat into skills layer (sourcePath: ${sourcePath})`,
      );
    } catch (err) {
      // Reset so a transient failure can retry on the next request.
      drupalWidgetSkillRegistration = null;
      console.error(
        "[agent-stream:drupal-content-editor] failed to register drupal-widget-chat into skills layer:",
        (err as Error).message,
      );
    }
  })();
  return drupalWidgetSkillRegistration;
}

const wordpressWidgetSkillMdCandidates = [
  path.resolve(process.cwd(), "extensions/cinatra-ai/wordpress-mcp-connector/skills/wordpress-widget-chat/SKILL.md"),
  path.resolve(__dirname, "../../../../extensions/cinatra-ai/wordpress-mcp-connector/skills/wordpress-widget-chat/SKILL.md"),
  path.resolve(__dirname, "../../../../../extensions/cinatra-ai/wordpress-mcp-connector/skills/wordpress-widget-chat/SKILL.md"),
];

let wordpressWidgetSkillRegistration: Promise<void> | null = null;
function ensureWordPressWidgetSkillRegistered(): Promise<void> {
  if (wordpressWidgetSkillRegistration) return wordpressWidgetSkillRegistration;
  wordpressWidgetSkillRegistration = (async () => {
    try {
      const skillMdPath = wordpressWidgetSkillMdCandidates.find((c) => existsSync(c));
      if (!skillMdPath) {
        console.warn(
          "[agent-stream:wordpress-content-editor] wordpress-widget-chat SKILL.md not found on disk — " +
            "cannot register into skills layer; skill delivery will degrade until fixed",
        );
        return;
      }
      const { sourcePath } = await registerExtensionSkill({
        skillId: "@cinatra-ai/wordpress-mcp-connector:wordpress-widget-chat",
        packageName: "@cinatra-ai/wordpress-mcp-connector",
        skillMdPath,
      });
      console.info(
        `[agent-stream:wordpress-content-editor] registered wordpress-widget-chat into skills layer (sourcePath: ${sourcePath})`,
      );
    } catch (err) {
      wordpressWidgetSkillRegistration = null;
      console.error(
        "[agent-stream:wordpress-content-editor] failed to register wordpress-widget-chat into skills layer:",
        (err as Error).message,
      );
    }
  })();
  return wordpressWidgetSkillRegistration;
}

// ---------------------------------------------------------------------------
// Per-slug agent stream registry. Adding a new agent = add a registry entry.
// No new route files needed; each agent uses the same per-agent SSE pattern.
//
// Auth: route-level CORS Origin allowlist + Bearer token. The route's path is
// also whitelisted in src/lib/auth-route-guard.ts PUBLIC_AGENT_STREAM_PATHS so
// unauthenticated browser widgets reach this handler instead of being redirected
// to /sign-in.
//
// The route calls stream with a per-CMS widget-chat function tool
// and skill tool. The LLM decides whether to chat conversationally or call the
// content-editor tool.
// SSE wire format on the widget side is FROZEN: text/changes/error/done frames
// only.
// ---------------------------------------------------------------------------

type AgentStreamConfig = {
  resolveAllowedOrigin: (origin: string | null) => string | null;
  validateToken: (token: string) => boolean;
  buildCorsHeaders: (allowedOrigin: string) => Record<string, string>;
};

const AGENT_STREAM_REGISTRY: Record<string, AgentStreamConfig> = {
  "drupal-content-editor": {
    resolveAllowedOrigin: resolveDrupalWidgetOrigin,
    validateToken: validateDrupalWidgetToken,
    buildCorsHeaders: buildDrupalCorsHeaders,
  },
  "wordpress-content-editor": {
    resolveAllowedOrigin: resolveWordPressWidgetOrigin,
    validateToken: validateWordPressWidgetToken,
    buildCorsHeaders: buildWordPressCorsHeaders,
  },
};

type StreamRequestBody = {
  contractVersion?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Helper: build the per-CMS widget-chat tool + skill ID + label.
// ---------------------------------------------------------------------------

function buildWidgetChatToolFor(
  agentSlug: string,
  context: Record<string, unknown>,
): { tool: LlmFunctionTool; skillId: string; cmsLabel: "Drupal" | "WordPress" } {
  if (agentSlug === "drupal-content-editor") {
    return {
      tool: createDrupalWidgetChatTool({ context }),
      skillId: "@cinatra-ai/drupal-skills:drupal-widget-chat",
      cmsLabel: "Drupal",
    };
  }
  return {
    tool: createWordPressWidgetChatTool({ context }),
    skillId: "@cinatra-ai/wordpress-mcp-connector:wordpress-widget-chat",
    cmsLabel: "WordPress",
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function OPTIONS(
  request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const cfg = AGENT_STREAM_REGISTRY[agentSlug];
  if (!cfg) return new NextResponse(null, { status: 404 });
  const allowed = cfg.resolveAllowedOrigin(request.headers.get("Origin"));
  if (!allowed) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 200, headers: cfg.buildCorsHeaders(allowed) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;
  const cfg = AGENT_STREAM_REGISTRY[agentSlug];
  if (!cfg) {
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }

  const allowedOrigin = cfg.resolveAllowedOrigin(request.headers.get("Origin"));
  if (!allowedOrigin) {
    console.warn(`[agent-stream:${agentSlug}] Origin not allowed:`, request.headers.get("Origin"));
    return new NextResponse("Origin not allowed", { status: 403 });
  }
  const corsHeaders = cfg.buildCorsHeaders(allowedOrigin);

  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!bearer || !cfg.validateToken(bearer)) {
    return new NextResponse("Unauthorized", { status: 401, headers: corsHeaders });
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

  // Build per-CMS function tool, skill ID, and label.
  const { tool, skillId, cmsLabel } = buildWidgetChatToolFor(agentSlug, context);

  // Ensure the per-CMS widget-chat skill is registered in the catalog before
  // buildSkillTools tries to resolve it (prod self-heal, memoized per-process).
  if (agentSlug === "drupal-content-editor") {
    await ensureDrupalWidgetSkillRegistered();
  } else {
    await ensureWordPressWidgetSkillRegistered();
  }

  // Sanitize client-supplied context strings before embedding in the system
  // prompt. Strips CR/LF/tabs (so attacker-controlled strings can't add
  // fake instructions on a new line) and bounds length (so a 1MB href can't
  // dominate the system-prompt window). The factory tool path (createXWidgetChatTool)
  // uses identity override on its own and is unaffected — this sanitiser is for
  // system-prompt embedding only.
  const safe = (s: unknown, max = 200): string =>
    String(s ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, max);

  // Build the system prompt with explicit CMS context. Full routing rules live
  // in the SKILL.md the LLM reads via the read_skill tool.
  const cmsContextBlock =
    agentSlug === "drupal-content-editor"
      ? `\n\nCurrent Drupal context:\n` +
        `- instanceId: ${safe(context.instanceId, 64)}\n` +
        `- nodeId: ${safe(context.nodeId, 32)}\n` +
        `- nodeBundle: ${safe(context.nodeBundle, 32)}\n` +
        `- nodeStatus: ${safe(context.nodeStatus, 32)}\n` +
        `- href: ${safe(context.href, 500)}\n`
      : `\n\nCurrent WordPress context:\n` +
        `- instanceId: ${safe(context.instanceId, 64)}\n` +
        `- postId: ${safe(context.postId, 32)}\n` +
        `- postType: ${safe(context.postType, 32)}\n` +
        `- postStatus: ${safe(context.postStatus, 32)}\n` +
        `- href: ${safe(context.href, 500)}\n`;

  const systemPrompt =
    `You are the Cinatra in-CMS assistant embedded in a ${cmsLabel} content editor. ` +
    `Read the widget-chat skill using the provided skill tool for routing rules. ` +
    `When the user asks for any change to the current ${cmsLabel === "Drupal" ? "node" : "post"}, ` +
    `call the content-editor tool with their instructions. ` +
    `When the user is conversational (greeting, question, discussion), answer directly without calling tools. ` +
    `Never paste tool-result JSON into your reply — write a natural-language summary instead.` +
    cmsContextBlock;

  // Build the tools array. Use ONLY the single function tool plus skill tools.
  // Pitfall 7 — widget chat is scoped narrowly to the current node/post; do NOT
  // expose the full primitive-handlers surface to the LLM here.
  // buildSkillTools throws fail-loud when a skill is undeliverable (not in
  // catalog / no sourcePath). The self-heal above should make this impossible
  // in production, but on transient failure return a JSON error before the SSE
  // stream is constructed so the client sees a clean 500 rather than an aborted
  // half-opened stream.
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
            if (
              result.name !== "drupal_content_editor_run" &&
              result.name !== "wordpress_content_editor_run"
            ) {
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
