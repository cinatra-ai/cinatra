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
 * Kept as a tiny dependency-free leaf (no "server-only", no imports).
 *
 * SCOPE, stated accurately (codex round-1 finding #4): the shipped OpenAI
 * connector keeps its OWN copy of this fact at
 * `extensions/cinatra-ai/openai-connector/src/adapter/openai-model-capabilities.ts`
 * and imports THAT — a relocated connector must not import host/core internals.
 * So this leaf is NOT a shared single source of truth across the adapter
 * boundary; it is core's copy, and the two are a KNOWN mirrored pair that must
 * be changed together.
 *
 * OWNERSHIP (cinatra#2094 F11): this fact answers exactly one question — "may
 * this model be handed a HOSTED SHELL tool?" — and only a provider adapter may
 * ask it. The two former CALLER-side gates (the chat runner's
 * `shell-skill-gate.ts` and the llm-bridge route) used it to skip skill delivery
 * ALTOGETHER for a shell-incompatible model, which produced a silent
 * no-delivery: the adapter already degrades such a request to the restricted
 * NAMED `skill_file_read` function tool (exec-plane S2's singular-native-shell
 * rule, cinatra#1707), so no `type:"shell"` could have reached the model anyway.
 * Both gates are retired; do not reintroduce a caller-side one.
 *
 * This must NOT live in
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
