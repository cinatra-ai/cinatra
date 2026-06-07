import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ContentBlockParam,
  ToolUseBlock,
  TextBlock,
  TextBlockParam,
  RawMessageStreamEvent,
  Tool,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import type { BetaMCPToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages";
import type {
  LlmProviderAdapter,
  LlmTool,
  LlmFunctionTool,
  LlmToolParameterSchema,
  LlmShellTool,
  LlmMcpServerTool,
  LlmContainerSkillsTool,
  LlmToolCall,
  GenerateInput,
  StreamInput,
  FileInputGenerateInput,
  LlmResponse,
  LlmUsageData,
  UploadFileInput,
  LlmFileReference,
} from "../types";
// Guarded native attachment emission.
import {
  anthropicUserContent,
  hasAnthropicDocuments,
  resolvedAttachmentsPerMessage,
} from "../attachments/provider-parts";
import { writeAnthropicLogFile } from "../telemetry";
import {
  BatchNotSupportedError,
  AnthropicFunctionToolSkillError,
} from "../errors";
import {
  isContainerSkillsTool,
  assertNoFunctionToolSkillDelivery,
  buildContainerSkillsParam,
  CONTAINER_SKILLS_CODE_EXECUTION_ENTRY,
} from "./anthropic-skill-tools";

export type AnthropicConnectionConfig = {
  apiKey: string;
  defaultModel?: string;
  mcpMode?: "native" | "function-tools";
  promptCachingEnabled?: boolean;
};

const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Last-resort fallback ONLY. The intended per-purpose/per-connector path is
 * `input.model` (caller override) ⟶ `config.defaultModel`
 * (admin-configured Claude model, incl. `claude-opus-4-7`) ⟶ this constant. This
 * literal is never the configured default; it exists solely so a request with no
 * caller model AND no stored connector default still resolves to a valid model.
 * Do NOT change this to Opus — that would silently promote Opus for unconfigured
 * callers (cost/behavior regression) and is not a per-purpose override.
 */
const ANTHROPIC_FALLBACK_MODEL = "claude-sonnet-4-6";
const MCP_CLIENT_BETA = "mcp-client-2025-11-20" as const;
const FILES_API_BETA = "files-api-2025-04-14" as const;
// Beta stack required alongside MCP_CLIENT_BETA when a container.skills request
// is issued.
const CODE_EXECUTION_BETA = "code-execution-2025-08-25" as const;
const SKILLS_BETA = "skills-2025-10-02" as const;
const CONTAINER_SKILLS_BETAS = [
  CODE_EXECUTION_BETA,
  SKILLS_BETA,
  FILES_API_BETA,
] as const;

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

function createClient(config: AnthropicConnectionConfig) {
  return new Anthropic({ apiKey: config.apiKey });
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function isFunctionTool(tool: LlmTool): tool is LlmFunctionTool {
  return !("type" in tool) || tool.type === "function" || tool.type === undefined;
}

function isShellTool(tool: LlmTool): tool is LlmShellTool {
  return "type" in tool && tool.type === "shell";
}

function findShellTool(tools: LlmTool[]): LlmShellTool | undefined {
  return tools.find(isShellTool);
}

function isMcpServerTool(tool: LlmTool): tool is LlmMcpServerTool {
  return "type" in tool && tool.type === "mcp";
}

// isContainerSkillsTool / assertNoFunctionToolSkillDelivery /
// buildContainerSkillsParam / CONTAINER_SKILLS_CODE_EXECUTION_ENTRY are the
// SDK-free, independently unit-tested standing-invariant helpers in
// ./anthropic-skill-tools.

// ---------------------------------------------------------------------------
// MCP function-tools bridge
// ---------------------------------------------------------------------------

/**
 * Fetch the MCP tool list from the Cinatra MCP server and convert each tool
 * to an LlmFunctionTool with an execute() that proxies calls back via JSON-RPC.
 * Returns an empty array if the MCP server is unreachable.
 */
async function fetchMcpToolsAsLlmFunctionTools(mcpTool: LlmMcpServerTool): Promise<LlmFunctionTool[]> {
  try {
    const listRes = await fetch(mcpTool.serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(mcpTool.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    if (!listRes.ok) return [];
    const listData = await listRes.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> } };
    // Honor the client-side `allowedTools` hint when mapping MCP tools to
    // Anthropic function tools. Without this, the function-tools bridge would
    // expose the FULL server surface even when the chat scoped the tool to a
    // delegated allowlist. Semantics: `null`/`undefined` = all server-listed
    // tools; `[]` = deny all; array = exact names only.
    const allowedTools = mcpTool.allowedTools;
    const isAllowedByClientConfig = (toolName: string): boolean => {
      if (allowedTools === null || allowedTools === undefined) return true;
      if (allowedTools.length === 0) return false;
      return allowedTools.includes(toolName);
    };
    const tools = (listData.result?.tools ?? []).filter((t) =>
      isAllowedByClientConfig(t.name),
    );
    return tools.map((t): LlmFunctionTool => ({
      name: t.name,
      description: t.description ?? t.name,
      parameters: (t.inputSchema as LlmToolParameterSchema) ?? { type: "object" as const, properties: {} },
      execute: async (args: Record<string, unknown>) => {
        const callRes = await fetch(mcpTool.serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(mcpTool.headers ?? {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: args } }),
        });
        if (!callRes.ok) return { error: `MCP call failed: ${callRes.status}` };
        const callData = await callRes.json() as { result?: unknown };
        return callData.result ?? {};
      },
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

/**
 * Translate unified tools to Anthropic API format.
 * - LlmFunctionTool → standard Tool with input_schema
 * - LlmShellTool → ToolBash20250124 (native bash tool)
 * - LlmMcpServerTool → not natively supported yet, skipped
 */
function translateTools(tools: LlmTool[]): ToolUnion[] {
  const defs: ToolUnion[] = [];

  for (const t of tools) {
    if (isFunctionTool(t)) {
      defs.push({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Tool["input_schema"],
      });
    } else if (isShellTool(t)) {
      // Translate the local skill shell tool as a function tool.
      // The native bash_20250124 requires the computer-use beta header, which
      // conflicts with the mcp-client beta used for native MCP mode. Exposing
      // skill shell access as a function tool lets the app handle execution
      // locally without triggering a beta-mismatch API rejection.
      defs.push({
        name: "bash",
        description:
          "Run a read-only shell command (cat, head, or tail) to read files in the mounted skill directories." +
          (t.skills && t.skills.length > 0
            ? " Available skills: " + t.skills.map((s) => `'${s.path}/SKILL.md' — ${s.description}`).join("; ") + "."
            : ""),
        input_schema: {
          type: "object" as const,
          properties: {
            command: { type: "string", description: "The shell command (cat, head, or tail)" },
          },
          required: ["command"],
        },
      });
    } else if ("type" in t && t.type === "web_search") {
      // Translate the provider-neutral LlmWebSearchTool to Anthropic's native
      // web_search_20250305 shape. This tool is GA — no beta header required.
      defs.push({
        type: "web_search_20250305" as const,
        name: "web_search" as const,
      } as never);
    } else if (isContainerSkillsTool(t)) {
      // A container_skills tool contributes ONLY the code-execution tool entry
      // to the tools array. The skill references themselves go in the top-level
      // `container` request param (built by buildContainerSkillsParam), NEVER
      // as function tools.
      defs.push({ ...CONTAINER_SKILLS_CODE_EXECUTION_ENTRY } as never);
    }
    // MCP server tools: Anthropic may support MCP connectors in the future.
    // For now, MCP primitives must be registered as function tools for Claude.
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncateResult(result: string): string {
  return result.length > MAX_TOOL_RESULT_CHARS
    ? result.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]"
    : result;
}


/**
 * When prompt caching is enabled, wrap the system string in a TextBlockParam
 * with cache_control so Anthropic caches the system prompt between calls.
 * Falls back to plain string when caching is disabled or system is empty.
 */
function buildSystemParam(
  system: string,
  promptCachingEnabled: boolean,
): string | TextBlockParam[] {
  if (!promptCachingEnabled || !system) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

async function executeTool(tool: LlmFunctionTool, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await tool.execute(args);
    return JSON.stringify(result);
  } catch (error) {
    // Control-flow signals (e.g. HitlPauseSignal, BudgetExceededSignal) must
    // propagate out of the LLM loop so agentic-execution.ts can handle them.
    // They are identified by .name rather than instanceof to avoid a circular
    // dependency between llm and agent-builder.
    if (
      error instanceof Error &&
      (error.name === "HitlPauseSignal" || error.name === "BudgetExceededSignal")
    ) {
      throw error;
    }
    return JSON.stringify({ error: error instanceof Error ? error.message : "Tool execution failed." });
  }
}

function extractTextFromMessage(message: { content: Array<{ type: string; text?: string }> }): string | null {
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      return block.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function extractAnthropicUsage(response: unknown): LlmUsageData | undefined {
  const usage = (response as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } }).usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

export function createAnthropicProviderAdapter(config: AnthropicConnectionConfig): LlmProviderAdapter {
  const client = createClient(config);
  const model = config.defaultModel ?? ANTHROPIC_FALLBACK_MODEL;
  // Default to native MCP: auth-token forwarding and loop correctness are
  // reliable on this path. Admins who explicitly
  // saved "function-tools" in the Claude connector administration will still use it.
  const mcpMode = config.mcpMode ?? "native";
  const promptCachingEnabled = config.promptCachingEnabled ?? false;

  return {
    provider: "anthropic",
    defaultModel: model,

    // -----------------------------------------------------------------------
    // generate — non-streaming, with optional multi-step tool loop
    // -----------------------------------------------------------------------
    async generate(input: GenerateInput): Promise<LlmResponse> {
      const resolvedModel = input.model ?? model;
      const maxSteps = input.maxSteps ?? 1;
      const logLabel = input.logLabel ?? "anthropic-generate";

      // Prepend prior conversation messages before the current prompt (resume support).
      const messages: MessageParam[] = [];
      if (input.messages && input.messages.length > 0) {
        for (const m of input.messages) {
          messages.push({ role: m.role, content: m.content });
        }
      }
      messages.push({
        role: "user",
        content: anthropicUserContent(
          input.prompt,
          input.resolvedAttachments,
        ) as MessageParam["content"],
      });

      // Fail closed: skills reach Anthropic ONLY via
      // container.skills. A shell/read_skill/bash skill tool here is a
      // structural invariant violation (covers every caller, seam or not).
      assertNoFunctionToolSkillDelivery(input.tools);

      // Pre-synced Custom Skills → top-level `container` param.
      const containerSkillsParam = buildContainerSkillsParam(input.tools);
      const hasContainerSkills = containerSkillsParam !== undefined;

      // Extract MCP server tools (if injected by registry) and build effective tool list
      const mcpServerTools = (input.tools?.filter(isMcpServerTool) ?? []) as LlmMcpServerTool[];
      // First entry = cinatra self-MCP (preserved for fallback path).
      // By convention, the registry always injects cinatra self-MCP first.
      const mcpServerTool = mcpServerTools[0];
      const nonMcpTools = input.tools?.filter(t => !isMcpServerTool(t));

      let effectiveTools = nonMcpTools ?? [];
      if (mcpServerTool && mcpMode === "function-tools") {
        const mcpFunctionTools = await fetchMcpToolsAsLlmFunctionTools(mcpServerTool);
        effectiveTools = [...mcpFunctionTools, ...effectiveTools];
      }

      // Native path: pass MCP server URLs directly via beta API.
      // A container_skills request MUST use the beta path too (it carries the
      // `container` param + skills beta stack).
      // mcpMode === "function-tools" cannot deliver container skills, so a
      // skill-bearing request with function-tools mode fails closed below.
      const useNativeMcp =
        (mcpServerTools.length > 0 && mcpMode === "native") ||
        (hasContainerSkills && mcpMode === "native");

      // Fail closed: container skills require the native beta path. If the
      // connector is pinned to function-tools mode, there is NO way to deliver
      // container.skills — refuse rather than silently drop the skills.
      if (hasContainerSkills && mcpMode === "function-tools") {
        throw new AnthropicFunctionToolSkillError(
          "container.skills request requires native MCP mode, but the Claude " +
            "connector is configured for function-tools mode",
        );
      }

      // The legacy shell→read_skill swap is removed.
      // Skills no longer reach Anthropic as shell/read_skill tools (the
      // fail-closed guard above rejects them; delivery is container.skills).
      // We still strip any non-skill shell tool when MCP is active — shell is
      // not a peer tool alongside native MCP — but inject NO function-tool
      // replacement (there is no skill to replace).
      if (mcpServerTools.length > 0) {
        effectiveTools = effectiveTools.filter(t => !isShellTool(t));
      }

      // Anthropic `document` parts require the
      // Files API beta + the beta client. Branch ONLY when documents are
      // present; every no-attachment / non-document request stays byte-
      // identical on the existing client.messages.* path.
      const needsFilesBeta = hasAnthropicDocuments(input.resolvedAttachments);
      let finalText: string | null = null;
      let response: Awaited<ReturnType<typeof client.messages.create>> | undefined;
      let nativeMcpFailed = false;

      if (useNativeMcp) {
        // ---------------------------------------------------------------------------
        // Native MCP path — uses client.beta.messages.create() with mcp_servers param
        // Anthropic executes mcp_tool_use blocks server-side — host only processes
        // standard tool_use blocks for any remaining function tools.
        // ---------------------------------------------------------------------------
        const nativeToolDefs = effectiveTools.length > 0 ? translateTools(effectiveTools) : undefined;
        // One mcp_toolset entry per registered MCP server — required by Anthropic
        // alongside the mcp_servers array entries.
        const mcpToolsetEntries = mcpServerTools.map((t) => ({
          type: "mcp_toolset" as const,
          mcp_server_name: t.serverLabel,
        }));
        const nativeTools = nativeToolDefs && nativeToolDefs.length > 0
          ? [...nativeToolDefs, ...mcpToolsetEntries]
          : [...mcpToolsetEntries];

        // Build multi-server mcp_servers array (cinatra self-MCP first, WP MCP after)
        const mcpServersArray = mcpServerTools.map((t) => ({
          name: t.serverLabel,
          type: "url" as const,
          url: t.serverUrl,
          // Strip the "Bearer " prefix — the Anthropic API prepends its own
          // "Bearer " before forwarding the token to the MCP server, so sending
          // a raw JWT here produces the correct single-prefix Authorization header.
          // For WP MCP (Basic auth), the header value starts with "Basic " not
          // "Bearer " — the regex leaves it untouched in that case, which is correct
          // (Anthropic forwards arbitrary header values for non-Bearer schemes).
          authorization_token: t.headers?.["Authorization"]?.replace(/^Bearer\s+/i, "") ?? null,
        }));

        // Stack the skills betas + attach the top-level `container` param when
        // container skills are present. Combine the container-skills beta stack
        // (which already includes FILES_API_BETA via CONTAINER_SKILLS_BETAS)
        // with attachment-driven FILES_API_BETA opt-in (`needsFilesBeta`).
        // Set-dedup keeps it clean when both code paths want FILES_API_BETA.
        const nativeBetas = Array.from(
          new Set(
            hasContainerSkills
              ? [MCP_CLIENT_BETA, ...CONTAINER_SKILLS_BETAS]
              : needsFilesBeta
                ? [MCP_CLIENT_BETA, FILES_API_BETA]
                : [MCP_CLIENT_BETA],
          ),
        );
        const containerParam = containerSkillsParam
          ? { container: containerSkillsParam }
          : {};

        for (let step = 0; step < maxSteps; step++) {
          const nativeRequestBody = {
            model: resolvedModel,
            system: buildSystemParam(input.system, promptCachingEnabled),
            messages,
            max_tokens: input.maxTokens ?? 4096,
            tools: nativeTools,
            mcp_servers: mcpServersArray,
            ...containerParam,
            betas: nativeBetas,
          };
          // Redaction lives at the writer chokepoint (writeAnthropicLogFile
          // applies redactAuthorizationDeep, which fully replaces
          // authorization_token / Authorization values with "[REDACTED]").
          // Pass the raw body and let the writer redact.
          await writeAnthropicLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: nativeRequestBody });

          // Use a local typed variable to avoid the Stream union in the shared response type
          let nativeResponse: Awaited<ReturnType<typeof client.beta.messages.create>>;
          try {
            nativeResponse = await client.beta.messages.create(
              {
                model: resolvedModel,
                system: buildSystemParam(input.system, promptCachingEnabled) as Parameters<typeof client.beta.messages.create>[0]["system"],
                messages,
                max_tokens: input.maxTokens ?? 4096,
                tools: nativeTools as never[],
                mcp_servers: mcpServersArray,
                ...containerParam,
                betas: nativeBetas,
              } as never,
              input.signal ? { signal: input.signal } : undefined,
            );
          } catch (apiError) {
            // When container skills are present the ONLY valid delivery is this
            // native beta path. The standard function-tools fallback has no
            // `container` param, so falling through would silently drop the
            // skills. Fail closed instead.
            if (hasContainerSkills) {
              throw apiError;
            }
            // Native MCP failed (e.g. beta not enabled on the account). Fall back to
            // function-tools mode so the caller still gets a response and usage is emitted.
            console.warn("[anthropic] native MCP beta.messages.create failed, falling back to function-tools:", apiError instanceof Error ? apiError.message : String(apiError));
            nativeMcpFailed = true;
            break;
          }
          // Assign to outer response for usage extraction after the loop
          response = nativeResponse as unknown as Awaited<ReturnType<typeof client.messages.create>>;

          await writeAnthropicLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "response", body: nativeResponse });

          const textBlocks = nativeResponse.content.filter((b): b is TextBlock => b.type === "text");
          // Native MCP mode: Anthropic executes mcp_tool_use blocks server-side — host only processes standard tool_use blocks.
          const toolUseBlocks = nativeResponse.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

          if (textBlocks.length > 0) {
            finalText = textBlocks.map((b) => b.text).join("");
          }

          // Detect server-side MCP tool execution — these blocks need no host action.
          const mcpToolUseBlocks = nativeResponse.content.filter(
            (b): b is BetaMCPToolUseBlock => b.type === "mcp_tool_use"
          );

          if (nativeResponse.stop_reason === "pause_turn") {
            // Anthropic paused a long-running turn (internal step limit reached).
            // Resend the accumulated messages; Anthropic resumes internally.
            messages.push({ role: "assistant", content: nativeResponse.content as ContentBlockParam[] });
            continue;
          }

          if (nativeResponse.stop_reason !== "tool_use" || (toolUseBlocks.length === 0 && mcpToolUseBlocks.length === 0)) {
            break;
          }

          if (toolUseBlocks.length === 0 && mcpToolUseBlocks.length > 0) {
            // Anthropic executed MCP tools server-side — no host action needed.
            // Append assistant turn and loop to receive the next response.
            messages.push({ role: "assistant", content: nativeResponse.content as ContentBlockParam[] });
            continue;
          }

          // toolUseBlocks.length > 0 — existing host tool execution block follows unchanged.
          messages.push({ role: "assistant", content: nativeResponse.content as ContentBlockParam[] });

          const toolResults: ContentBlockParam[] = [];
          for (const toolUse of toolUseBlocks) {
            const tool = effectiveTools.filter(isFunctionTool).find((t) => t.name === toolUse.name);
            const args = (toolUse.input as Record<string, unknown>) ?? {};
            let result: string;
            if (!tool && toolUse.name === "bash") {
              // Route bash calls to the local skill shell tool (translated as a function tool).
              const shellTool = findShellTool(effectiveTools);
              if (shellTool) {
                const command = typeof args.command === "string" ? args.command : "";
                const outputs = await shellTool.execute({ commands: [command], timeoutMs: null, maxOutputLength: null });
                const output = outputs[0];
                result = output
                  ? `${output.stdout}${output.stderr ? `\nstderr: ${output.stderr}` : ""}`
                  : "No output";
              } else {
                result = JSON.stringify({ error: "Unknown tool: bash" });
              }
            } else {
              result = tool
                ? await executeTool(tool, args)
                : JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
            }

            toolResults.push({
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: truncateResult(result),
            } as ContentBlockParam);
          }

          messages.push({ role: "user", content: toolResults });
        }
      }

      if (!useNativeMcp || nativeMcpFailed) {
        // The standard path has no `container` param. A container-skills
        // request must never reach it (the guards above route it to the native
        // beta path or fail closed). Defensive belt-and-braces: refuse rather
        // than silently drop the skills.
        if (hasContainerSkills) {
          throw new AnthropicFunctionToolSkillError(
            "container.skills request unexpectedly reached the standard " +
              "(no-container) Messages path — refusing to drop skills",
          );
        }
        if (nativeMcpFailed) {
          // Reset conversation state for the function-tools fallback.
          messages.splice(0, messages.length, {
            role: "user",
            content: anthropicUserContent(
              input.prompt,
              input.resolvedAttachments,
            ) as MessageParam["content"],
          });
          finalText = null;
          response = undefined;
          // Function-tools fallback (when native MCP beta fails) — only the
          // FIRST MCP server (cinatra self-MCP) is converted to function tools.
          // External MCP servers require native MCP and are silently dropped on
          // this fallback path. This is acceptable because the fallback is rare
          // (only when the Anthropic MCP beta is unavailable on the account).
          if (mcpServerTool) {
            const mcpFunctionTools = await fetchMcpToolsAsLlmFunctionTools(mcpServerTool);
            if (mcpFunctionTools.length === 0) {
              // Tier 2 also failed — MCP server unreachable for function-tools fetch.
              console.warn("[anthropic] function-tools MCP fetch returned 0 tools, falling back to shell-only");
            }
            effectiveTools = [...mcpFunctionTools, ...(nonMcpTools ?? [])];
            // Strip shell tool only if MCP function tools were actually fetched —
            // when mcpFunctionTools is empty, shell is the last-resort fallback.
            if (mcpFunctionTools.length > 0) {
              effectiveTools = effectiveTools.filter(t => !isShellTool(t));
            }
          }
        }

        // ---------------------------------------------------------------------------
        // Standard path — function-tools mode (default) or no MCP tool
        // ---------------------------------------------------------------------------
        const toolDefs = effectiveTools.length > 0 ? translateTools(effectiveTools) : undefined;

        for (let step = 0; step < maxSteps; step++) {
          const nnParams = {
            model: resolvedModel,
            system: buildSystemParam(input.system, promptCachingEnabled),
            messages,
            max_tokens: input.maxTokens ?? 4096,
            ...(toolDefs && toolDefs.length > 0 ? { tools: toolDefs } : {}),
            ...(input.outputSchema
              ? {
                  output_config: {
                    format: {
                      type: "json_schema" as const,
                      schema: input.outputSchema,
                    },
                  },
                }
              : {}),
          };
          const nnOpts = input.signal ? { signal: input.signal } : undefined;
          // Log the EXACT object sent — `betas` appears in the request log IFF
          // it is actually sent. documents → beta client + Files API beta; else
          // the verbatim client.messages.create call (preserves the non-stream
          // Message overload narrowing) sends NO betas, so logging nnParams
          // (structurally identical) is truthful.
          if (needsFilesBeta) {
            const sent = { ...nnParams, betas: [FILES_API_BETA] };
            await writeAnthropicLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: sent });
            // Beta client returns BetaMessage; cast to the non-streaming
            // Message type (NOT the create() overload union) so response stays
            // narrowed to Message — same "avoid the Stream union" idiom the
            // native path uses with its local nativeResponse variable.
            response = (await client.beta.messages.create(
              sent as never,
              nnOpts,
            )) as unknown as Message;
          } else {
            await writeAnthropicLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: nnParams });
            response = await client.messages.create(
              {
                model: resolvedModel,
                system: buildSystemParam(input.system, promptCachingEnabled),
                messages,
                max_tokens: input.maxTokens ?? 4096,
                ...(toolDefs && toolDefs.length > 0 ? { tools: toolDefs } : {}),
                ...(input.outputSchema
                  ? {
                      output_config: {
                        format: {
                          type: "json_schema" as const,
                          schema: input.outputSchema,
                        },
                      },
                    }
                  : {}),
              },
              input.signal ? { signal: input.signal } : undefined,
            );
          }

          await writeAnthropicLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "response", body: response });

          // Extract text and tool use blocks
          const textBlocks = response.content.filter((b): b is TextBlock => b.type === "text");
          // Only process standard tool_use blocks — mcp_tool_use blocks (native mode) are handled server-side by Anthropic.
          const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

          if (textBlocks.length > 0) {
            finalText = textBlocks.map((b) => b.text).join("");
          }

          if (response.stop_reason === "pause_turn") {
            // Anthropic paused a long-running turn (e.g. mid-web-search step).
            // Resend the accumulated messages; Anthropic resumes internally.
            messages.push({ role: "assistant", content: response.content as ContentBlockParam[] });
            continue;
          }

          if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
            break;
          }

          // Add assistant message with tool use
          messages.push({ role: "assistant", content: response.content as ContentBlockParam[] });

          // Execute tools and add results
          const toolResults: ContentBlockParam[] = [];
          for (const toolUse of toolUseBlocks) {
            const tool = effectiveTools.filter(isFunctionTool).find((t) => t.name === toolUse.name);
            const args = (toolUse.input as Record<string, unknown>) ?? {};
            let result: string;
            if (!tool && toolUse.name === "bash") {
              // Route bash calls to the local skill shell tool (translated as a function tool).
              const shellTool = findShellTool(effectiveTools);
              if (shellTool) {
                const command = typeof args.command === "string" ? args.command : "";
                const outputs = await shellTool.execute({ commands: [command], timeoutMs: null, maxOutputLength: null });
                const output = outputs[0];
                result = output
                  ? `${output.stdout}${output.stderr ? `\nstderr: ${output.stderr}` : ""}`
                  : "No output";
              } else {
                result = JSON.stringify({ error: "Unknown tool: bash" });
              }
            } else {
              result = tool
                ? await executeTool(tool, args)
                : JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
            }

            toolResults.push({
              type: "tool_result" as const,
              tool_use_id: toolUse.id,
              content: truncateResult(result),
            } as ContentBlockParam);
          }

          messages.push({ role: "user", content: toolResults });
        }
      }

      return {
        text: finalText,
        status: "completed",
        incompleteReason: null,
        rawBody: JSON.stringify({ text: finalText }),
        usage: extractAnthropicUsage(response),
        model: (response as { model?: string } | undefined)?.model ?? undefined,
      };
    },

    // -----------------------------------------------------------------------
    // stream — streaming with multi-step tool loop
    // -----------------------------------------------------------------------
    async stream(input: StreamInput): Promise<void> {
      const resolvedModel = input.model ?? model;
      const maxSteps = input.maxSteps ?? 6;
      const logLabel = input.logLabel ?? "anthropic-stream";

      // Per-message resolved parts via the single source of truth (own
      // resolvedAttachments; request-level fallback only on the last user turn
      // that carried none).
      // Byte-identical when no parts apply.
      const streamEff = resolvedAttachmentsPerMessage(
        input.messages,
        input.resolvedAttachments,
      );
      const messages: MessageParam[] = input.messages.map((m, i) => ({
        role: m.role as "user" | "assistant",
        content:
          m.role === "user" && streamEff[i]
            ? (anthropicUserContent(
                m.content,
                streamEff[i],
              ) as MessageParam["content"])
            : m.content,
      }));

      // Fail closed: no shell/read_skill/bash skill
      // tool may reach Anthropic. Chat + widget paths are stream-based, so
      // this guard is essential here too.
      assertNoFunctionToolSkillDelivery(input.tools);

      // Pre-synced Custom Skills → top-level `container` param.
      const streamContainerSkillsParam = buildContainerSkillsParam(input.tools);
      const streamHasContainerSkills = streamContainerSkillsParam !== undefined;

      // Files-API-beta gate is true exactly when document parts reach ANY
      // emitted turn. Folded into `streamBetas` below so the container-skills
      // path (which already includes FILES_API_BETA via CONTAINER_SKILLS_BETAS)
      // and the non-container path both get the beta when attachments need it.
      // Set-dedup keeps the union clean.
      const streamNeedsFilesBeta = streamEff.some((p) =>
        hasAnthropicDocuments(p),
      );

      // Extract MCP server tools (if injected by registry) and build effective tool list
      const streamMcpServerTools = (input.tools?.filter(isMcpServerTool) ?? []) as LlmMcpServerTool[];
      // First entry = cinatra self-MCP (preserved for fallback path and shell-tool strip check).
      const streamMcpServerTool = streamMcpServerTools[0];
      const streamNonMcpTools = input.tools?.filter(t => !isMcpServerTool(t));

      // Fail closed: container skills require the native beta path.
      if (streamHasContainerSkills && mcpMode === "function-tools") {
        throw new AnthropicFunctionToolSkillError(
          "container.skills stream request requires native MCP mode, but the " +
            "Claude connector is configured for function-tools mode",
        );
      }

      let streamEffectiveTools = streamNonMcpTools ?? [];
      if (streamMcpServerTool && mcpMode === "function-tools") {
        const mcpFunctionTools = await fetchMcpToolsAsLlmFunctionTools(streamMcpServerTool);
        streamEffectiveTools = [...mcpFunctionTools, ...streamEffectiveTools];
      }
      // The legacy shell→read_skill swap is removed. Strip any non-skill shell
      // tool when MCP is active (shell is not a peer alongside native MCP) but
      // inject NO function-tool replacement.
      if (streamMcpServerTools.length > 0) {
        streamEffectiveTools = streamEffectiveTools.filter(t => !isShellTool(t));
      }

      // When container skills are present, the stream MUST go through the
      // beta path with mcp_servers + container + the stacked skills betas
      // (mirrors generate's native path; chat/widget are stream-based).
      //
      // Scoped to container-skills ONLY. Anthropic streams without container
      // skills use the GA `client.messages.stream` path, so routing
      // no-container native-MCP streams through beta-stream would be scope
      // creep that (a) changes the GA path for every existing stream and
      // (b) drops server-side mcp_tool_use turns. The ONLY beta-stream case
      // introduced here is a container.skills request.
      const streamUseNativeBeta = streamHasContainerSkills && mcpMode === "native";
      const streamMcpToolsetEntries = streamMcpServerTools.map((t) => ({
        type: "mcp_toolset" as const,
        mcp_server_name: t.serverLabel,
      }));
      const streamMcpServersArray = streamMcpServerTools.map((t) => ({
        name: t.serverLabel,
        type: "url" as const,
        url: t.serverUrl,
        authorization_token:
          t.headers?.["Authorization"]?.replace(/^Bearer\s+/i, "") ?? null,
      }));
      // Mirror the generate-path `nativeBetas` resolution — fold
      // `streamNeedsFilesBeta` into the non-container case; container case
      // already includes FILES_API_BETA via CONTAINER_SKILLS_BETAS; Set-dedup
      // is the union safety net.
      const streamBetas = Array.from(
        new Set(
          streamHasContainerSkills
            ? [MCP_CLIENT_BETA, ...CONTAINER_SKILLS_BETAS]
            : streamNeedsFilesBeta
              ? [MCP_CLIENT_BETA, FILES_API_BETA]
              : [MCP_CLIENT_BETA],
        ),
      );
      const streamContainerParam = streamContainerSkillsParam
        ? { container: streamContainerSkillsParam }
        : {};

      const baseToolDefs = streamEffectiveTools.length > 0 ? translateTools(streamEffectiveTools) : undefined;
      // GA path keeps the strict ToolUnion[] type; beta path appends the
      // mcp_toolset entries (only valid on the beta endpoint) and is cast at
      // the call site (same `as never` discipline as generate's native path).
      const gaToolDefs = baseToolDefs;
      const betaToolDefs = [...(baseToolDefs ?? []), ...streamMcpToolsetEntries];

      for (let step = 0; step < maxSteps; step++) {
        input.onStepStart(step + 1);

        // `streamUseNativeBeta` is the comprehensive routing:
        // beta-stream-with-container-skills OR GA-stream. Document attachments
        // are covered by:
        //   (a) container path: FILES_API_BETA is already in CONTAINER_SKILLS_BETAS;
        //   (b) non-container, documents-present path: `streamNeedsFilesBeta`
        //       upgrades the GA path → beta-stream via the conditional below.
        // The beta-stream client accepts requests without mcp_servers/container,
        // so non-container document-stream is just a regular beta call with
        // FILES_API_BETA. Set-dedup in `streamBetas` keeps it clean.
        const streamUseBetaForDocs = !streamUseNativeBeta && streamNeedsFilesBeta;
        await writeAnthropicLogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "request",
          body: streamUseNativeBeta
            ? {
                model: resolvedModel,
                system: buildSystemParam(input.system, promptCachingEnabled),
                messages,
                tools: betaToolDefs,
                mcp_servers: streamMcpServersArray,
                ...streamContainerParam,
                betas: streamBetas,
              }
            : streamUseBetaForDocs
              ? {
                  model: resolvedModel,
                  system: buildSystemParam(input.system, promptCachingEnabled),
                  messages,
                  ...(gaToolDefs && gaToolDefs.length > 0 ? { tools: gaToolDefs } : {}),
                  betas: streamBetas,
                }
              : {
                  model: resolvedModel,
                  system: buildSystemParam(input.system, promptCachingEnabled),
                  messages,
                  tools: gaToolDefs,
                },
        });

        // Container skills / native MCP require the beta stream endpoint with
        // mcp_servers + container + skills betas. If document attachments are
        // present, still use the beta endpoint to carry the Files-API beta
        // header; else use the GA messages.stream path.
        const stream = streamUseNativeBeta
          ? client.beta.messages.stream({
              model: resolvedModel,
              system: buildSystemParam(input.system, promptCachingEnabled),
              messages,
              max_tokens: input.maxTokens ?? 4096,
              ...(betaToolDefs.length > 0 ? { tools: betaToolDefs } : {}),
              mcp_servers: streamMcpServersArray,
              ...streamContainerParam,
              betas: streamBetas,
            } as never)
          : streamUseBetaForDocs
            ? client.beta.messages.stream({
                model: resolvedModel,
                system: buildSystemParam(input.system, promptCachingEnabled),
                messages,
                max_tokens: input.maxTokens ?? 4096,
                ...(gaToolDefs && gaToolDefs.length > 0 ? { tools: gaToolDefs } : {}),
                betas: streamBetas,
              } as never)
            : client.messages.stream({
                model: resolvedModel,
                system: buildSystemParam(input.system, promptCachingEnabled),
                messages,
                max_tokens: input.maxTokens ?? 4096,
                ...(gaToolDefs && gaToolDefs.length > 0 ? { tools: gaToolDefs } : {}),
              });

        // Track tool use blocks being built during streaming
        const pendingToolUses: Array<{
          id: string;
          name: string;
          inputJson: string;
        }> = [];
        let currentToolIndex = -1;

        try {
          for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
            switch (event.type) {
              case "content_block_start": {
                const block = event.content_block as { type: string; id?: string; name?: string };
                if (block.type === "tool_use" && block.id) {
                  currentToolIndex = pendingToolUses.length;
                  pendingToolUses.push({
                    id: block.id,
                    name: block.name ?? "",
                    inputJson: "",
                  });
                }
                break;
              }

              case "content_block_delta": {
                const delta = event.delta as { type: string; text?: string; partial_json?: string };
                if (delta.type === "text_delta" && delta.text) {
                  input.onTextDelta(delta.text);
                } else if (delta.type === "input_json_delta" && delta.partial_json) {
                  if (currentToolIndex >= 0 && pendingToolUses[currentToolIndex]) {
                    pendingToolUses[currentToolIndex].inputJson += delta.partial_json;
                  }
                }
                break;
              }

              case "content_block_stop":
                // Block is complete
                break;
            }
          }
        } catch (error) {
          input.onError(error instanceof Error ? error : new Error("Anthropic stream failed"));
          break;
        }

        const finalMessage = await stream.finalMessage();

        await writeAnthropicLogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "response",
          body: { stop_reason: finalMessage.stop_reason, content: finalMessage.content },
        });

        input.onStepEnd(step + 1);

        // The container-skills beta-stream path can trigger server-side
        // activity (mcp_tool_use blocks, pause_turn for a long code-execution
        // turn). Mirror generate's native-path continuation so the stream does
        // not stop before the final answer.
        if (streamUseNativeBeta) {
          const mcpToolUseBlocks = (finalMessage.content as Array<{ type: string }>).filter(
            (b) => b.type === "mcp_tool_use",
          );
          if (finalMessage.stop_reason === "pause_turn") {
            // Anthropic paused a long-running turn — resend accumulated
            // messages; it resumes internally.
            messages.push({
              role: "assistant",
              content: finalMessage.content as ContentBlockParam[],
            });
            continue;
          }
          if (
            finalMessage.stop_reason === "tool_use" &&
            pendingToolUses.length === 0 &&
            mcpToolUseBlocks.length > 0
          ) {
            // Server-side MCP executed AND the model wants to continue
            // (stop_reason === "tool_use") — no host action; append the
            // assistant turn and loop. Gating on stop_reason matches
            // generate's native path: a TERMINAL response that merely
            // contains mcp_tool_use blocks must NOT be replayed (that would
            // loop to maxSteps and duplicate streamed output).
            messages.push({
              role: "assistant",
              content: finalMessage.content as ContentBlockParam[],
            });
            continue;
          }
        }

        // Check if model wants to use tools
        if (finalMessage.stop_reason !== "tool_use" || pendingToolUses.length === 0) {
          if (input.onUsageData) {
            const usage = extractAnthropicUsage(finalMessage);
            if (usage) input.onUsageData(usage);
          }
          break;
        }

        // Add assistant message to conversation
        messages.push({ role: "assistant", content: finalMessage.content as ContentBlockParam[] });

        // Execute tools and add results
        const toolResults: ContentBlockParam[] = [];
        for (const tu of pendingToolUses) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tu.inputJson || "{}");
          } catch {
            // Use empty args
          }

          // Resolve the function tool by direct name match — primitive names use
          // underscore separators and pass through without transformation.
          const tool = tu.name !== "bash"
            ? streamEffectiveTools.filter(isFunctionTool).find((t) => t.name === tu.name)
            : undefined;
          const originalName = tool?.name ?? tu.name;

          const toolCallEvent: LlmToolCall = {
            id: tu.id,
            name: originalName,
            arguments: args,
          };
          input.onToolCall(toolCallEvent);

          // Handle native bash tool calls via the shell tool
          if (tu.name === "bash") {
            const shellTool = findShellTool(streamEffectiveTools);
            const command = typeof args.command === "string" ? args.command : "";

            if (shellTool && command) {
              const outputs = await shellTool.execute({
                commands: [command],
                timeoutMs: null,
                maxOutputLength: null,
              });

              const output = outputs[0];
              const resultSummary = output
                ? `${output.stdout}${output.stderr ? `\nstderr: ${output.stderr}` : ""}`
                : "No output";

              input.onToolResult({
                id: tu.id,
                name: "bash",
                result: truncateResult(resultSummary),
              });

              toolResults.push({
                type: "tool_result" as const,
                tool_use_id: tu.id,
                content: truncateResult(resultSummary),
              } as ContentBlockParam);
              continue;
            }
          }

          // Regular function tool execution
          const result = tool
            ? await executeTool(tool, args)
            : JSON.stringify({ error: `Unknown tool: ${tu.name}` });

          const truncated = truncateResult(result);

          input.onToolResult({
            id: tu.id,
            name: originalName,
            result: truncated,
          });

          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: truncated,
          } as ContentBlockParam);
        }

        messages.push({ role: "user", content: toolResults });
      }
    },

    // -----------------------------------------------------------------------
    // generateWithFileInput — send file as document content block via Files API
    // -----------------------------------------------------------------------
    async generateWithFileInput(input: FileInputGenerateInput): Promise<LlmResponse> {
      const resolvedModel = input.model ?? model;
      const logLabel = input.logLabel ?? "anthropic-file-input";

      const documentBlock = {
        type: "document" as const,
        source: { type: "file" as const, file_id: input.fileId },
      };

      const requestBody = {
        model: resolvedModel,
        system: input.system,
        messages: [
          {
            role: "user" as const,
            content: [
              documentBlock,
              { type: "text" as const, text: input.prompt },
            ],
          },
        ],
        max_tokens: input.maxTokens ?? 4096,
        betas: [FILES_API_BETA],
        ...(input.outputSchema
          ? { output_config: { format: { type: "json_schema" as const, schema: input.outputSchema } } }
          : {}),
      };

      await writeAnthropicLogFile({ label: logLabel, kind: "request", body: requestBody });

      const response = await client.beta.messages.create(requestBody as never);

      await writeAnthropicLogFile({ label: logLabel, kind: "response", body: response });

      const text = extractTextFromMessage(response as { content: Array<{ type: string; text?: string }> });
      return {
        text,
        status: "completed",
        incompleteReason: null,
        rawBody: JSON.stringify(response),
        usage: extractAnthropicUsage(response),
        model: (response as { model?: string } | undefined)?.model ?? undefined,
      };
    },
    // -----------------------------------------------------------------------
    // uploadFile — upload a file via Anthropic Files API
    // -----------------------------------------------------------------------
    async uploadFile(input: UploadFileInput): Promise<LlmFileReference> {
      const file = new File([new Uint8Array(input.content)], input.filename, { type: input.mimeType });
      const uploaded = await client.beta.files.upload({
        file,
        betas: [FILES_API_BETA],
      });
      return { id: uploaded.id, provider: "anthropic" };
    },
    // -----------------------------------------------------------------------
    // deleteFile — delete an uploaded file
    // -----------------------------------------------------------------------
    async deleteFile(fileRef: LlmFileReference): Promise<void> {
      if (fileRef.provider !== "anthropic") return;
      await client.beta.files.delete(fileRef.id, { betas: [FILES_API_BETA] }).catch(() => {
        // Silently ignore deletion failures (file may already be gone)
      });
    },
    // -----------------------------------------------------------------------
    // listModels — list available Anthropic models
    // -----------------------------------------------------------------------
    async listModels(): Promise<string[]> {
      const response = await client.models.list();
      const models: string[] = [];
      for await (const model of response) {
        if (model.id) {
          models.push(model.id);
        }
      }
      return models.sort((a, b) => a.localeCompare(b));
    },
    // -----------------------------------------------------------------------
    // Batch API stubs: Anthropic does NOT support OpenAI-style
    // /v1/chat/completions batching. Throw rather than return null so callers
    // see the gap explicitly.
    // -----------------------------------------------------------------------
    async submitBatch() { throw new BatchNotSupportedError("anthropic"); },
    async retrieveBatch() { throw new BatchNotSupportedError("anthropic"); },
    async downloadBatchResults() { throw new BatchNotSupportedError("anthropic"); },
    async cancelBatch() { throw new BatchNotSupportedError("anthropic"); },
  };
}
