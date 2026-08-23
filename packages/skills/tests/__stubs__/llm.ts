// Vitest stub for @cinatra-ai/llm.
// The skills package is loaded transitively via @/lib/agents-store; tests
// never exercise the LLM runtime. Real DB / LLM / store calls are vi.mock()-ed
// in each test file.
export const resolveConfiguredLlmRuntime = async () => undefined;
export const runResolvedDeterministicLlmTask = async () => ({});
// cinatra#2910 — the scripted-runtime narrowing guard. The stub's
// `resolveConfiguredLlmRuntime` never yields one, so this is always false here.
export const isScriptedLlmRuntime = (runtime?: { provider?: string } | null) =>
  runtime?.provider === "scripted";
export const runResolvedSkillAwareDeterministicLlmTask = async () => ({});
export const runDeterministicLlmTask = async () => ({});
export const runSkillAwareDeterministicLlmTask = async () => ({});
export const generate = async () => ({});
export const stream = async () => ({});
// Provider-neutral batch surface (setup-flow S6). Tests that exercise the
// capability-routed pipeline inject their own seams via SkillMatchJobDeps.batch;
// these stubs only need to exist so module resolution succeeds.
export const probeBatchCapability = async () => ({
  provider: "openai",
  batchVersion: null,
  cancelSupported: false,
});
export const orchestrateSubmitBatchV2 = async () => {
  throw new Error("orchestrateSubmitBatchV2 stub: inject deps.batch in tests");
};
export const orchestrateRetrieveBatchV2 = async () => {
  throw new Error("orchestrateRetrieveBatchV2 stub: inject deps.batch in tests");
};
export const orchestrateDownloadBatchOutcomesV2 = async () => {
  throw new Error("orchestrateDownloadBatchOutcomesV2 stub: inject deps.batch in tests");
};
export const orchestrateCancelBatchV2 = async () => {
  throw new Error("orchestrateCancelBatchV2 stub: inject deps.batch in tests");
};
