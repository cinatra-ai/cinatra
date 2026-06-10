/**
 * OpenAI per-model capability facts — single source of truth.
 *
 * The Responses API rejects the hosted `shell` tool for some models
 * (`400 Tool 'shell' is not supported with gpt-5`). Per OpenAI docs only the
 * base gpt-5 + gpt-5-mini lack hosted-shell support; gpt-5.4 and gpt-5.5 both
 * list "Hosted shell: Supported". gpt-4.1 / gpt-4o families are omitted
 * because hosted-shell incompatibility for them is unverified and the
 * platform default never selects them.
 *
 * Kept as a tiny dependency-free leaf (no "server-only", no imports) so every
 * shell-skill-delivery surface — the chat runner gate
 * (`src/app/api/chat/shell-skill-gate.ts`) and the llm-bridge route
 * (`src/app/api/llm-bridge/route.ts`) — shares one set instead of drifting
 * inline copies. This must NOT live in
 * `@cinatra-ai/agents/llm-provider-policy` — that package is depended on by
 * `@cinatra-ai/llm` consumers in the opposite direction, and the agents
 * package must not import from `@cinatra-ai/llm` (circular).
 */

export const OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5",
  "gpt-5-mini",
]);

/**
 * Whether an OpenAI model accepts the hosted `shell` tool. Unknown / empty
 * model ids return true — the API is the final arbiter for models we have no
 * negative evidence about, matching the previous inline-set behavior.
 */
export function openAiModelSupportsShell(modelId: string): boolean {
  return !OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS.has(modelId);
}
