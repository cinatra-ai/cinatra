// Shared usage-event contract for the metric packages.
//
// These types are the seam between the PRODUCERS of usage telemetry
// (metric-usage-api's `emitUsageEvent`, called from the LLM/connector call
// paths) and the CONSUMER that prices + persists them (metric-cost-api's event
// subscriber). They live here — in a contracts package that depends on neither
// metric package — so the producer/consumer dependency points one way and the
// metric-usage-api <-> metric-cost-api cycle is broken.

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
