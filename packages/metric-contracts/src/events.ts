// Shared usage-event contract for the metric packages.
//
// These types are the seam between the PRODUCERS of usage telemetry
// (metric-usage-api's `emitUsageEvent`, called from the LLM/connector call
// paths) and the CONSUMER that prices + persists them (metric-cost-api's event
// subscriber). They live here — in a contracts package that depends on neither
// metric package — so the producer/consumer dependency points one way and the
// metric-usage-api <-> metric-cost-api cycle is broken.

/**
 * How the provider request that produced this usage was issued.
 *
 * `batch` and `validate` are additive (cinatra#2578): the OpenAI Batch surface
 * and the admin "test key" MCP-access probe are real, billed provider requests
 * that the ledger previously did not carry at all. Recording them under their
 * own operation keeps them countable AND distinguishable from interactive spend
 * rather than mislabelling them as `generate`.
 */
export type LlmUsageOperation = "generate" | "stream" | "batch" | "validate";

export type LlmUsageEvent = {
  source: "llm";
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  operation: LlmUsageOperation;
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
