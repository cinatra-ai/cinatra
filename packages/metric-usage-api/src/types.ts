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
