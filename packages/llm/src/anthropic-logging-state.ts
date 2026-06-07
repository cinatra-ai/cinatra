// Dependency-free leaf module holding the mutable Anthropic-logging enabled flag.
//
// This lives apart from telemetry.ts so that src/lib/logging.ts can import
// setAnthropicLoggingEnabled WITHOUT statically importing the heavy
// @cinatra-ai/llm barrel (which evaluates telemetry.ts → the
// openai/gemini connector barrels, re-entering logging.ts and tripping a TDZ
// ReferenceError on the *_API_LOG_DIRECTORY constants at module-init).
//
// Single source of truth for the flag: telemetry.ts and logging.ts both go
// through this module — no duplicated state.

let anthropicLoggingEnabled = true;

export function setAnthropicLoggingEnabled(enabled: boolean): void {
  anthropicLoggingEnabled = enabled;
}

export function isAnthropicLoggingEnabled(): boolean {
  return anthropicLoggingEnabled;
}
