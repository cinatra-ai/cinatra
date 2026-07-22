/**
 * Provider-transparent LLM telemetry / logging router.
 *
 * Every provider's request/response log writer now lives in its connector and
 * is exposed on the connector's `llm-provider-surface` `writeLogFile` member
 * (cinatra#1715 — the openai/anthropic/gemini adapters, their log directories,
 * redaction and enabled-check all relocated out of packages/llm). This module
 * keeps ONLY the host-owned, provider-transparent router that resolves the
 * correct connector surface at call time; packages/llm carries NO connector
 * value-imports and NO in-tree writer.
 */

// LLM provider adapter cutover (cinatra#151 Stage 2 / #1715 switch-over): every
// provider log writer resolves through its connector's `llm-provider-surface`
// registration at call time. Surface/member absent ⇒ no-op (best-effort
// logging never breaks the request path on connector absence).
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import type { LlmProvider } from "./types";

/**
 * Provider log writer via the `llm-provider-surface` `writeLogFile` member.
 * Surface or member absent ⇒ no-op; when present, the connector's own
 * enabled-check/redaction/fs-error semantics apply unchanged. The connector's
 * enabled gate reads the persisted logging-authority store (#1969 D2), so an
 * admin toggle reaches the connector-realm writer regardless of realm.
 */
async function writeProviderLogFile(
  providerId: LlmProvider,
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
  return writeProviderLogFile(input.provider, {
    label: input.label,
    kind: input.kind,
    body: input.body,
  });
}
