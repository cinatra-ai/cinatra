/**
 * Usage extraction for the admin "test MCP access" probe (cinatra#2578).
 *
 * `src/app/configuration/mcp/llm-access/test/route.ts` reaches OpenAI and
 * Anthropic with a hand-rolled `fetch` rather than through a provider adapter,
 * so the metering proxy at the adapter mint point cannot see it. Every press of
 * that admin button is a real, billed model request (it asks the model to call
 * the MCP server and report the tool list — a full tool round trip, not a ping),
 * and none of them reached `usage_events`.
 *
 * The parsing lives HERE, not inline in the route, so it is unit-testable
 * without a network, a session, or a provider key. These functions are PURE:
 * they read a decoded response body and answer with neutral usage, never
 * touching credentials and never emitting anything themselves.
 */
import type { LlmUsageData } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

export type ProbeUsage = {
  usage: LlmUsageData;
  /** The model the provider says answered — preferred over what we requested. */
  model: string | null;
  /**
   * The provider's own response id (`resp_…` / `msg_…`), used to build a
   * deterministic idempotency key. Null when the payload carried none (an error
   * body, a shape we do not recognise).
   */
  responseId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * OpenAI Responses API (`POST /v1/responses`).
 *
 * `input_tokens` on that surface is the TOTAL prompt, cached portion included —
 * the same convention `LlmUsageData.inputTokens` carries elsewhere in the
 * ledger, so it is passed through unmodified and the cached slice is reported
 * alongside it rather than subtracted.
 *
 * Returns null when the body carries no usage at all (an error response, or a
 * request the provider rejected before billing) — the honest answer is "nothing
 * to record", never a zero-token row.
 */
export function readOpenAiResponsesUsage(body: unknown): ProbeUsage | null {
  const root = asRecord(body);
  const usage = asRecord(root?.usage);
  if (!usage) return null;
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return {
    usage: {
      inputTokens: asCount(usage.input_tokens),
      outputTokens: asCount(usage.output_tokens),
      cachedInputTokens: asCount(inputDetails?.cached_tokens),
      reasoningOutputTokens: asCount(outputDetails?.reasoning_tokens),
    },
    model: asId(root?.model),
    responseId: asId(root?.id),
  };
}

/**
 * Anthropic Messages API (`POST /v1/messages`).
 *
 * THE THREE-FIELD CONVENTION, and why `cachedInputTokens` is 0 here. Anthropic's
 * `input_tokens` EXCLUDES the cache-read and cache-creation counters, and the
 * pricer (`computeLlmCostUsd`) treats `cachedInputTokens`, `cacheReadInputTokens`
 * and `cacheCreationInputTokens` as three ADDITIVE cost terms while subtracting
 * `cachedInputTokens` from `inputTokens`. Copying the cache-read count into
 * `cachedInputTokens` as well would therefore do two wrong things at once:
 * subtract it from an input figure it was never part of, and bill it twice. The
 * cache slice is carried ONLY in the two Anthropic-shaped fields, which is the
 * convention that surface's rows already use.
 */
export function readAnthropicMessagesUsage(body: unknown): ProbeUsage | null {
  const root = asRecord(body);
  const usage = asRecord(root?.usage);
  if (!usage) return null;
  return {
    usage: {
      inputTokens: asCount(usage.input_tokens),
      outputTokens: asCount(usage.output_tokens),
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      cacheReadInputTokens: asCount(usage.cache_read_input_tokens),
      cacheCreationInputTokens: asCount(usage.cache_creation_input_tokens),
    },
    model: asId(root?.model),
    responseId: asId(root?.id),
  };
}

/**
 * The ledger key for one probe request.
 *
 * Derived from the provider's own response id so a double-submit of the admin
 * form records two rows (two billed requests) while a retry of the SAME
 * response — should the route ever gain one — records one. Falls back to a
 * caller-supplied unique value when the payload named no id, because dropping
 * the row would put us back where cinatra#2578 started.
 */
export function buildProbeIdempotencyKey(
  provider: string,
  responseId: string | null,
  fallbackUniqueId: string,
): string {
  return `llm-access-test:${provider}:${responseId ?? fallbackUniqueId}`;
}
