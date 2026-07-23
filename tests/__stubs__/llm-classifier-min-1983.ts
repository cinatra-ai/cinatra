// cinatra#1983 — @cinatra-ai/llm barrel shim for the REAL-STORE integration test.
//
// The objects_save handler statically imports the classifier, which in turn
// imports { resolveConfiguredLlmRuntime, runResolvedDeterministicLlmTask,
// parseStructuredJson } from the @cinatra-ai/llm BARREL. The root vitest config
// aliases that barrel to the actor-context LEAF (which does not export those
// three), so loading the real objects graph would fail at the classifier's
// import. This shim supplies the three symbols (never CALLED — the integration
// test registers the sent-email object type, so classifyObject takes the static
// fast-path and returns before any LLM runtime is resolved) and re-exports the
// real actor-context leaf so any other bare-barrel leaf import still resolves.
export * from "@cinatra-ai/llm/actor-context";

const FAST_PATH_ONLY =
  "@cinatra-ai/llm classifier shim (cinatra#1983 integration): the sent-email " +
  "type is registered, so classifyObject must take the static fast-path — the " +
  "LLM runtime must never be reached.";

export function resolveConfiguredLlmRuntime(): never {
  throw new Error(FAST_PATH_ONLY);
}
export function runResolvedDeterministicLlmTask(): never {
  throw new Error(FAST_PATH_ONLY);
}
export function parseStructuredJson(): never {
  throw new Error(FAST_PATH_ONLY);
}
