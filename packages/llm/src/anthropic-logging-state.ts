// Dependency-free leaf module holding a NON-authoritative in-process cache of
// the Anthropic-logging enabled flag.
//
// #1715 D2: the AUTHORITY for the flag is now the persisted connector-config
// store (readAnthropicLoggingEnabledFromDatabase in @/lib/database) — a single
// process-wide value every module realm reads, so an admin toggle reaches a
// connector-relocated adapter's log writer (module state is realm-local and
// would not). The log writer (telemetry.writeAnthropicLogFile) no longer reads
// this cache. It is retained ONLY as a back-compat surface: the public
// setAnthropicLoggingEnabled/isAnthropicLoggingEnabled exports and the
// `@cinatra-ai/llm/anthropic-logging-state` subpath. saveAnthropicLoggingSettings
// still warms it (harmless); it stays a dependency-free leaf so src/lib/logging.ts
// can import it without dragging the heavy @cinatra-ai/llm barrel into a
// module-init cycle (TDZ hazard on the *_API_LOG_DIRECTORY constants).

let anthropicLoggingEnabled = true;

export function setAnthropicLoggingEnabled(enabled: boolean): void {
  anthropicLoggingEnabled = enabled;
}

export function isAnthropicLoggingEnabled(): boolean {
  return anthropicLoggingEnabled;
}
