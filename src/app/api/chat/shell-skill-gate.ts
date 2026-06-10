/**
 * Model-aware gate for the chat path's shell-based skill delivery.
 *
 * The chat runner delivers its sub-skills (CHAT_SKILL_IDS) to OpenAI as one
 * native `type: "shell"` tool (`buildSkillTools`). OpenAI's Responses API
 * rejects that tool for some models — `400 Tool 'shell' is not supported with
 * gpt-5` — which previously failed EVERY chat turn when the connection's
 * defaultModel was shell-incompatible (issue #47: legacy persisted
 * `defaultModel: "gpt-5"` from before the gpt-5.5 default, or the free-text
 * model input on /setup/ai and /configuration/llm).
 *
 * Mirrors the llm-bridge degrade semantics (src/app/api/llm-bridge/route.ts):
 * when the resolved chat model cannot accept the shell tool, the chat skips
 * the skill shell tool and keeps running (cinatra self-MCP + web_search remain
 * attached) instead of 400ing. The `read_skill` function-tool fallback is
 * retired platform-wide (catalog-bypass closure) and MUST NOT be reintroduced
 * here.
 *
 * Kept as a tiny module importing only the dependency-free capability leaf so
 * the decision is unit-testable without mocking the @cinatra-ai/llm root.
 */
import { openAiModelSupportsShell } from "@cinatra-ai/llm/openai-model-capabilities";

/**
 * Whether the chat turn may attach the shell-based skill tools for the
 * resolved provider adapter. The chat passes no per-request model, so the
 * adapter's `defaultModel` IS the model the request will use.
 *
 * Non-OpenAI providers return true: Anthropic/Gemini skill delivery is
 * enforced at their own provider boundaries, not by this gate.
 */
export function shouldDeliverChatShellSkillTools(adapter: {
  provider: string;
  defaultModel: string;
}): boolean {
  if (adapter.provider !== "openai") return true;
  return openAiModelSupportsShell(adapter.defaultModel);
}
