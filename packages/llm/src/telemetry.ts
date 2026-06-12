/**
 * Unified LLM telemetry / logging.
 *
 * Provides a write function for Anthropic logs (parallel to the existing
 * writeOpenAILogFile and writeGeminiLogFile), and a unified logging helper
 * that routes to the correct provider log writer.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
// LLM provider adapter cutover (cinatra#151 Stage 2): the openai/gemini log
// writers resolve through each connector's `llm-provider-surface`
// registration at call time — packages/llm carries NO connector
// value-imports. Surface/member absent ⇒ no-op (best-effort logging).
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { redactAuthorizationDeep } from "./log-redaction";
import type { LlmProvider } from "./types";
import { ANTHROPIC_API_LOG_DIRECTORY } from "./anthropic-log-directory";
import { isAnthropicLoggingEnabled, setAnthropicLoggingEnabled } from "./anthropic-logging-state";

// ---------------------------------------------------------------------------
// Anthropic log writer (mirrors writeOpenAILogFile / writeGeminiLogFile)
// ---------------------------------------------------------------------------

// Re-exported for barrel back-compat; the source-of-truth leaf modules are
// dependency-free so src/lib/logging.ts can import them without dragging the
// heavy @cinatra-ai/llm barrel into a module-init cycle.
export { ANTHROPIC_API_LOG_DIRECTORY };
export { setAnthropicLoggingEnabled };

const MAX_ANTHROPIC_LOG_FILES = 200;

export function getAnthropicLoggingSettings() {
  return {
    enabled: isAnthropicLoggingEnabled(),
    directory: ANTHROPIC_API_LOG_DIRECTORY,
  };
}

function sanitizeLogLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "anthropic-call"
  );
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeAnthropicLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isAnthropicLoggingEnabled()) {
    return;
  }

  await mkdir(ANTHROPIC_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const rawContent = typeof input.body === "string" ? { raw: input.body } : input.body;
  // Strip Bearer tokens from MCP headers / authorization_token before they hit
  // disk. Provider request bodies carry the resolved Authorization header for
  // every injected MCP server.
  const content = redactAuthorizationDeep(rawContent);
  await writeFile(path.join(ANTHROPIC_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");

  // Non-blocking log rotation — prune oldest files when over limit.
  // Runs asynchronously to avoid slowing down the API call path.
  void pruneAnthropicLogs().catch(() => {});
}

async function pruneAnthropicLogs() {
  const entries = await readdir(ANTHROPIC_API_LOG_DIRECTORY);
  if (entries.length <= MAX_ANTHROPIC_LOG_FILES) return;

  // Files are named with ISO timestamps, so alphabetical sort = chronological order.
  const sorted = entries.filter(e => e.endsWith(".json")).sort();
  const toRemove = sorted.slice(0, sorted.length - MAX_ANTHROPIC_LOG_FILES);
  await Promise.all(
    toRemove.map(f => rm(path.join(ANTHROPIC_API_LOG_DIRECTORY, f), { force: true })),
  );
}

// ---------------------------------------------------------------------------
// Unified log writer — routes to the correct provider
// ---------------------------------------------------------------------------

/**
 * Provider log writer via the `llm-provider-surface` `writeLogFile` member.
 * Surface or member absent ⇒ no-op; when present, the connector's own
 * enabled-check/redaction/fs-error semantics apply unchanged.
 */
async function writeProviderLogFile(
  providerId: "openai" | "gemini",
  input: { label: string; kind: "request" | "response"; body: unknown },
): Promise<void> {
  const writeLogFile = getLlmProviderSurface(providerId)?.writeLogFile;
  if (typeof writeLogFile !== "function") return;
  await writeLogFile(input);
}

export async function writeLlmLogFile(input: {
  provider: LlmProvider;
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  switch (input.provider) {
    case "openai":
      return writeProviderLogFile("openai", { label: input.label, kind: input.kind, body: input.body });
    case "anthropic":
      return writeAnthropicLogFile({ label: input.label, kind: input.kind, body: input.body });
    case "gemini":
      return writeProviderLogFile("gemini", { label: input.label, kind: input.kind, body: input.body });
  }
}
