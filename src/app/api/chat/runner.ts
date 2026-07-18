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
// `hasConfiguredLlmRuntime` / `ChatRequestMessage` exports — as the Cinatra
// assistant binding consumed by the unified AG-UI endpoint
// (src/app/api/assistants/chat/route.ts). The bespoke HTTP SSE route that
// used to live beside it (POST /api/chat) was deleted by the #1216 S2 delete
// stage (cinatra#1218). The in-process MCP path (chat_thread_send,
// packages/chat/src/mcp/handlers.ts) was ported in P2b: it calls
// runAssistantTurn(cinatraConfig, …) directly (byte-identical to this shim —
// parity-pinned), so that teardown could not touch the MCP surface.

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
