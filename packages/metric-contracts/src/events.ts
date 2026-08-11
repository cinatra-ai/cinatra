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
 *
 * `image` is additive too (cinatra#2641). It is the one operation whose dominant
 * charge is in a NON-TOKEN unit: `adapter.generateImage()` is billed per produced
 * image. Its OUTPUT token columns are therefore zeros the schema requires, NOT a
 * measurement, and the per-token COMPLETION card must never be run over it —
 * that card would answer 0, and a stored 0 reads as "this image was free". An
 * `image` row must never be summed as if it were interactive completion spend.
 *
 * Its dollars come from {@link LlmUsageEvent.imageCount} instead, priced against
 * a per-image card, PLUS `inputTokens` when the provider also bills the prompt
 * (Google does). `inputTokens` on an image row is a real measurement whenever
 * the adapter reported one — and the NOT NULL column's placeholder `0` when it
 * did not. {@link LlmUsageEvent.imagePromptTokensReported} is what tells the two
 * apart, and pricing depends on that distinction.
 *
 * When the adapter reports no image usage the row stays COUNTED AND UNPRICED
 * (`cost_usd` NULL) — the shape cinatra#2582 established for the Graphiti
 * hand-over, and still the state of every adapter that has not adopted the ABI's
 * optional image usage.
 */
export type LlmUsageOperation =
  | "generate"
  | "stream"
  | "batch"
  | "validate"
  | "image";

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
  /**
   * How many images an `operation:"image"` row was billed for (cinatra#2641).
   *
   * The per-image unit the image half of this ledger is priced in. Present only
   * when the adapter ATTESTED it — together with the model that produced the
   * images — through the ABI's optional image usage. Absent means "the adapter
   * said nothing", which is not the same as zero and must leave the row unpriced
   * rather than priced at $0.
   *
   * It is not a persisted column. `usage_events` stores the dollars this count
   * multiplies into, so the count is an input to pricing, not a second copy of
   * the answer.
   */
  imageCount?: number;
  /**
   * Whether the prompt tokens in {@link LlmUsageEvent.inputTokens} are a REPORT
   * or a placeholder, on an `operation:"image"` row (cinatra#2641).
   *
   * WHY A FLAG AND NOT A SECOND NUMBER. `inputTokens` maps to a NOT NULL column,
   * so it cannot express "the adapter said nothing" — absent collapses to `0`.
   * For pricing, `0` and "unreported" are opposite answers: a provider that
   * bills the prompt needs the real count, and treating an unreported prompt as
   * zero prices the images and silently drops the rest of the bill.
   *
   * Carrying the quantity TWICE would have solved that and introduced a worse
   * failure: two numbers that can disagree, storing a cost the row's own columns
   * do not support. So the quantity has exactly one home — `inputTokens` — and
   * this flag says whether to believe it. `true` ⇒ price on it (including a
   * genuine `0`); absent/`false` ⇒ nothing was reported and the row stays
   * unpriced when the provider bills the prompt.
   */
  imagePromptTokensReported?: boolean;
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
