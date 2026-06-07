// Vitest stub for @cinatra-ai/llm.
// The skills package is loaded transitively via @/lib/agents-store; tests
// never exercise the LLM runtime. Real DB / LLM / store calls are vi.mock()-ed
// in each test file.
export const resolveConfiguredLlmRuntime = async () => undefined;
export const runResolvedDeterministicLlmTask = async () => ({});
export const runResolvedSkillAwareDeterministicLlmTask = async () => ({});
export const runDeterministicLlmTask = async () => ({});
export const runSkillAwareDeterministicLlmTask = async () => ({});
export const generate = async () => ({});
export const stream = async () => ({});
