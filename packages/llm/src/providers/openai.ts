import "server-only";

import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
// LLM provider adapter cutover (cinatra#151 Stage 2): the connector's
// connection reader and telemetry log writer resolve through the
// `llm-provider-surface` capability at call time — packages/llm carries NO
// value-import of any connector package.
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import type {
  LlmProviderAdapter,
  LlmTool,
  LlmFunctionTool,
  LlmShellTool,
  LlmMcpServerTool,
  LlmWebSearchTool,
  LlmToolCall,
  LlmFileReference,
  UploadFileInput,
  GenerateInput,
  StreamInput,
  FileInputGenerateInput,
  LlmResponse,
  LlmUsageData,
  LlmBatchSubmitInput,
  LlmBatchSubmitResult,
  LlmBatchResult,
  LlmBatchOutputLine,
  LlmBatchStatus,
} from "../types";
// Native attachment emission is guarded; legacy behavior remains
// byte-identical when no resolvedAttachments are present.
import {
  openaiUserContent,
  resolvedAttachmentsPerMessage,
} from "../attachments/provider-parts";
import { planMcpToolListErrorRecovery } from "../openai-mcp-error";

/**
 * Structural mirror of the openai-connector's `OpenAIConnectionConfig`
 * (single-author canonical type stays connector-side; the capability ABI is
 * `unknown`-loose by contract, so this package narrows what it reads).
 */
export type OpenAILlmConnection = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: string;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};
// Back-compat alias (this package re-exported the connector's name).
export type OpenAIConnectionConfig = OpenAILlmConnection;

/**
 * Best-effort request/response logging through the openai surface's
 * `writeLogFile` member. Surface or member absent ⇒ no-op (logging never
 * breaks the request path on connector absence); when present, the
 * connector's own enabled-check/redaction/fs-error semantics apply
 * unchanged.
 */
async function writeOpenAILogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}): Promise<void> {
  const writeLogFile = getLlmProviderSurface("openai")?.writeLogFile;
  if (typeof writeLogFile !== "function") return;
  await writeLogFile(input);
}

const MAX_TOOL_RESULT_CHARS = 8000;
// Canonical OpenAI fallback model when a connection carries no `defaultModel`.
// MUST stay equal to `DEFAULT_OPENAI_MODEL_ID` in
// `packages/agents/src/llm-provider-policy.ts` ("gpt-5.5"). We duplicate the
// literal instead of importing it because `@cinatra-ai/agents` depends on
// `@cinatra-ai/llm`, so importing the policy here would create a circular
// dependency (cf. the layering note in `openai-model-capabilities.ts`). NEVER
// base `gpt-5`: the operator-configured `connection.defaultModel` always wins,
// and absent that we fall back to the canonical default, never the
// shell-incompatible base model.
const DEFAULT_MODEL = "gpt-5.5";
const MAX_FUNCTION_TOOLS = 128;

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

function createClient(connection: OpenAIConnectionConfig) {
  return new OpenAI({
    apiKey: connection.apiKey,
    organization: connection.organizationId,
    project: connection.projectId,
    maxRetries: 5, // default is 2; increase to handle 429 rate-limit bursts from parallel jobs
  });
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

function isWebSearchTool(tool: LlmTool): tool is LlmWebSearchTool {
  return "type" in tool && tool.type === "web_search";
}

function isShellTool(tool: LlmTool): tool is LlmShellTool {
  return "type" in tool && tool.type === "shell";
}

function isMcpTool(tool: LlmTool): tool is LlmMcpServerTool {
  return "type" in tool && tool.type === "mcp";
}

function isContainerSkillsTool(
  tool: LlmTool,
): tool is import("../types").LlmContainerSkillsTool {
  return "type" in tool && tool.type === "container_skills";
}

function isFunctionTool(tool: LlmTool): tool is LlmFunctionTool {
  return !isShellTool(tool) && !isMcpTool(tool) && !isContainerSkillsTool(tool);
}

/**
 * Translate unified tools to OpenAI API format.
 * - LlmFunctionTool → { type: "function", name, description, parameters }
 * - LlmShellTool → { type: "shell", environment: { type: "local", skills: [...] } }
 */
function translateTools(tools: LlmTool[]) {
  const defs: Record<string, unknown>[] = [];

  for (const t of tools) {
    if (isWebSearchTool(t)) {
      // OpenAI Responses API built-in tool — no execute handler needed; processed server-side.
      defs.push({ type: "web_search" });
    } else if (isShellTool(t)) {
      defs.push({
        type: "shell",
        environment: {
          type: "local",
          skills: t.skills.map((s) => ({
            name: s.name,
            description: s.description,
            path: s.path,
          })),
        },
      });
    } else if (isMcpTool(t)) {
      defs.push({
        type: "mcp",
        server_label: t.serverLabel,
        server_url: t.serverUrl,
        ...(t.headers ? { headers: t.headers } : {}),
        ...(t.authorization ? { authorization: t.authorization } : {}),
        ...(t.serverDescription ? { server_description: t.serverDescription } : {}),
        ...(t.allowedTools ? { allowed_tools: t.allowedTools } : {}),
        ...(t.requireApproval ? { require_approval: t.requireApproval } : {}),
      });
    } else if (isContainerSkillsTool(t)) {
      // container_skills is an Anthropic-only delivery vehicle. OpenAI
      // skill delivery is the native shell tool; OpenAI must never receive
      // container_skills. Defensive skip to avoid mis-emitting it as a
      // broken function tool.
      continue;
    } else {
      defs.push({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      });
    }
  }

  return defs.length > MAX_FUNCTION_TOOLS ? defs.slice(0, MAX_FUNCTION_TOOLS) : defs;
}

function findFunctionToolByName(tools: LlmTool[], name: string): LlmFunctionTool | undefined {
  return tools.filter(isFunctionTool).find((t) => t.name === name);
}

function findShellTool(tools: LlmTool[]): LlmShellTool | undefined {
  return tools.find(isShellTool);
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
 * Strip SDK-enriched fields (e.g. `parsed_arguments`, `parsed`) from a
 * response output item so it can safely be sent back as an input item.
 */
function sanitizeOutputItem(item: Record<string, unknown>): Record<string, unknown> {
  const { parsed_arguments, ...rest } = item as Record<string, unknown> & { parsed_arguments?: unknown };
  if (rest.type === "message" && Array.isArray(rest.content)) {
    rest.content = (rest.content as Record<string, unknown>[]).map(
      ({ parsed, ...contentRest }) => contentRest,
    );
  }
  return rest;
}

async function executeFunctionTool(tool: LlmFunctionTool, args: Record<string, unknown>): Promise<string> {
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

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function extractOpenAIUsage(response: unknown): LlmUsageData | undefined {
  const usage = (response as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  } }).usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

export function createOpenAIProviderAdapter(connection: OpenAIConnectionConfig): LlmProviderAdapter {
  const client = createClient(connection);
  const model = connection.defaultModel ?? DEFAULT_MODEL;

  return {
    provider: "openai",
    defaultModel: model,

    // -----------------------------------------------------------------------
    // generate — non-streaming, with optional multi-step tool loop
    // -----------------------------------------------------------------------
    async generate(input: GenerateInput): Promise<LlmResponse> {
      const resolvedModel = input.model ?? model;
      const maxSteps = input.maxSteps ?? 1;
      const logLabel = input.logLabel ?? "openai-generate";

      type InputItem = Record<string, unknown>;
      // Prepend prior conversation messages before the current prompt for resume support.
      const inputItems: InputItem[] = [];
      if (input.messages && input.messages.length > 0) {
        for (const m of input.messages) {
          inputItems.push({ role: m.role, content: m.content });
        }
      }
      inputItems.push({
        role: "user",
        content: openaiUserContent(input.prompt, input.resolvedAttachments),
      });

      const toolDefs = input.tools ? translateTools(input.tools) : undefined;

      let finalText: string | null = null;
      let response: Awaited<ReturnType<typeof client.responses.create>> | undefined;

      for (let step = 0; step < maxSteps; step++) {
        const requestBody: Record<string, unknown> = {
          model: resolvedModel,
          instructions: input.system,
          input: inputItems,
          ...(toolDefs && toolDefs.length > 0 ? { tools: toolDefs } : {}),
          ...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
          ...(input.outputSchema
            ? { text: { format: { type: "json_schema", name: "response", schema: input.outputSchema } } }
            : {}),
          ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
          ...(connection.serviceTier ? { service_tier: connection.serviceTier } : {}),
          store: connection.promptCachingEnabled !== false,
        };

        await writeOpenAILogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: requestBody });


        try {
          response = await client.responses.create({
            ...requestBody,
            model: resolvedModel,
            stream: false,
          } as Parameters<typeof client.responses.create>[0]);
        } catch (apiError) {
          // 424 means OpenAI could not enumerate the cinatra MCP server's hosted
          // tool list — the instance's public MCP URL was unreachable from the
          // provider (#500). In development that URL is often briefly down
          // (operator restarting a tunnel, local server cycle, etc.); per
          // injection rule skip #3 (MCP unavailable → graceful no-op) we retry
          // WITHOUT the MCP tool, but ONLY when other tools remain. Otherwise (a
          // production/stable URL, or MCP-only) we FAIL LOUD — but with a clear,
          // actionable error naming the unreachable URL instead of the opaque raw
          // 424. We do NOT silently drop the toolbox in production: a run meant to
          // use the cinatra tools would otherwise answer without them.
          const recovery = planMcpToolListErrorRecovery(
            apiError,
            requestBody.tools,
            process.env.CINATRA_RUNTIME_MODE === "development",
          );
          if (recovery.kind === "retry") {
            console.warn("[openai] MCP tool enumeration failed (424) — retrying without MCP tool (dev)");
            const retryBody: Record<string, unknown> = { ...requestBody, tools: recovery.toolsWithoutMcp };
            response = await client.responses.create({
              ...retryBody,
              model: resolvedModel,
              stream: false,
            } as Parameters<typeof client.responses.create>[0]);
          } else if (recovery.kind === "fail") {
            await writeOpenAILogFile({
              label: `${logLabel}-step-${step + 1}`,
              kind: "response",
              body: { error: String(apiError), message: recovery.message },
            }).catch(() => {});
            // ES2017 lib lacks the ErrorOptions.cause type; attach it manually.
            const wrapped = new Error(recovery.message);
            (wrapped as { cause?: unknown }).cause = apiError;
            throw wrapped;
          } else {
            await writeOpenAILogFile({
              label: `${logLabel}-step-${step + 1}`,
              kind: "response",
              body: { error: String(apiError), message: apiError instanceof Error ? apiError.message : undefined },
            }).catch(() => {});
            throw apiError;
          }
        }

        await writeOpenAILogFile({ label: `${logLabel}-step-${step + 1}`, kind: "response", body: response }).catch(() => {});

        // Extract text and tool calls from response output
        const outputItems = (response as { output?: unknown[] }).output ?? [];
        let hasToolCalls = false;
        const toolResultsToAdd: InputItem[] = [];

        // First pass: extract text and collect tool results to execute
        for (const item of outputItems) {
          const typedItem = item as { type?: string; text?: string; call_id?: string; name?: string; arguments?: string };

          if (typedItem.type === "message") {
            const content = (item as { content?: Array<{ type?: string; text?: string }> }).content;
            if (content) {
              for (const part of content) {
                if (part.type === "output_text" && part.text) {
                  finalText = part.text;
                }
              }
            }
          }

          if (typedItem.type === "function_call" && typedItem.name && typedItem.call_id) {
            hasToolCalls = true;
            const tool = findFunctionToolByName(input.tools ?? [], typedItem.name);
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(typedItem.arguments || "{}");
            } catch {
              // Use empty args on parse failure
            }

            const result = tool ? await executeFunctionTool(tool, args) : JSON.stringify({ error: `Unknown tool: ${typedItem.name}` });
            toolResultsToAdd.push({
              type: "function_call_output",
              call_id: typedItem.call_id,
              output: truncateResult(result),
            });
          }

          // Handle native shell tool calls
          if (typedItem.type === "shell_call" && typedItem.call_id) {
            hasToolCalls = true;
            const shellTool = findShellTool(input.tools ?? []);
            const action = (item as { action?: { commands?: string[]; timeout_ms?: number | null; max_output_length?: number | null } }).action;

            if (shellTool && action?.commands) {
              const outputs = await shellTool.execute({
                commands: action.commands,
                timeoutMs: action.timeout_ms,
                maxOutputLength: action.max_output_length,
              });

              toolResultsToAdd.push({
                type: "shell_call_output",
                call_id: typedItem.call_id,
                output: outputs.map((o) => ({
                  stdout: o.stdout,
                  stderr: o.stderr,
                  outcome: o.outcome.type === "exit"
                    ? { type: "exit", exit_code: o.outcome.exitCode }
                    : { type: "timeout" },
                })),
              });
            }
          }
        }

        if (!hasToolCalls) {
          break;
        }

        // Push ALL output items first (including reasoning items), then tool results.
        // OpenAI requires reasoning items to precede any shell_call or function_call
        // that references them — pushing only the tool call item causes a 400 error.
        for (const item of outputItems) {
          inputItems.push(sanitizeOutputItem(item as InputItem));
        }
        for (const result of toolResultsToAdd) {
          inputItems.push(result);
        }
      }

      return {
        text: finalText,
        status: "completed",
        incompleteReason: null,
        rawBody: JSON.stringify({ text: finalText }),
        usage: extractOpenAIUsage(response),
        model: (response as { model?: string })?.model ?? undefined,
      };
    },

    // -----------------------------------------------------------------------
    // stream — streaming with multi-step tool loop
    // -----------------------------------------------------------------------
    async stream(input: StreamInput): Promise<void> {
      const resolvedModel = input.model ?? model;
      const maxSteps = input.maxSteps ?? 6;
      const logLabel = input.logLabel ?? "openai-stream";

      type InputItem = Record<string, unknown>;
      // Per-message resolved parts come from the single source of truth:
      // own resolvedAttachments; request-level fallback only on the last
      // user turn that carried none. Byte-identical when no parts apply.
      const streamEff = resolvedAttachmentsPerMessage(
        input.messages,
        input.resolvedAttachments,
      );
      const inputItems: InputItem[] = input.messages.map((m, i) => ({
        role: m.role,
        content:
          m.role === "user" && streamEff[i]
            ? openaiUserContent(m.content, streamEff[i])
            : m.content,
      }));

      const toolDefs = input.tools ? translateTools(input.tools) : undefined;

      for (let step = 0; step < maxSteps; step++) {
        input.onStepStart(step + 1);

        const requestBody: Record<string, unknown> = {
          model: resolvedModel,
          instructions: input.system,
          input: inputItems,
          ...(toolDefs && toolDefs.length > 0 ? { tools: toolDefs } : {}),
          ...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
          ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
          ...(connection.serviceTier ? { service_tier: connection.serviceTier } : {}),
          store: connection.promptCachingEnabled !== false,
        };

        await writeOpenAILogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: requestBody });

        // Track pending tool calls during this step. Declared at STEP scope (used
        // after the attempt loop below) but RESET at the start of every attempt so
        // a retry-without-MCP (see the recovery block) starts from a clean slate.
        const pendingFunctionCalls: Array<{
          callId: string;
          name: string;
          arguments: string;
        }> = [];
        const pendingShellCalls: Array<{
          callId: string;
          commands: string[];
          timeoutMs: number | null;
          maxOutputLength: number | null;
        }> = [];
        let stepTextEmitted = false;
        let finalResponse: unknown;

        // Mirror the non-streaming 424 handling (#530 CodeRabbit follow-up):
        // `stream()` sends the SAME MCP-injected `tools` payload through
        // `client.responses.stream()`, so a hosted-MCP tool-list 424 (#500) must
        // be classified and either retried-WITHOUT-MCP (dev, other tools remain)
        // or rewritten to the typed `mcpUnreachable` error here too — otherwise a
        // streamed run leaks the raw 424 and misses the MCP remediation CTA. The
        // tool-enumeration 424 fails BEFORE any user-visible delta is emitted, so
        // re-issuing the stream with the MCP tool stripped and re-consuming from a
        // clean slate is safe (no double-emission). `attemptTools` is the payload
        // for the current attempt; a single dev retry sets it to the stripped set.
        let attemptTools = requestBody.tools;
        let recovered = false;
        attempt: for (let attempt = 0; ; attempt++) {
          // Reset per-attempt accumulators (a retry re-runs the whole step).
          pendingFunctionCalls.length = 0;
          pendingShellCalls.length = 0;
          stepTextEmitted = false;

          const attemptBody: Record<string, unknown> = attemptTools
            ? { ...requestBody, tools: attemptTools }
            : requestBody;
          const stream = client.responses.stream({
            ...attemptBody,
            model: resolvedModel,
          } as Parameters<typeof client.responses.stream>[0]);

          let currentFunctionCallIndex = -1;
          // Track the parent output_item type so `response.output_text.delta`
          // events only emit to `onTextDelta` when the parent is a final
          // `message` — never when parent is `reasoning` or
          // `reasoning_summary`. Without this guard, gpt-5.5 reasoning summary
          // text leaks into the chat's user-visible reply. Set to
          // `"message"` by default so providers that don't emit
          // `response.output_item.added` (legacy streams, older Responses API
          // shapes) still produce text on `output_text.delta` as before.
          let currentOutputItemType: string = "message";

          let streamIterationError: Error | null = null;
          try {
            for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
              switch (event.type) {
                case "response.output_text.delta": {
                  // Only emit when the active output_item is a real
                  // user-visible message. Reasoning/reasoning_summary items
                  // also fire `output_text.delta` for their inner text — dropping
                  // those here is the leak fix.
                  if (currentOutputItemType === "message") {
                    stepTextEmitted = true;
                    input.onTextDelta((event as { delta?: string }).delta ?? "");
                  }
                  break;
                }

                case "response.output_item.added": {
                  const addedItem = (event as { item?: { type?: string; call_id?: string; name?: string; action?: { commands?: string[]; timeout_ms?: number | null; max_output_length?: number | null } } }).item;
                  currentOutputItemType = addedItem?.type ?? "message";
                  if (addedItem?.type === "function_call" && addedItem.call_id) {
                    currentFunctionCallIndex = pendingFunctionCalls.length;
                    pendingFunctionCalls.push({
                      callId: addedItem.call_id,
                      name: addedItem.name ?? "",
                      arguments: "",
                    });
                  }
                  if (addedItem?.type === "shell_call" && addedItem.call_id) {
                    pendingShellCalls.push({
                      callId: addedItem.call_id,
                      commands: addedItem.action?.commands ?? [],
                      timeoutMs: addedItem.action?.timeout_ms ?? null,
                      maxOutputLength: addedItem.action?.max_output_length ?? null,
                    });
                  }
                  break;
                }

                case "response.output_item.done": {
                  // Reset to default so a `response.output_text.delta` event
                  // that arrives BEFORE the next `output_item.added` (e.g. in
                  // legacy stream shapes that omit the added event for plain
                  // message items) is still treated as visible message text.
                  currentOutputItemType = "message";
                  break;
                }

                case "response.function_call_arguments.delta": {
                  const delta = (event as { delta?: string }).delta ?? "";
                  if (currentFunctionCallIndex >= 0 && pendingFunctionCalls[currentFunctionCallIndex]) {
                    pendingFunctionCalls[currentFunctionCallIndex].arguments += delta;
                  }
                  break;
                }

                case "response.function_call_arguments.done": {
                  // Function call arguments are complete — will execute after stream ends
                  break;
                }

                case "error": {
                  const errorMsg = (event as { message?: string }).message ?? "OpenAI stream error";
                  input.onError(new Error(errorMsg));
                  break;
                }
              }
            }
          } catch (error) {
            streamIterationError = error instanceof Error ? error : new Error("OpenAI stream failed");
            console.error(`[openai.ts] Stream iteration error at step ${step + 1}:`, streamIterationError.message, streamIterationError);
          }

          // Always attempt finalResponse() — even after a stream iteration error.
          // Native MCP calls suppress response.output_text.delta events; the text
          // lives only in finalResponse().output. If finalResponse() also fails,
          // then we have a real failure and should abort this step.
          let stepError: Error | null = streamIterationError;
          // `classifyError` is what we run the 424 classification against (the
          // raw provider error, so a 424 buried in finalErr is still detected).
          // `surfaceError` is what we hand to `input.onError` for the non-424
          // path — kept BYTE-IDENTICAL to the pre-#530 behavior:
          // `streamIterationError ?? new Error(msg)` (a fresh Error from the
          // message, never the raw finalErr object).
          let classifyError: unknown = streamIterationError;
          try {
            finalResponse = await stream.finalResponse();
            stepError = null;
          } catch (finalErr) {
            const msg = finalErr instanceof Error ? finalErr.message : "finalResponse() failed";
            console.error(`[openai.ts] finalResponse() failed at step ${step + 1}:`, msg);
            stepError = streamIterationError ?? new Error(msg);
            classifyError = streamIterationError ?? finalErr;
          }

          if (!stepError) break attempt; // success — fall through to output handling

          // The attempt failed. Classify it as a hosted-MCP 424 against the
          // tools we actually sent. `none` (any non-424, or already retried) →
          // surface the original error and abort the step, exactly as before.
          const recovery =
            attempt === 0
              ? planMcpToolListErrorRecovery(
                  classifyError,
                  attemptTools,
                  process.env.CINATRA_RUNTIME_MODE === "development",
                )
              : ({ kind: "none" } as const);

          if (recovery.kind === "retry") {
            console.warn("[openai] MCP tool enumeration failed (424) — retrying stream without MCP tool (dev)");
            attemptTools = recovery.toolsWithoutMcp;
            continue attempt;
          }
          if (recovery.kind === "fail") {
            await writeOpenAILogFile({
              label: `${logLabel}-step-${step + 1}`,
              kind: "response",
              body: { error: String(classifyError), message: recovery.message },
            }).catch(() => {});
            // ES2017 lib lacks the ErrorOptions.cause type; attach it manually.
            // Cause is the RAW provider 424 (classifyError), mirroring generate().
            const wrapped = new Error(recovery.message);
            (wrapped as { cause?: unknown }).cause = classifyError;
            input.onError(wrapped);
            recovered = true;
            break attempt;
          }
          // Not a recoverable hosted-MCP 424 — original behavior: surface the
          // pre-#530 `streamIterationError ?? new Error(msg)` error and stop.
          input.onError(stepError);
          recovered = true;
          break attempt;
        }
        if (recovered) break; // a real (non-recoverable) step error was surfaced
        await writeOpenAILogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "response",
          body: { status: (finalResponse as { status?: string }).status, output: (finalResponse as { output?: unknown }).output },
        });

        // Fallback: when native MCP tool calls are handled server-side by OpenAI, the
        // response.output_text.delta stream events may not fire even though text is present
        // in finalResponse().output. Extract and emit any un-streamed text now.
        //
        // Item-type guard mirrors the streaming filter: ONLY `message` items
        // contain user-visible content. `reasoning` / `reasoning_summary` /
        // shell/function/mcp items are dropped here to prevent gpt-5.5
        // reasoning summary text leaking into the chat reply.
        if (!stepTextEmitted) {
          const outputItems = (finalResponse as { output?: unknown[] }).output ?? [];
          for (const item of outputItems) {
            const typedItem = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
            if (typedItem.type === "message" && Array.isArray(typedItem.content)) {
              for (const part of typedItem.content) {
                if (part.type === "output_text" && typeof part.text === "string" && part.text) {
                  input.onTextDelta(part.text);
                  stepTextEmitted = true;
                }
              }
            }
          }
        }

        // Emit tool call/result events for native MCP calls handled server-side by OpenAI.
        // These never fire response.output_item.added events during streaming, so we
        // extract them from finalResponse().output after each step.
        {
          const outputItems = (finalResponse as { output?: unknown[] }).output ?? [];
          for (const item of outputItems) {
            const mc = item as { type?: string; id?: string; name?: string; server_label?: string; arguments?: string; output?: string; status?: string };
            if (mc.type === "mcp_call" && mc.id && mc.name) {
              let args: Record<string, unknown> = {};
              try { args = mc.arguments ? JSON.parse(mc.arguments) : {}; } catch { /* keep empty */ }
              input.onToolCall({ id: mc.id, name: mc.name, arguments: args, serverLabel: mc.server_label });
              input.onToolResult({ id: mc.id, name: mc.name, result: mc.output ?? "", serverLabel: mc.server_label });
            }
          }
        }

        // Extract URL citations from text content annotations (web_search results)
        if (input.onCitations) {
          const outputItemsForCitations = (finalResponse as { output?: unknown[] }).output ?? [];
          const citations: Array<{ index: number; title: string; url: string }> = [];
          let citationIndex = 1;
          for (const item of outputItemsForCitations) {
            const typedItem = item as { type?: string; content?: Array<{ type?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }> };
            if (typedItem.type === "message" && Array.isArray(typedItem.content)) {
              for (const part of typedItem.content) {
                if (part.type === "output_text" && Array.isArray(part.annotations)) {
                  const seen = new Set<string>();
                  for (const ann of part.annotations) {
                    if (ann.type === "url_citation" && typeof ann.url === "string" && ann.url && !seen.has(ann.url)) {
                      seen.add(ann.url);
                      citations.push({ index: citationIndex++, title: ann.title ?? "", url: ann.url });
                    }
                  }
                }
              }
            }
          }
          if (citations.length > 0) {
            input.onCitations(citations);
          }
        }

        input.onStepEnd(step + 1);

        // If there are no tool calls, we're done
        if (pendingFunctionCalls.length === 0 && pendingShellCalls.length === 0) {
          if (input.onUsageData) {
            const usage = extractOpenAIUsage(finalResponse);
            if (usage) input.onUsageData(usage);
          }
          break;
        }

        // Add assistant output items to input for next step
        const outputItems = (finalResponse as { output?: unknown[] }).output ?? [];
        for (const item of outputItems) {
          inputItems.push(sanitizeOutputItem(item as InputItem));
        }

        // Execute function tool calls
        for (const tc of pendingFunctionCalls) {
          const originalName = tc.name;
          const toolCallEvent: LlmToolCall = {
            id: tc.callId,
            name: originalName,
            arguments: {},
          };

          try {
            toolCallEvent.arguments = JSON.parse(tc.arguments || "{}");
          } catch {
            // Use empty args
          }

          input.onToolCall(toolCallEvent);

          const tool = findFunctionToolByName(input.tools ?? [], tc.name);
          const result = tool
            ? await executeFunctionTool(tool, toolCallEvent.arguments)
            : JSON.stringify({ error: `Unknown tool: ${originalName}` });

          const truncated = truncateResult(result);

          input.onToolResult({
            id: tc.callId,
            name: originalName,
            result: truncated,
          });

          inputItems.push({
            type: "function_call_output",
            call_id: tc.callId,
            output: truncated,
          });
        }

        // Execute shell tool calls
        for (const sc of pendingShellCalls) {
          const shellTool = findShellTool(input.tools ?? []);

          input.onToolCall({
            id: sc.callId,
            name: "shell",
            arguments: { commands: sc.commands },
          });

          if (shellTool) {
            const outputs = await shellTool.execute({
              commands: sc.commands,
              timeoutMs: sc.timeoutMs,
              maxOutputLength: sc.maxOutputLength,
            });

            const resultSummary = outputs.map((o) =>
              `stdout: ${o.stdout.slice(0, 500)}${o.stderr ? `\nstderr: ${o.stderr.slice(0, 200)}` : ""}`
            ).join("\n---\n");

            input.onToolResult({
              id: sc.callId,
              name: "shell",
              result: truncateResult(resultSummary),
            });

            inputItems.push({
              type: "shell_call_output",
              call_id: sc.callId,
              output: outputs.map((o) => ({
                stdout: o.stdout,
                stderr: o.stderr,
                outcome: o.outcome.type === "exit"
                  ? { type: "exit", exit_code: o.outcome.exitCode }
                  : { type: "timeout" },
              })),
            });
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // generateWithFileInput — for file_id references (OpenAI-specific)
    // -----------------------------------------------------------------------
    async generateWithFileInput(input: FileInputGenerateInput): Promise<LlmResponse> {
      const resolvedModel = input.model ?? model;
      const logLabel = input.logLabel ?? "openai-file-input";

      const requestBody = {
        model: resolvedModel,
        instructions: input.system,
        input: [
          {
            role: "user" as const,
            content: [
              { type: "input_text" as const, text: input.prompt },
              { type: "input_file" as const, file_id: input.fileId },
            ],
          },
        ],
        ...(input.maxTokens ? { max_output_tokens: input.maxTokens } : {}),
        ...(input.outputSchema
          ? { text: { format: { type: "json_schema" as const, name: "response", schema: input.outputSchema } } }
          : {}),
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        ...(connection.serviceTier ? { service_tier: connection.serviceTier } : {}),
      };

      await writeOpenAILogFile({ label: logLabel, kind: "request", body: requestBody });

      const response = await client.responses.create({
        ...requestBody,
        stream: false,
      } as Parameters<typeof client.responses.create>[0]);

      await writeOpenAILogFile({ label: logLabel, kind: "response", body: response });

      // Extract text from response
      let text: string | null = null;
      const outputItems = (response as { output?: unknown[] }).output ?? [];
      for (const item of outputItems) {
        const content = (item as { content?: Array<{ type?: string; text?: string }> }).content;
        if (content) {
          for (const part of content) {
            if (part.type === "output_text" && part.text) {
              text = part.text;
            }
          }
        }
      }

      return {
        text,
        status: (response as { status?: string }).status ?? null,
        incompleteReason: null,
        rawBody: JSON.stringify(response),
      };
    },

    // -----------------------------------------------------------------------
    // uploadFile — upload a file via OpenAI Files API
    // -----------------------------------------------------------------------
    async uploadFile(input: UploadFileInput): Promise<LlmFileReference> {
      const file = new File([new Uint8Array(input.content)], input.filename, { type: input.mimeType });
      const uploaded = await client.files.create({
        file,
        purpose: (input.purpose ?? "user_data") as "assistants" | "fine-tune" | "batch" | "user_data" | "evals",
      });
      return { id: uploaded.id, provider: "openai" };
    },

    // -----------------------------------------------------------------------
    // deleteFile — delete an uploaded file
    // -----------------------------------------------------------------------
    async deleteFile(fileRef: LlmFileReference): Promise<void> {
      await client.files.delete(fileRef.id).catch(() => {
        // Silently ignore deletion failures (file may already be gone)
      });
    },

    // -----------------------------------------------------------------------
    // listModels — list available models from OpenAI
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
    // submitBatch
    // Convert each LlmBatchRequest into a JSONL line of the documented
    // OpenAI batch input shape, upload the file with purpose: "batch", then
    // create the batch against /v1/chat/completions with a 24h window.
    // -----------------------------------------------------------------------
    async submitBatch(input: LlmBatchSubmitInput): Promise<LlmBatchSubmitResult> {
      const jsonl = input.requests
        .map((req) => JSON.stringify({
          custom_id: req.customId,
          method: "POST",
          url: "/v1/chat/completions",
          body: req.body,
        }))
        .join("\n");
      const buffer = Buffer.from(jsonl, "utf-8");
      const file = new File([new Uint8Array(buffer)], "batch-input.jsonl", {
        type: "application/jsonl",
      });
      const uploaded = await client.files.create({
        file,
        purpose: "batch",
      });
      const batch = await client.batches.create({
        input_file_id: uploaded.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
        metadata: input.metadata ?? undefined,
      });
      return {
        batchId: batch.id,
        inputFileId: uploaded.id,
        status: batch.status as LlmBatchStatus,
      };
    },

    // -----------------------------------------------------------------------
    // retrieveBatch
    // Map the OpenAI batch retrieve response into the unified shape.
    // completed_at is unix-seconds; convert to ISO. Errors collapse to the
    // first message string for caller convenience (full error file is still
    // available via downloadBatchResults(error_file_id)).
    // -----------------------------------------------------------------------
    async retrieveBatch(batchId: string): Promise<LlmBatchResult> {
      const batch = await client.batches.retrieve(batchId);
      return {
        batchId: batch.id,
        status: batch.status as LlmBatchStatus,
        inputFileId: batch.input_file_id,
        outputFileId: batch.output_file_id ?? null,
        errorFileId: batch.error_file_id ?? null,
        completedAt: batch.completed_at
          ? new Date(batch.completed_at * 1000).toISOString()
          : null,
        errorMessage: batch.errors?.data?.[0]?.message ?? null,
      };
    },

    // -----------------------------------------------------------------------
    // downloadBatchResults
    // Pull the JSONL content for the given file id (output_file_id or
    // error_file_id), split by newline, and parse each row into the
    // unified LlmBatchOutputLine shape.
    // -----------------------------------------------------------------------
    async downloadBatchResults(fileId: string): Promise<LlmBatchOutputLine[]> {
      const response = await client.files.content(fileId);
      const text = await response.text();
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      return lines.map((line) => {
        const parsed = JSON.parse(line) as {
          custom_id: string;
          response?: { status_code: number; body: Record<string, unknown> };
          error?: { code: string; message: string };
        };
        return {
          customId: parsed.custom_id,
          response: parsed.response ?? null,
          error: parsed.error ?? null,
        };
      });
    },

    // -----------------------------------------------------------------------
    // cancelBatch
    // Cancel an in-progress batch and return its updated status.
    // -----------------------------------------------------------------------
    async cancelBatch(batchId: string): Promise<{ batchId: string; status: LlmBatchStatus }> {
      const batch = await client.batches.cancel(batchId);
      return {
        batchId: batch.id,
        status: batch.status as LlmBatchStatus,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Connection helpers (re-exported for use by the registry)
// ---------------------------------------------------------------------------

export async function getConfiguredOpenAIConnection(
  connection?: OpenAIConnectionConfig | null,
): Promise<OpenAILlmConnection | null> {
  const getConfiguredConnection = getLlmProviderSurface("openai")?.getConfiguredConnection;
  if (typeof getConfiguredConnection !== "function") {
    // Degraded: connector absent/inactive ⇒ "not configured" (the registry's
    // existing null-adapter semantics — no new error class).
    return null;
  }
  return ((await getConfiguredConnection(connection ?? undefined)) ?? null) as
    | OpenAILlmConnection
    | null;
}
