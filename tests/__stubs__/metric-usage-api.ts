// Minimal stub for @cinatra-ai/metric-usage-api.
//
// src/app/api/llm-bridge/route.ts imports `emitUsageEvent` from this package
// for the media-input branch telemetry. The real entry point re-exports
// `createMetricUsageMcpModule` from ./mcp/module which pulls in
// @cinatra-ai/mcp-server (a heavy barrel) — not loadable in the root vitest
// sandbox. This stub exports only the symbols the bridge route references.
//
// Bridge tests that want to assert the payload of emitUsageEvent should
// vi.mock("@cinatra-ai/metric-usage-api", () => ({ emitUsageEvent: vi.fn() }))
// at the top of the test file; the stub here is the default no-op used by
// the bridge tests (auth-bridge-token, run-context-wiring,
// personal-skill-resolution, path-traversal, cinatra-llm-routing) which do
// NOT exercise the media branch.

export type LlmUsageEvent = {
  source: "llm";
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  operation: "generate" | "stream";
  agentLabel: string | null;
  skillLabel: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  idempotencyKey: string;
  occurredAt: string;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
};

export type ApolloUsageEvent = {
  source: "apollo";
  operation: string;
  agentLabel: string | null;
  requestCount: number;
  resultCount: number;
  creditsConsumed: number;
  idempotencyKey: string;
  occurredAt: string;
};

export type UsageEvent = LlmUsageEvent | ApolloUsageEvent;

export function emitUsageEvent(_event: UsageEvent): void {
  // no-op
}

export function onUsageEvent(_handler: (event: UsageEvent) => void): () => void {
  return () => {};
}
