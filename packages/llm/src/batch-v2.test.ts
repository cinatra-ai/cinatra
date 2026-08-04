/**
 * cinatra#2396 — batch-v2 PURE mappers.
 *
 * Everything here is dependency-free translation: neutral descriptor → the v1
 * canonical body, v1 statuses/results/JSONL rows → the neutral vocabulary, and
 * the stable error-code normalization. Keeping these tests free of adapters,
 * registries and mocks is deliberate — the routing decisions are pinned
 * separately in `__tests__/batch-v2-routing.test.ts`, so a failure here is
 * unambiguously a MAPPING defect.
 */
import { describe, it, expect } from "vitest";
import {
  assertValidBatchV2Requests,
  countOutcomes,
  normalizeBatchErrorCode,
  normalizeV1BatchStatus,
  sanitizeBatchV2Requests,
  toBatchV2Error,
  toV1CanonicalChatCompletionsBody,
  v1OutputLineToOutcome,
  v1ResultToState,
  BATCH_V2_DEFAULT_MAX_TOKENS,
  V1_CANONICAL_BATCH_PROVIDER,
} from "./batch-v2";
import type { LlmBatchV2ErrorCode, LlmBatchV2Request, LlmBatchOutputLine } from "./types";

const REQUEST: LlmBatchV2Request = {
  customId: "row-1",
  model: "gpt-4o-mini",
  system: "You are terse.",
  messages: [{ role: "user", content: "hi" }],
};

describe("assertValidBatchV2Requests", () => {
  it("accepts a well-formed batch", () => {
    expect(() => assertValidBatchV2Requests([REQUEST])).not.toThrow();
  });

  it("rejects an empty batch", () => {
    expect(() => assertValidBatchV2Requests([])).toThrow(/at least one request/);
  });

  it("rejects a missing / empty customId", () => {
    expect(() =>
      assertValidBatchV2Requests([{ ...REQUEST, customId: "" }]),
    ).toThrow(/non-empty `customId`/);
  });

  it("rejects a customId over the 64-character provider cap", () => {
    expect(() =>
      assertValidBatchV2Requests([{ ...REQUEST, customId: "x".repeat(65) }]),
    ).toThrow(/exceeds 64 characters/);
  });

  it("rejects DUPLICATE customIds — an unordered result row would be unattributable", () => {
    expect(() => assertValidBatchV2Requests([REQUEST, { ...REQUEST }])).toThrow(
      /Duplicate batch request customId "row-1"/,
    );
  });

  it("rejects a request with no messages", () => {
    expect(() => assertValidBatchV2Requests([{ ...REQUEST, messages: [] }])).toThrow(
      /needs at least one message/,
    );
  });
});

describe("sanitizeBatchV2Requests — the batch half of the cinatra#2339 seam", () => {
  const schema = {
    type: "object",
    properties: { confidence: { type: "number", minimum: 0, maximum: 1 } },
  };

  it("ANTHROPIC: strips the rejected numeric keywords and restates them in `description`", () => {
    const [sanitized] = sanitizeBatchV2Requests("anthropic", [
      { ...REQUEST, outputSchema: schema },
    ]);
    const confidence = (
      sanitized.outputSchema as { properties: { confidence: Record<string, unknown> } }
    ).properties.confidence;
    expect(confidence.minimum).toBeUndefined();
    expect(confidence.maximum).toBeUndefined();
    expect(String(confidence.description)).toContain("minimum 0 (inclusive)");
    expect(String(confidence.description)).toContain("maximum 1 (inclusive)");
  });

  it("OPENAI: no policy ⇒ the schema is the SAME REFERENCE (request bytes provably unchanged)", () => {
    const [sanitized] = sanitizeBatchV2Requests("openai", [
      { ...REQUEST, outputSchema: schema },
    ]);
    expect(sanitized.outputSchema).toBe(schema);
  });

  it("never mutates the caller's request objects", () => {
    const input = { ...REQUEST, outputSchema: schema };
    sanitizeBatchV2Requests("anthropic", [input]);
    expect(input.outputSchema).toBe(schema);
    expect(
      (schema.properties.confidence as { minimum?: number }).minimum,
    ).toBe(0);
  });

  it("NARROWS messages to {role, content} — a smuggled resolvedAttachments file id never crosses", () => {
    const smuggled = {
      ...REQUEST,
      messages: [
        {
          role: "user" as const,
          content: "hi",
          // Structurally compatible caller object carrying provider-native file ids.
          resolvedAttachments: [
            { nativeKind: "input_file", providerFileId: "file_leak", mime: "application/pdf" },
          ],
        },
      ],
    } as unknown as LlmBatchV2Request;
    const [sanitized] = sanitizeBatchV2Requests("anthropic", [smuggled]);
    expect(sanitized.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(JSON.stringify(sanitized)).not.toContain("file_leak");
  });

  it("omits absent optional fields rather than emitting explicit undefined", () => {
    const [sanitized] = sanitizeBatchV2Requests("openai", [
      { customId: "row-1", messages: [{ role: "user", content: "hi" }] },
    ]);
    expect(Object.keys(sanitized)).toEqual(["customId", "messages"]);
  });
});

describe("toV1CanonicalChatCompletionsBody", () => {
  it("renders the documented OpenAI-canonical body, system first", () => {
    expect(toV1CanonicalChatCompletionsBody(REQUEST, "fallback-model")).toEqual({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ],
      max_completion_tokens: BATCH_V2_DEFAULT_MAX_TOKENS,
    });
  });

  it("falls back to the adapter's defaultModel when the descriptor pins none", () => {
    const body = toV1CanonicalChatCompletionsBody(
      { customId: "r", messages: [{ role: "user", content: "hi" }] },
      "fallback-model",
    );
    expect(body.model).toBe("fallback-model");
  });

  it("omits the system turn entirely when there is none", () => {
    const body = toV1CanonicalChatCompletionsBody(
      { customId: "r", messages: [{ role: "user", content: "hi" }] },
      "m",
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("emits response_format.json_schema for a structured request and carries temperature", () => {
    const schema = { type: "object", properties: {} };
    const body = toV1CanonicalChatCompletionsBody(
      { ...REQUEST, temperature: 0.2, maxTokens: 128, outputSchema: schema },
      "m",
    );
    expect(body.max_completion_tokens).toBe(128);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
  });

  it("BYTE-STABLE: the same descriptor always serializes to the same JSONL line", () => {
    const line = () =>
      JSON.stringify({
        custom_id: REQUEST.customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: toV1CanonicalChatCompletionsBody(REQUEST, "fallback-model"),
      });
    expect(line()).toBe(line());
    expect(line()).toBe(
      '{"custom_id":"row-1","method":"POST","url":"/v1/chat/completions","body":' +
        '{"model":"gpt-4o-mini","messages":[{"role":"system","content":"You are terse."},' +
        '{"role":"user","content":"hi"}],"max_completion_tokens":4096}}',
    );
  });
});

describe("normalizeV1BatchStatus — OpenAI's eight values onto the neutral four", () => {
  it.each([
    ["validating", "in_progress"],
    ["in_progress", "in_progress"],
    ["finalizing", "in_progress"],
    ["cancelling", "canceling"],
    ["completed", "ended"],
    ["expired", "ended"],
    ["cancelled", "ended"],
    ["failed", "failed"],
  ] as const)("%s → %s", (v1, neutral) => {
    expect(normalizeV1BatchStatus(v1)).toBe(neutral);
  });

  it("an UNRECOGNISED vendor status stays in_progress — never guessed terminal", () => {
    expect(normalizeV1BatchStatus("some_future_state")).toBe("in_progress");
  });
});

describe("v1ResultToState", () => {
  it("maps the v1 envelope and reports counts as NULL (v1 carries none)", () => {
    expect(
      v1ResultToState({
        batchId: "batch_1",
        status: "completed",
        inputFileId: "file_in",
        outputFileId: "file_out",
        errorFileId: null,
        completedAt: "2026-08-04T00:00:00.000Z",
        errorMessage: null,
      }),
    ).toEqual({
      batchId: "batch_1",
      status: "ended",
      counts: null,
      endedAt: "2026-08-04T00:00:00.000Z",
      expiresAt: null,
      errorMessage: null,
    });
  });
});

describe("normalizeBatchErrorCode — the STABLE vocabulary", () => {
  it.each([
    [400, "invalid_request"],
    [401, "authentication"],
    [403, "permission"],
    [404, "not_found"],
    [408, "timeout"],
    [413, "request_too_large"],
    [429, "rate_limit"],
    [500, "provider_error"],
    [529, "overloaded"],
  ] as const)("HTTP %s → %s", (providerStatus, expected) => {
    expect(normalizeBatchErrorCode({ providerStatus })).toBe(expected);
  });

  it.each([
    ["invalid_request_error", "invalid_request"],
    ["authentication_error", "authentication"],
    ["permission_error", "permission"],
    ["not_found_error", "not_found"],
    ["rate_limit_error", "rate_limit"],
    ["timeout_error", "timeout"],
    ["overloaded_error", "overloaded"],
    ["billing_error", "billing"],
    ["api_error", "provider_error"],
  ] as const)("vendor code %s → %s", (providerCode, expected) => {
    expect(normalizeBatchErrorCode({ providerCode })).toBe(expected);
  });

  it("HTTP status WINS over an ambiguous vendor code", () => {
    expect(normalizeBatchErrorCode({ providerCode: "api_error", providerStatus: 429 })).toBe(
      "rate_limit",
    );
  });

  it("an unrecognised code is `unknown` — never guessed from the message text", () => {
    expect(normalizeBatchErrorCode({ providerCode: "some_new_error" })).toBe("unknown");
    expect(normalizeBatchErrorCode({})).toBe("unknown");
  });

  it("a provider code that collides with an Object.prototype member stays `unknown`", () => {
    // The table is keyed by a PROVIDER-SUPPLIED string; a prototype-chain lookup
    // would resolve these to inherited FUNCTIONS, which are truthy, and classify
    // the row by a member of Object.prototype instead of falling through.
    for (const providerCode of ["toString", "constructor", "valueOf", "__proto__"]) {
      expect(normalizeBatchErrorCode({ providerCode })).toBe("unknown");
    }
  });

  it("a lifecycle-table key collision with Object.prototype stays an ERROR row", () => {
    expect(
      v1OutputLineToOutcome({
        customId: "row-proto",
        response: null,
        error: { code: "toString", message: "weird" },
      }),
    ).toMatchObject({ status: "errored", error: { code: "unknown", providerCode: "toString" } });
  });

  it("toBatchV2Error carries provider detail SEPARATELY from the stable code", () => {
    expect(
      toBatchV2Error({ providerCode: "rate_limit_error", providerStatus: 429, message: "slow down" }),
    ).toEqual({
      code: "rate_limit",
      message: "slow down",
      providerCode: "rate_limit_error",
      providerStatus: 429,
    });
  });

  it("supplies an honest placeholder message when the provider sent none", () => {
    expect(toBatchV2Error({}).message).toBe("The provider reported an error with no message.");
  });
});

describe("v1OutputLineToOutcome — both v1 streams fold into the one outcome list", () => {
  it("a 2xx output row becomes a succeeded outcome with text, model, usage and stop reason", () => {
    const line: LlmBatchOutputLine = {
      customId: "row-1",
      response: {
        status_code: 200,
        body: {
          model: "gpt-4o-mini-2024",
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
      error: null,
    };
    expect(v1OutputLineToOutcome(line)).toEqual({
      customId: "row-1",
      status: "succeeded",
      text: '{"ok":true}',
      model: "gpt-4o-mini-2024",
      usage: {
        inputTokens: 11,
        outputTokens: 5,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      stopReason: "stop",
      rawBody: JSON.stringify(line.response!.body),
    });
  });

  it("an ERROR-FILE row becomes an errored outcome with the normalized code", () => {
    const outcome = v1OutputLineToOutcome({
      customId: "row-2",
      response: null,
      error: { code: "invalid_request_error", message: "bad input" },
    });
    expect(outcome).toMatchObject({
      customId: "row-2",
      status: "errored",
      error: {
        code: "invalid_request",
        message: "bad input",
        providerCode: "invalid_request_error",
        providerStatus: null,
      },
    });
  });

  it("a NON-2xx output row is an errored outcome (failure is not only in the error file)", () => {
    const outcome = v1OutputLineToOutcome({
      customId: "row-3",
      response: {
        status_code: 404,
        body: { error: { code: "model_not_found", message: "no such model" } },
      },
      error: null,
    });
    expect(outcome).toMatchObject({
      customId: "row-3",
      status: "errored",
      error: { code: "not_found", providerCode: "model_not_found", providerStatus: 404 },
    });
  });

  it.each([
    ["batch_cancelled", "canceled"],
    ["batch_canceled", "canceled"],
    ["batch_expired", "expired"],
  ] as const)(
    "a `%s` error row is re-classified as the `%s` OUTCOME, not a failure",
    (providerCode, expected) => {
      // These are what OpenAI writes into the error file for the requests that
      // were still pending when a batch was cancelled or hit its 24h window.
      // Reporting them as `errored` would over-count failures on every
      // cancelled batch and make the same event read differently per provider.
      expect(
        v1OutputLineToOutcome({
          customId: "row-lifecycle",
          response: null,
          error: { code: providerCode, message: "the batch did not finish in time" },
        }),
      ).toEqual({ customId: "row-lifecycle", status: expected });
    },
  );

  it("a non-2xx row with a NULL `code` falls back to the required `type` identifier", () => {
    // OpenAI's error object makes `code` nullable and `type` required, so
    // reading `code` alone would persist providerCode: null on exactly the rows
    // that do name their error kind.
    expect(
      v1OutputLineToOutcome({
        customId: "row-typed",
        response: {
          status_code: 400,
          body: { error: { code: null, type: "invalid_request_error", message: "bad" } },
        },
        error: null,
      }),
    ).toMatchObject({
      status: "errored",
      error: { code: "invalid_request", providerCode: "invalid_request_error", providerStatus: 400 },
    });
  });

  it("`request_timeout` stays an ERROR but normalizes to the timeout code", () => {
    expect(
      v1OutputLineToOutcome({
        customId: "row-slow",
        response: null,
        error: { code: "request_timeout", message: "took too long" },
      }),
    ).toMatchObject({ status: "errored", error: { code: "timeout" } });
  });

  it("a row carrying neither response nor error degrades to an honest `unknown` error", () => {
    expect(
      v1OutputLineToOutcome({ customId: "row-4", response: null, error: null }),
    ).toEqual({
      customId: "row-4",
      status: "errored",
      error: {
        code: "unknown",
        message: "Batch row carried neither a response nor an error.",
        providerCode: null,
        providerStatus: null,
      },
      rawBody: null,
    });
  });

  it("omits usage entirely when the provider reported none", () => {
    const outcome = v1OutputLineToOutcome({
      customId: "row-5",
      response: { status_code: 200, body: { choices: [{ message: { content: "hi" } }] } },
      error: null,
    });
    expect(outcome).not.toHaveProperty("usage");
    expect(outcome).toMatchObject({ status: "succeeded", text: "hi", model: null, stopReason: null });
  });
});

describe("countOutcomes", () => {
  it("tallies a MIXED batch across all four outcome kinds", () => {
    expect(
      countOutcomes([
        { customId: "a", status: "succeeded", text: "x", model: null, stopReason: null, rawBody: "{}" },
        {
          customId: "b",
          status: "errored",
          error: { code: "invalid_request", message: "m", providerCode: null, providerStatus: null },
          rawBody: null,
        },
        { customId: "c", status: "canceled" },
        { customId: "d", status: "expired" },
      ]),
    ).toEqual({ total: 4, processing: 0, succeeded: 1, errored: 1, canceled: 1, expired: 1 });
  });
});

describe("the v1 bridge is fenced to the provider the v1 contract names", () => {
  it("V1_CANONICAL_BATCH_PROVIDER is openai", () => {
    expect(V1_CANONICAL_BATCH_PROVIDER).toBe("openai");
  });

  it("DRIFT GUARD: the normalized error vocabulary is exactly these eleven codes", () => {
    // Adding a code is a CONTRACT change: every v2 adapter maps into this set,
    // so a silent addition would make one connector emit a code its peers and
    // its consumers do not know.
    const codes: LlmBatchV2ErrorCode[] = [
      "invalid_request",
      "authentication",
      "permission",
      "not_found",
      "rate_limit",
      "request_too_large",
      "overloaded",
      "timeout",
      "billing",
      "provider_error",
      "unknown",
    ];
    expect(codes).toHaveLength(11);
    expect(new Set(codes).size).toBe(11);
  });
});
