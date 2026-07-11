import "server-only";

// Cinatra `/chat` runtime entry (cinatra-ai/cinatra#1037 P2a).
//
// The conversational orchestration formerly inlined here has been EXTRACTED to
// the assistant-config-parameterized runtime at
// `@/lib/assistant-runtime/runtime` (`runAssistantTurn(runtimeConfig, args)`).
// This module is now the thin Cinatra-assistant binding: `runChatTurn` delegates
// to that runtime with the Cinatra assistant's reference `assistant_config`
// (`buildCinatraAssistantRuntimeConfig()`), reproducing the former hardcoded
// `CHAT_*` constants exactly (byte-parity — see
// `src/lib/assistant-runtime/__tests__/cinatra-parity.test.ts`).
//
// It is retained at this path — and keeps the `runChatTurn` /
// `hasConfiguredLlmRuntime` / `ChatRequestMessage` exports — so BOTH legacy
// entry shapes stay unchanged:
//   1. the HTTP SSE route      — src/app/api/chat/route.ts (POST /api/chat)
//   2. the in-process MCP path — packages/chat/src/mcp/handlers.ts
//                                (chat_thread_send → runChatTurn, no HTTP)
// Rewiring those callers onto the assistant endpoint + the structured-thread
// persistence is deferred to P2b / P3.

import {
  runAssistantTurn,
  hasConfiguredLlmRuntime,
  type RunChatTurnArgs,
} from "@/lib/assistant-runtime/runtime";
import { buildCinatraAssistantRuntimeConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";

export type {
  ChatRequestMessage,
  ChatStreamSink,
  RunChatTurnArgs,
} from "@/lib/assistant-runtime/runtime";
export { hasConfiguredLlmRuntime };

/**
 * Drive one Cinatra `/chat` turn. Binds the extracted assistant runtime to the
 * Cinatra assistant's reference config; the signature and behaviour are
 * unchanged from the pre-extraction runner so both entry shapes keep calling it
 * as-is.
 */
export function runChatTurn(args: RunChatTurnArgs): Promise<void> {
  return runAssistantTurn(buildCinatraAssistantRuntimeConfig(), args);
}
