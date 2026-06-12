import "server-only";

import { GoogleGenAI, FileState } from "@google/genai";
import type { FunctionDeclaration, Content, Part } from "@google/genai";
// LLM provider adapter cutover (cinatra#151 Stage 2): the connector's API-key
// reader, request-header builder and telemetry log writer resolve through the
// `llm-provider-surface` capability at call time — packages/llm carries NO
// value-import of any connector package.
import { getLlmProviderSurface, requireLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import type {
  LlmProviderAdapter,
  LlmTool,
  LlmFunctionTool,
  LlmToolCall,
  GenerateInput,
  StreamInput,
  LlmResponse,
  LlmUsageData,
} from "../types";
// Guarded native attachment emission.
import {
  geminiUserParts,
  resolvedAttachmentsPerMessage,
} from "../attachments/provider-parts";
import { BatchNotSupportedError } from "../errors";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const MAX_TOOL_RESULT_CHARS = 8000;

// ---------------------------------------------------------------------------
// Capability-resolved connector members
// ---------------------------------------------------------------------------

/** API key via the gemini surface; absent surface/member ⇒ null (not configured). */
async function getConfiguredGeminiAPIKey(): Promise<string | null> {
  const getConfiguredAPIKey = getLlmProviderSurface("gemini")?.getConfiguredAPIKey;
  if (typeof getConfiguredAPIKey !== "function") return null;
  return (await getConfiguredAPIKey()) ?? null;
}

/**
 * Request headers via the gemini surface. The adapter only exists once an API
 * key resolved through the SAME surface, so a missing member here is a
 * connector-version/registration defect, not a degraded mode — fail loud
 * with a descriptive error (design review MEDIUM: never silently default,
 * the headers carry the host self-client identity).
 */
function buildGeminiRequestHeaders(input: {
  apiKey?: string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const surface = requireLlmProviderSurface("gemini");
  if (typeof surface.buildRequestHeaders !== "function") {
    throw new Error(
      'The "gemini" LLM provider connector is active but does not expose ' +
        "buildRequestHeaders — the installed connector predates the Stage 2 " +
        "surface (cinatra#151); update/re-acquire the gemini connector.",
    );
  }
  return surface.buildRequestHeaders(input);
}

/**
 * Best-effort request/response logging through the gemini surface's
 * `writeLogFile` member. Surface or member absent ⇒ no-op; when present, the
 * connector's own enabled-check/fs-error semantics apply unchanged.
 */
async function writeGeminiLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}): Promise<void> {
  const writeLogFile = getLlmProviderSurface("gemini")?.writeLogFile;
  if (typeof writeLogFile !== "function") return;
  await writeLogFile(input);
}

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

function createClient(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: buildGeminiRequestHeaders({}),
    },
  });
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function isFunctionTool(tool: LlmTool): tool is LlmFunctionTool {
  return !("type" in tool) || tool.type === "function" || tool.type === undefined;
}

function isShellTool(tool: LlmTool): tool is import("../types").LlmShellTool {
  return "type" in tool && tool.type === "shell";
}

// ---------------------------------------------------------------------------
// Tool translation
// ---------------------------------------------------------------------------

/**
 * Translate unified tools to Gemini function declarations.
 * Gemini has no native shell/MCP support, so:
 * - Shell tools are wrapped as a function declaration (the execute
 *   function is called when the model invokes it)
 * - MCP tools are not supported (MCP primitives must be registered
 *   as function tools separately for Gemini)
 */
function translateTools(tools: LlmTool[]): FunctionDeclaration[] {
  const defs: FunctionDeclaration[] = [];

  for (const t of tools) {
    if (isFunctionTool(t)) {
      defs.push({
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as FunctionDeclaration["parameters"],
      });
    } else if (isShellTool(t)) {
      // Wrap shell tool as a function declaration for Gemini
      defs.push({
        name: "shell",
        description: "Execute shell commands in a sandboxed environment. " +
          (t.skills.length > 0
            ? `Available skills: ${t.skills.map((s) => `${s.name} (${s.description})`).join(", ")}`
            : ""),
        parameters: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              items: { type: "string" },
              description: "Shell commands to execute",
            },
          },
          required: ["commands"],
        } as unknown as FunctionDeclaration["parameters"],
      });
    }
    // MCP tools: not supported by Gemini — register as function tools instead
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

async function executeTool(tool: LlmFunctionTool, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await tool.execute(args);
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "Tool execution failed." });
  }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function extractGeminiUsage(usageMetadata: unknown): LlmUsageData | undefined {
  const meta = usageMetadata as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  } | null | undefined;
  if (!meta) return undefined;
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    cachedInputTokens: meta.cachedContentTokenCount ?? 0,
    reasoningOutputTokens: meta.thoughtsTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

export function createGeminiProviderAdapter(apiKey: string): LlmProviderAdapter {
  const client = createClient(apiKey);

  return {
    provider: "gemini",
    defaultModel: DEFAULT_GEMINI_MODEL,

    // -----------------------------------------------------------------------
    // generate — non-streaming, with optional multi-step tool loop
    // -----------------------------------------------------------------------
    async generate(input: GenerateInput): Promise<LlmResponse> {
      const resolvedModel = input.model ?? DEFAULT_GEMINI_MODEL;
      const maxSteps = input.maxSteps ?? 1;
      const logLabel = input.logLabel ?? "gemini-generate";

      const toolDefs = input.tools ? translateTools(input.tools) : undefined;
      // Prepend prior conversation messages before the current prompt for resume support.
      // Map LlmMessage roles to Gemini roles (assistant -> model)
      const contents: Content[] = [];
      if (input.messages && input.messages.length > 0) {
        for (const m of input.messages) {
          contents.push({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          });
        }
      }
      contents.push({
        role: "user",
        parts: geminiUserParts(input.prompt, input.resolvedAttachments),
      });

      let finalText: string | null = null;
      let response: Awaited<ReturnType<typeof client.models.generateContent>> | undefined;

      for (let step = 0; step < maxSteps; step++) {
        const requestPreview = {
          model: resolvedModel,
          contents,
          config: {
            systemInstruction: input.system,
            maxOutputTokens: input.maxTokens ?? 900,
            responseMimeType: input.outputSchema ? "application/json" : undefined,
            responseJsonSchema: input.outputSchema,
          },
          ...(toolDefs ? { tools: [{ functionDeclarations: toolDefs }] } : {}),
        };

        await writeGeminiLogFile({ label: `${logLabel}-step-${step + 1}`, kind: "request", body: requestPreview });

        response = await client.models.generateContent({
          model: resolvedModel,
          contents,
          config: {
            systemInstruction: input.system,
            maxOutputTokens: input.maxTokens ?? 900,
            responseMimeType: input.outputSchema ? "application/json" : undefined,
            responseJsonSchema: input.outputSchema,
            abortSignal: input.signal,
            ...(toolDefs ? { tools: [{ functionDeclarations: toolDefs }] } : {}),
          },
        });

        await writeGeminiLogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "response",
          body: {
            text: response.text ?? null,
            functionCalls: response.functionCalls ?? null,
          },
        });

        if (response.text) {
          finalText = response.text;
        }

        // Check for function calls
        const functionCalls = response.functionCalls;
        if (!functionCalls || functionCalls.length === 0) {
          break;
        }

        // Add model response to contents
        const modelParts: Part[] = [];
        if (response.text) {
          modelParts.push({ text: response.text });
        }
        for (const fc of functionCalls) {
          modelParts.push({
            functionCall: { name: fc.name ?? "", args: fc.args ?? {} },
          });
        }
        contents.push({ role: "model", parts: modelParts });

        // Execute tools and add results
        const resultParts: Part[] = [];
        for (const fc of functionCalls) {
          // Handle shell tool calls by finding the LlmShellTool
          if (fc.name === "shell") {
            const shellTool = input.tools?.find(isShellTool);
            const shellArgs = (fc.args ?? {}) as Record<string, unknown>;
            const commands = Array.isArray(shellArgs.commands) ? shellArgs.commands as string[] : [];
            if (shellTool && commands.length > 0) {
              const outputs = await shellTool.execute({ commands, timeoutMs: null, maxOutputLength: null });
              const resultSummary = outputs.map((o) =>
                `${o.stdout}${o.stderr ? `\nstderr: ${o.stderr}` : ""}`
              ).join("\n---\n");

              let parsedResult: Record<string, unknown>;
              try { parsedResult = JSON.parse(truncateResult(resultSummary)); } catch { parsedResult = { result: truncateResult(resultSummary) }; }
              resultParts.push({ functionResponse: { name: fc.name, response: parsedResult } });
              continue;
            }
          }

          const tool = input.tools?.filter(isFunctionTool).find((t) => t.name === fc.name);
          const args = (fc.args ?? {}) as Record<string, unknown>;
          const result = tool
            ? await executeTool(tool, args)
            : JSON.stringify({ error: `Unknown tool: ${fc.name}` });

          let parsedResult: Record<string, unknown>;
          try {
            parsedResult = JSON.parse(truncateResult(result));
          } catch {
            parsedResult = { result: truncateResult(result) };
          }

          resultParts.push({
            functionResponse: {
              name: fc.name ?? "",
              response: parsedResult,
            },
          });
        }
        contents.push({ role: "user", parts: resultParts });
      }

      return {
        text: finalText,
        status: null,
        incompleteReason: null,
        rawBody: JSON.stringify({ text: finalText }),
        usage: extractGeminiUsage(response?.usageMetadata),
        model: response?.modelVersion ?? resolvedModel,
      };
    },

    // -----------------------------------------------------------------------
    // stream — streaming with multi-step tool loop
    // -----------------------------------------------------------------------
    async stream(input: StreamInput): Promise<void> {
      const resolvedModel = input.model ?? DEFAULT_GEMINI_MODEL;
      const maxSteps = input.maxSteps ?? 6;
      const logLabel = input.logLabel ?? "gemini-stream";

      const toolDefs = input.tools ? translateTools(input.tools) : undefined;
      // Per-message resolved parts come from the single source of truth
      // (own resolvedAttachments; request-level
      // fallback only on the last user turn that carried none).
      // Byte-identical when no parts apply.
      const streamEff = resolvedAttachmentsPerMessage(
        input.messages,
        input.resolvedAttachments,
      );
      const contents: Content[] = input.messages.map((m, i) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          m.role === "user" && streamEff[i]
            ? geminiUserParts(m.content, streamEff[i])
            : [{ text: m.content }],
      }));

      for (let step = 0; step < maxSteps; step++) {
        input.onStepStart(step + 1);

        await writeGeminiLogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "request",
          body: { model: resolvedModel, contents, tools: toolDefs ? [{ functionDeclarations: toolDefs }] : undefined },
        });

        const response = await client.models.generateContentStream({
          model: resolvedModel,
          contents,
          config: {
            systemInstruction: input.system,
            maxOutputTokens: input.maxTokens ?? 4096,
            abortSignal: input.signal,
            ...(toolDefs ? { tools: [{ functionDeclarations: toolDefs }] } : {}),
          },
        });

        let fullText = "";
        const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
        let lastUsageMetadata: unknown = null;

        try {
          for await (const chunk of response) {
            const text = chunk.text;
            if (text) {
              fullText += text;
              input.onTextDelta(text);
            }

            // Collect function calls from chunks
            if (chunk.functionCalls) {
              for (const fc of chunk.functionCalls) {
                functionCalls.push({
                  name: fc.name ?? "",
                  args: (fc.args ?? {}) as Record<string, unknown>,
                });
              }
            }

            // Track usageMetadata — may be null on some chunks (Gemini 2.5 Pro known issue)
            if (chunk.usageMetadata) {
              lastUsageMetadata = chunk.usageMetadata;
            }
          }
        } catch (error) {
          input.onError(error instanceof Error ? error : new Error("Gemini stream failed"));
          break;
        }

        await writeGeminiLogFile({
          label: `${logLabel}-step-${step + 1}`,
          kind: "response",
          body: { text: fullText || null, functionCalls: functionCalls.length > 0 ? functionCalls : null },
        });

        input.onStepEnd(step + 1);

        if (functionCalls.length === 0) {
          if (input.onUsageData) {
            const usage = extractGeminiUsage(lastUsageMetadata);
            // usage may be undefined if usageMetadata was null on all chunks (Gemini 2.5 Pro known issue)
            if (usage) input.onUsageData(usage);
          }
          break;
        }

        // Add model response to contents
        const modelParts: Part[] = [];
        if (fullText) {
          modelParts.push({ text: fullText });
        }
        for (const fc of functionCalls) {
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
        }
        contents.push({ role: "model", parts: modelParts });

        // Execute tools and add results
        const resultParts: Part[] = [];
        for (const fc of functionCalls) {
          const toolCallEvent: LlmToolCall = {
            id: `${fc.name}-${step}`,
            name: fc.name,
            arguments: fc.args,
          };
          input.onToolCall(toolCallEvent);

          // Handle shell tool calls by finding the LlmShellTool
          if (fc.name === "shell") {
            const shellTool = input.tools?.find(isShellTool);
            const shellArgs = (fc.args ?? {}) as Record<string, unknown>;
            const commands = Array.isArray(shellArgs.commands) ? shellArgs.commands as string[] : [];
            if (shellTool && commands.length > 0) {
              const outputs = await shellTool.execute({ commands, timeoutMs: null, maxOutputLength: null });
              const resultSummary = outputs.map((o) =>
                `${o.stdout}${o.stderr ? `\nstderr: ${o.stderr}` : ""}`
              ).join("\n---\n");

              let parsedResult: Record<string, unknown>;
              try { parsedResult = JSON.parse(truncateResult(resultSummary)); } catch { parsedResult = { result: truncateResult(resultSummary) }; }
              resultParts.push({ functionResponse: { name: fc.name, response: parsedResult } });
              continue;
            }
          }

          const tool = input.tools?.filter(isFunctionTool).find((t) => t.name === fc.name);
          const result = tool
            ? await executeTool(tool, fc.args)
            : JSON.stringify({ error: `Unknown tool: ${fc.name}` });

          const truncated = truncateResult(result);

          input.onToolResult({
            id: toolCallEvent.id,
            name: fc.name,
            result: truncated,
          });

          let parsedResult: Record<string, unknown>;
          try {
            parsedResult = JSON.parse(truncated);
          } catch {
            parsedResult = { result: truncated };
          }

          resultParts.push({
            functionResponse: { name: fc.name, response: parsedResult },
          });
        }
        contents.push({ role: "user", parts: resultParts });
      }
    },

    // -----------------------------------------------------------------------
    // uploadFile — upload a file to Gemini Files API
    // -----------------------------------------------------------------------
    async uploadFile(input: import("../types").UploadFileInput): Promise<import("../types").LlmFileReference> {
      const uploaded = await client.files.upload({
        file: new Blob([new Uint8Array(input.content)], { type: input.mimeType }),
        config: {
          displayName: input.filename,
          mimeType: input.mimeType,
        },
      });

      // The Gemini Files API returns BOTH a resource `name` (`files/<id>`) and a request
      // `uri` (`https://…/v1beta/files/<id>`). A `fileData.fileUri` part
      // REQUIRES the `uri` — emitting the resource `name` makes Gemini
      // SILENTLY ignore the file (the model never sees the attachment). So
      // `id` carries the `uri`; `deleteFile` normalizes it back to the
      // resource name for the delete round-trip. FAIL CLOSED when `uri` is
      // absent (no `?? name` fallback): a missing uri must degrade the
      // attachment to the not-readable manifest (Decision A) — NEVER emit a
      // known-unusable native part that fails silently.
      const fileUri = uploaded.uri;
      if (!fileUri) {
        throw new Error(
          "Gemini file upload did not return a uri (cannot emit a usable fileData.fileUri).",
        );
      }

      // PROCESSING→ACTIVE poll. The Gemini Files
      // API accepts the upload immediately but transitions the file
      // through PROCESSING before it is usable as a `fileData.fileUri`
      // part. Emitting the URI to `generateContent` while state is
      // PROCESSING produces a 400 (the model cannot read the file
      // yet). Poll until ACTIVE, fail closed on FAILED, fail closed
      // on timeout. Small/text files often skip PROCESSING entirely
      // (uploaded.state === ACTIVE on return) — the fast path is the
      // common case; the poll only runs when needed.
      const initialState = uploaded.state;
      if (initialState !== FileState.ACTIVE) {
        const fileName = uploaded.name;
        if (!fileName) {
          throw new Error(
            "Gemini file upload returned no resource name; cannot poll for ACTIVE state.",
          );
        }
        // Poll budget: ~60s total. Backoff starts at 500ms, doubles
        // up to 5s cap. Typical PDFs / images go ACTIVE in <2s; the
        // upper bound covers larger media (video, multi-page PDFs).
        // Clamp each sleep to the remaining deadline so the wall-clock budget
        // is strict (no overshoot
        // by up to a full backoff interval at the tail).
        const deadline = Date.now() + 60_000;
        let delayMs = 500;
        let lastState: FileState | undefined = initialState;
        let lastError: string | null = null;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const sleep = Math.min(delayMs, remaining);
          if (sleep <= 0) break;
          await new Promise((r) => setTimeout(r, sleep));
          delayMs = Math.min(delayMs * 2, 5_000);
          const refreshed = await client.files.get({ name: fileName });
          lastState = refreshed.state;
          if (lastState === FileState.ACTIVE) {
            break;
          }
          if (lastState === FileState.FAILED) {
            // `error` is a FileStatus on the @google/genai File type
            // (output-only). Surface its message + code if present so
            // callers can degrade the attachment to a manifest.
            const err = refreshed.error as
              | { message?: string; code?: number }
              | undefined;
            lastError = err?.message ?? `code=${err?.code ?? "?"}`;
            break;
          }
        }
        if (lastState !== FileState.ACTIVE) {
          throw new Error(
            lastState === FileState.FAILED
              ? `Gemini file upload FAILED (${lastError ?? "no error details"}).`
              : `Gemini file upload did not reach ACTIVE within 60s (last state: ${lastState ?? "unknown"}).`,
          );
        }
      }

      return { id: fileUri, provider: "gemini" };
    },

    // -----------------------------------------------------------------------
    // deleteFile — delete an uploaded file
    // -----------------------------------------------------------------------
    async deleteFile(fileRef: import("../types").LlmFileReference): Promise<void> {
      try {
        // fileRef.id may be a Gemini request `uri` (new attachment/cache
        // path) or a legacy resource `name`. client.files.delete needs the
        // resource name `files/<id>` — extract it from either form.
        const m = fileRef.id.match(/files\/[^/?#]+/);
        const name = m ? m[0] : fileRef.id;
        await client.files.delete({ name });
      } catch {
        // Silently ignore
      }
    },

    // -----------------------------------------------------------------------
    // generateFromMediaFile — transcription from audio/video
    // -----------------------------------------------------------------------
    async generateFromMediaFile(input: {
      model?: string;
      system: string;
      mediaFileUri: string;
      mimeType: string;
      logLabel?: string;
    }): Promise<import("../types").LlmResponse> {
      const resolvedModel = input.model ?? DEFAULT_GEMINI_MODEL;
      const logLabel = input.logLabel ?? "gemini-media-generate";

      await writeGeminiLogFile({
        label: logLabel,
        kind: "request",
        body: { model: resolvedModel, system: input.system, mediaFileUri: input.mediaFileUri, mimeType: input.mimeType },
      });

      const response = await client.models.generateContent({
        model: resolvedModel,
        contents: [
          {
            role: "user",
            parts: [
              { text: input.system },
              {
                fileData: {
                  mimeType: input.mimeType,
                  fileUri: input.mediaFileUri,
                },
              },
            ],
          },
        ],
        config: {
          temperature: 0.2,
        },
      });

      // Extract usage metadata so the media
      // branch emits non-zero token counts to cinatra.usage_events.
      // Dropping `response.usageMetadata` makes the metrics-cost table receive
      // { inputTokens: 0, outputTokens: 0 }
      // for every Gemini media call — defeating cost tracking for the
      // entire transcription flow.
      const mediaUsage = extractGeminiUsage(response?.usageMetadata);
      await writeGeminiLogFile({
        label: logLabel,
        kind: "response",
        body: { text: response.text ?? null, usage: mediaUsage ?? null },
      });

      return {
        text: response.text ?? null,
        status: null,
        incompleteReason: null,
        usage: mediaUsage,
        rawBody: JSON.stringify({
          text: response.text ?? null,
          usage: mediaUsage,
        }),
      };
    },

    // -----------------------------------------------------------------------
    // generateImage — image generation via Gemini
    // -----------------------------------------------------------------------
    async generateImage(input: {
      model?: string;
      prompt: string;
      logLabel?: string;
    }): Promise<{ imageData: string; mimeType: string } | null> {
      const imageModel = input.model ?? "gemini-2.5-flash-image";
      const logLabel = input.logLabel ?? "gemini-image-generate";

      await writeGeminiLogFile({
        label: logLabel,
        kind: "request",
        body: { model: imageModel, prompt: input.prompt },
      });

      const response = await client.models.generateContent({
        model: imageModel,
        contents: input.prompt,
        config: {
          responseModalities: ["image"],
          imageConfig: {
            aspectRatio: "16:9",
          } as Record<string, unknown>,
        } as Record<string, unknown>,
      });

      // Extract inline image data from response
      const candidates = response.candidates ?? [];
      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          const inlineData = part.inlineData;
          if (inlineData?.mimeType && inlineData?.data) {
            await writeGeminiLogFile({
              label: logLabel,
              kind: "response",
              body: { mimeType: inlineData.mimeType, dataLength: inlineData.data.length },
            });
            return { imageData: inlineData.data, mimeType: inlineData.mimeType };
          }
        }
      }

      await writeGeminiLogFile({
        label: logLabel,
        kind: "response",
        body: { error: "No image returned" },
      });

      return null;
    },

    // -----------------------------------------------------------------------
    // listModels — list available Gemini models
    // -----------------------------------------------------------------------
    async listModels(): Promise<string[]> {
      const pager = await client.models.list();
      const models: string[] = [];
      for await (const model of pager) {
        if (model.name) {
          // Gemini model names are like "models/gemini-2.5-flash" — strip the prefix
          const name = model.name.replace(/^models\//, "");
          models.push(name);
        }
      }
      return models.sort((a, b) => a.localeCompare(b));
    },

    // -----------------------------------------------------------------------
    // Batch API stubs: Gemini does NOT support OpenAI-style
    // /v1/chat/completions batching). Throw rather than return null so callers
    // see the gap explicitly.
    // -----------------------------------------------------------------------
    async submitBatch() { throw new BatchNotSupportedError("gemini"); },
    async retrieveBatch() { throw new BatchNotSupportedError("gemini"); },
    async downloadBatchResults() { throw new BatchNotSupportedError("gemini"); },
    async cancelBatch() { throw new BatchNotSupportedError("gemini"); },
  };
}

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

export async function getConfiguredGeminiConnection() {
  const apiKey = await getConfiguredGeminiAPIKey();
  if (!apiKey) {
    return null;
  }
  return { apiKey, defaultModel: DEFAULT_GEMINI_MODEL };
}
