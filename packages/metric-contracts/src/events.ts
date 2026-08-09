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

/**
 * One episode handed to the Graphiti knowledge-graph indexer (cinatra#2582).
 *
 * WHY THIS IS ITS OWN SOURCE, COUNTED BUT NOT PRICED.
 *
 * Graphiti runs in its own container and fans out MANY OpenAI requests per
 * episode (entity/edge extraction, dedup, summaries, embeddings) on the key the
 * app injects into it. Those requests are real spend on the operator's OpenAI
 * account and they never pass through this repo's adapter seam, so the ledger
 * could not see them at all — the "invisible spender" line item of cinatra#2578.
 *
 * The wrapper (`zepai/knowledge-graph-mcp` 1.0.x) reports NO token usage back:
 * `add_memory` answers with an acknowledgement, and the image exposes no usage
 * surface to poll. So the only number we can state truthfully is the one we
 * know: an episode was handed over, and its provider fan-out is billed. Tokens
 * and dollars are therefore left UNKNOWN (`cost_usd` NULL) rather than
 * estimated — an invented multiplier would replace invisible spend with wrong
 * spend, which is worse. The dashboard already surfaces NULL-cost rows as
 * "unknown cost", so these rows read as "counted, not priced".
 *
 * It is deliberately NOT an `LlmUsageEvent`: exactly one module in this repo
 * constructs a `source:"llm"` row (the adapter metering seam, cinatra#2578), and
 * that invariant — pinned by `src/__tests__/llm-usage-ledger-chokepoint.test.ts`
 * — is what makes double counting structurally impossible. A second producer of
 * `source:"llm"` would dissolve it.
 */
export type GraphitiUsageEvent = {
  source: "graphiti";
  /** The provider Graphiti bills against — the key the app injects into it. */
  provider: "openai";
  /** One handed-over episode. Its per-episode fan-out is many requests. */
  operation: "episode";
  /** Unknown: the wrapper does not report which model it extracted with. */
  model: null;
  /**
   * Unique per hand-over. Every episode really is its own billed fan-out, so
   * two sends must be two rows; the key exists so a re-DELIVERED event (the same
   * event object reaching the subscriber twice) collapses at the database's
   * idempotency index instead of double-counting.
   */
  idempotencyKey: string;
  occurredAt: string;
};

export type UsageEvent = LlmUsageEvent | ApolloUsageEvent | GraphitiUsageEvent;
