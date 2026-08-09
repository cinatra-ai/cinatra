/**
 * cinatra#2578 — the admin "test MCP access" probe is billed, so it is counted.
 *
 * The route reaches OpenAI/Anthropic with a raw `fetch`, so the adapter-level
 * metering seam cannot see it. These tests pin the extraction the route feeds
 * into the ledger: real token counts on a real payload, NOTHING on a payload
 * that carries no usage (a fabricated zero-token row would be worse than the
 * gap it replaces), and a key derived from the provider's own response id so a
 * retry cannot double-count.
 */
import { describe, it, expect } from "vitest";
import {
  buildProbeIdempotencyKey,
  readAnthropicMessagesUsage,
  readOpenAiResponsesUsage,
} from "@/lib/llm-access-test-usage";

describe("readOpenAiResponsesUsage", () => {
  it("reads the Responses-API usage block, including the cached and reasoning slices", () => {
    const probe = readOpenAiResponsesUsage({
      id: "resp_abc",
      model: "gpt-5.5",
      usage: {
        input_tokens: 43061,
        output_tokens: 721,
        input_tokens_details: { cached_tokens: 42368 },
        output_tokens_details: { reasoning_tokens: 373 },
      },
    });

    expect(probe).toEqual({
      usage: {
        // `input_tokens` is the TOTAL prompt (cached portion included) on this
        // surface, matching the convention the rest of the ledger uses.
        inputTokens: 43061,
        outputTokens: 721,
        cachedInputTokens: 42368,
        reasoningOutputTokens: 373,
      },
      model: "gpt-5.5",
      responseId: "resp_abc",
    });
  });

  it("defaults the optional detail blocks to zero rather than dropping the row", () => {
    const probe = readOpenAiResponsesUsage({
      id: "resp_abc",
      model: "gpt-5.5",
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    expect(probe?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  it("answers null when the payload carries no usage at all", () => {
    expect(readOpenAiResponsesUsage({ error: { message: "bad key" } })).toBeNull();
    expect(readOpenAiResponsesUsage(null)).toBeNull();
    expect(readOpenAiResponsesUsage("not json")).toBeNull();
  });

  it("ignores non-numeric / negative counters instead of trusting them", () => {
    const probe = readOpenAiResponsesUsage({
      usage: { input_tokens: "many", output_tokens: -4 },
    });
    expect(probe?.usage.inputTokens).toBe(0);
    expect(probe?.usage.outputTokens).toBe(0);
    expect(probe?.model).toBeNull();
    expect(probe?.responseId).toBeNull();
  });
});

describe("readAnthropicMessagesUsage", () => {
  it("uses the three-field cache convention the pricer expects", () => {
    // `cachedInputTokens` stays 0 ON PURPOSE. computeLlmCostUsd subtracts it
    // from inputTokens AND charges it, while ALSO charging cacheRead/
    // cacheCreation — so echoing the cache-read count into it would subtract a
    // slice Anthropic never included in `input_tokens` and bill that slice twice.
    const probe = readAnthropicMessagesUsage({
      id: "msg_abc",
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 900,
        output_tokens: 120,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 50,
      },
    });

    expect(probe).toEqual({
      usage: {
        inputTokens: 900,
        outputTokens: 120,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        cacheReadInputTokens: 400,
        cacheCreationInputTokens: 50,
      },
      model: "claude-sonnet-4-6",
      responseId: "msg_abc",
    });
  });

  it("answers null on an error body", () => {
    expect(
      readAnthropicMessagesUsage({ type: "error", error: { message: "no" } }),
    ).toBeNull();
  });
});

describe("buildProbeIdempotencyKey", () => {
  it("addresses the provider's own response so a retry cannot double-count", () => {
    expect(buildProbeIdempotencyKey("openai", "resp_abc", "unused")).toBe(
      "llm-access-test:openai:resp_abc",
    );
  });

  it("falls back to a caller-supplied unique value rather than dropping the row", () => {
    expect(buildProbeIdempotencyKey("anthropic", null, "uuid-1")).toBe(
      "llm-access-test:anthropic:uuid-1",
    );
  });
});
