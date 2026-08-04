/**
 * Batch-v2 core support (cinatra#2396) — validation, the per-provider
 * sanitization pass, and the LEGACY v1 BRIDGE.
 *
 * This leaf holds everything the v2-preferring orchestration wrappers in
 * `./index.ts` need that is NOT provider-adapter code, so the routing itself
 * stays a handful of readable lines and every mapping below is unit-testable
 * without an adapter, a registry, or a network.
 *
 * THE BRIDGE, stated plainly. The shipped v1 batch surface is OpenAI-canonical
 * by definition — `LlmBatchRequest.body` IS a `/v1/chat/completions` payload and
 * results are addressed by FILE id. So when a provider offers only v1, core can
 * still serve the neutral v2 API by (a) rendering each neutral descriptor into
 * that canonical body, and (b) folding the v1 file-addressed result envelope
 * back into normalized per-request outcomes. That translation is legitimate
 * exactly BECAUSE v1 is OpenAI-canonical — which is also why the bridge refuses
 * to run for any other provider (see {@link V1_CANONICAL_BATCH_PROVIDER}): a
 * non-OpenAI adapter that merely happens to expose the v1 method names would be
 * handed bodies it never agreed to parse.
 *
 * SANITIZATION stays where cinatra#2339/#2343 put it — at the core→adapter
 * seam. {@link sanitizeBatchV2Requests} is the batch seam's single application
 * point, and it runs for BOTH branches (v2 adapter and v1 bridge) before
 * anything crosses into a connector. Nothing downstream re-sanitizes.
 */
import type {
  LlmBatchOutputLine,
  LlmBatchResult,
  LlmBatchStatus,
  LlmBatchV2Counts,
  LlmBatchV2Error,
  LlmBatchV2ErrorCode,
  LlmBatchV2Outcome,
  LlmBatchV2Request,
  LlmBatchV2State,
  LlmBatchV2Status,
  LlmProvider,
  LlmUsageData,
} from "./types";
import { sanitizeOutputSchemaForProvider } from "./structured-json";

/**
 * The ONLY provider the legacy v1 bridge may drive.
 *
 * v1's request `body` is a native OpenAI `/v1/chat/completions` payload and its
 * results are OpenAI's JSONL envelope. Probing for the mere PRESENCE of the v1
 * method names is not enough: the shipped Anthropic adapter defines all four of
 * them as `throw new BatchNotSupportedError("anthropic")` stubs, so a
 * presence-only probe would classify Anthropic as batch-capable and then hand
 * it OpenAI bodies. The bridge is therefore gated on the provider identity that
 * the v1 contract itself names.
 */
export const V1_CANONICAL_BATCH_PROVIDER = "openai" as const;

/** Providers cap the correlation id at 64 characters. */
export const BATCH_V2_CUSTOM_ID_MAX_LENGTH = 64;

/** Output-token ceiling used when a caller pins none. Mirrors the adapters' own default. */
export const BATCH_V2_DEFAULT_MAX_TOKENS = 4096;

/**
 * Reject a malformed batch BEFORE either dispatch branch.
 *
 * These are all conditions both providers reject anyway, but they reject them
 * after the request has been billed a round trip and with a vendor-shaped
 * message. Failing here keeps the diagnostic neutral and the failure cheap.
 */
export function assertValidBatchV2Requests(requests: LlmBatchV2Request[]): void {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("Batch submit requires at least one request.");
  }
  const seen = new Set<string>();
  for (const request of requests) {
    const id = request?.customId;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Every batch request needs a non-empty `customId`.");
    }
    if (id.length > BATCH_V2_CUSTOM_ID_MAX_LENGTH) {
      throw new Error(
        `Batch request customId "${id}" exceeds ${BATCH_V2_CUSTOM_ID_MAX_LENGTH} characters.`,
      );
    }
    if (seen.has(id)) {
      // Results come back UNORDERED and are correlated only by customId, so a
      // duplicate makes a row unattributable — not a warning, a hard stop.
      throw new Error(`Duplicate batch request customId "${id}".`);
    }
    seen.add(id);
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new Error(`Batch request "${id}" needs at least one message.`);
    }
  }
}

/**
 * Apply the per-provider `outputSchema` policy to every request and NARROW each
 * message to the neutral `{role, content}` pair.
 *
 * The narrowing is deliberate, not defensive tidiness: `LlmMessage` carries
 * `resolvedAttachments` holding provider-native FILE ids, and a structurally
 * compatible caller object could smuggle them into a surface whose entire
 * premise is that it needs no prior upload.
 *
 * Returns fresh objects; the caller's array is never mutated.
 */
export function sanitizeBatchV2Requests(
  provider: LlmProvider,
  requests: LlmBatchV2Request[],
): LlmBatchV2Request[] {
  return requests.map((request) => ({
    customId: request.customId,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.system === undefined ? {} : { system: request.system }),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.outputSchema === undefined
      ? {}
      : { outputSchema: sanitizeOutputSchemaForProvider(provider, request.outputSchema) }),
  }));
}

// ---------------------------------------------------------------------------
// Legacy v1 bridge — request side
// ---------------------------------------------------------------------------

/**
 * Render a neutral descriptor into the v1 canonical `/v1/chat/completions`
 * body.
 *
 * `max_completion_tokens` (not the deprecated `max_tokens`) because the current
 * OpenAI Chat Completions surface rejects `max_tokens` on reasoning models.
 * `response_format.json_schema` carries NO `strict` flag, matching the
 * synchronous OpenAI path's posture — the schema shapes the response, hard
 * enforcement stays the caller's post-parse validation.
 *
 * Key order is fixed and the function is pure, so the JSONL it feeds is stable
 * byte-for-byte for a given descriptor — that stability is what a v2 OpenAI
 * adapter can be pinned against.
 */
export function toV1CanonicalChatCompletionsBody(
  request: LlmBatchV2Request,
  fallbackModel: string,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  if (typeof request.system === "string" && request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  return {
    model: request.model ?? fallbackModel,
    messages,
    max_completion_tokens: request.maxTokens ?? BATCH_V2_DEFAULT_MAX_TOKENS,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.outputSchema === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema",
            json_schema: { name: "response", schema: request.outputSchema },
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Legacy v1 bridge — status / state side
// ---------------------------------------------------------------------------

/**
 * OpenAI's eight-value lifecycle → the four neutral ones.
 *
 * `expired` and `cancelled` map to `"ended"` on purpose: in both cases
 * processing IS over and the output/error files DO exist, so per-request
 * outcomes are retrievable. Per-request expiry/cancellation is an OUTCOME fact
 * in v2, not a batch fact.
 */
export function normalizeV1BatchStatus(status: LlmBatchStatus | string): LlmBatchV2Status {
  switch (status) {
    case "validating":
    case "in_progress":
    case "finalizing":
      return "in_progress";
    case "cancelling":
      return "canceling";
    case "completed":
    case "expired":
    case "cancelled":
      return "ended";
    case "failed":
      return "failed";
    default:
      // An unrecognised vendor status is NOT guessed into a terminal state —
      // treating it as still-running keeps a poller polling instead of
      // persisting a batch as finished on a string we do not understand.
      return "in_progress";
  }
}

/**
 * v1 `LlmBatchResult` → neutral state.
 *
 * `counts: null` is the honest answer: `LlmBatchResult` carries no tallies at
 * all, and synthesizing `{total: 0, …}` would assert that a live batch has zero
 * requests. `expiresAt: null` for the same reason — v1 never reported it.
 *
 * KNOWN v1 LIMITATION, stated rather than papered over: `endedAt` can only be
 * `completedAt`, the single timestamp `LlmBatchResult` carries. A batch that
 * ended by EXPIRING or by being CANCELLED therefore reports `endedAt: null`
 * even though it is terminal — OpenAI's `expired_at` / `cancelled_at` never
 * crossed the v1 contract, so there is nothing truthful to put there. Read
 * `status === "ended"` for terminality; `endedAt` is best-effort on this leg.
 * A native v2 adapter reports the real timestamp.
 */
export function v1ResultToState(result: LlmBatchResult): LlmBatchV2State {
  return {
    batchId: result.batchId,
    status: normalizeV1BatchStatus(result.status),
    counts: null,
    endedAt: result.completedAt,
    expiresAt: null,
    errorMessage: result.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * v1 per-request error codes that are NOT errors in the neutral vocabulary —
 * they are the OTHER two terminal OUTCOMES.
 *
 * This is the one place the two contracts genuinely disagree about kind rather
 * than naming. On Anthropic, "this request was cancelled" and "this request hit
 * the processing deadline" are first-class per-request outcomes. On OpenAI they
 * arrive as ERROR ROWS in the error file carrying `batch_cancelled` /
 * `batch_expired` — which is exactly what happens to the still-pending requests
 * when a batch is cancelled or reaches its 24h window. Mapping them onto
 * `errored` would make the same real-world event read as a hard failure on one
 * provider and a lifecycle outcome on the other, and a consumer counting
 * failures would over-report on every cancelled OpenAI batch.
 */
const OUTCOME_STATUS_BY_V1_ERROR_CODE: Record<string, "canceled" | "expired"> = {
  batch_cancelled: "canceled",
  batch_canceled: "canceled",
  batch_expired: "expired",
};

/** Vendor error identifiers whose meaning is unambiguous across providers. */
const ERROR_CODE_BY_PROVIDER_CODE: Record<string, LlmBatchV2ErrorCode> = {
  request_timeout: "timeout",
  invalid_request_error: "invalid_request",
  invalid_request: "invalid_request",
  authentication_error: "authentication",
  permission_error: "permission",
  not_found_error: "not_found",
  rate_limit_error: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  timeout_error: "timeout",
  overloaded_error: "overloaded",
  billing_error: "billing",
  api_error: "provider_error",
  server_error: "provider_error",
  token_limit_exceeded: "request_too_large",
  request_too_large: "request_too_large",
};

/**
 * Normalize a provider error into the STABLE {@link LlmBatchV2ErrorCode}
 * vocabulary. HTTP status wins when present (it is the least ambiguous signal),
 * then the vendor identifier, then `"unknown"` — a code is never guessed from
 * free-text message contents.
 */
export function normalizeBatchErrorCode(input: {
  providerCode?: string | null;
  providerStatus?: number | null;
}): LlmBatchV2ErrorCode {
  const status = input.providerStatus;
  if (typeof status === "number") {
    if (status === 400) return "invalid_request";
    if (status === 401) return "authentication";
    if (status === 403) return "permission";
    if (status === 404) return "not_found";
    if (status === 408 || status === 504) return "timeout";
    if (status === 413) return "request_too_large";
    if (status === 429) return "rate_limit";
    if (status === 529) return "overloaded";
    if (status >= 500) return "provider_error";
  }
  const code = input.providerCode;
  if (typeof code === "string" && code in ERROR_CODE_BY_PROVIDER_CODE) {
    return ERROR_CODE_BY_PROVIDER_CODE[code];
  }
  return "unknown";
}

/** Build a normalized error from a provider code/status/message triple. */
export function toBatchV2Error(input: {
  providerCode?: string | null;
  providerStatus?: number | null;
  message?: string | null;
}): LlmBatchV2Error {
  return {
    code: normalizeBatchErrorCode(input),
    message: input.message ?? "The provider reported an error with no message.",
    providerCode: input.providerCode ?? null,
    providerStatus: input.providerStatus ?? null,
  };
}

// ---------------------------------------------------------------------------
// Legacy v1 bridge — outcome side
// ---------------------------------------------------------------------------

function readChatCompletionText(body: Record<string, unknown>): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices)) return null;
  const parts: string[] = [];
  for (const choice of choices) {
    const message = (choice as { message?: { content?: unknown } } | null)?.message;
    if (message && typeof message.content === "string") parts.push(message.content);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function readChatCompletionStopReason(body: Record<string, unknown>): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0] as { finish_reason?: unknown } | undefined;
  return typeof first?.finish_reason === "string" ? first.finish_reason : null;
}

/**
 * One v1 JSONL row → one normalized outcome.
 *
 * Covers BOTH v1 streams, which is why the bridge downloads the output file AND
 * the error file: a row can fail either by carrying a top-level `error` (the
 * error file) or by carrying a non-2xx `response.status_code` (the output
 * file).
 *
 * All FOUR neutral outcome kinds are reachable: `batch_cancelled` /
 * `batch_expired` error rows are re-classified as the `canceled` / `expired`
 * OUTCOMES they actually describe (see
 * {@link OUTCOME_STATUS_BY_V1_ERROR_CODE}), so a cancelled or expired batch
 * reports the same shape here as it does on a native v2 provider.
 */
export function v1OutputLineToOutcome(line: LlmBatchOutputLine): LlmBatchV2Outcome {
  if (line.error) {
    const lifecycleStatus = OUTCOME_STATUS_BY_V1_ERROR_CODE[line.error.code];
    if (lifecycleStatus) {
      return { customId: line.customId, status: lifecycleStatus };
    }
    return {
      customId: line.customId,
      status: "errored",
      error: toBatchV2Error({ providerCode: line.error.code, message: line.error.message }),
      rawBody: JSON.stringify(line.error),
    };
  }
  const response = line.response;
  if (!response) {
    return {
      customId: line.customId,
      status: "errored",
      error: toBatchV2Error({ message: "Batch row carried neither a response nor an error." }),
      rawBody: null,
    };
  }
  if (response.status_code < 200 || response.status_code >= 300) {
    const body = response.body as
      | { error?: { code?: unknown; type?: unknown; message?: unknown } }
      | undefined;
    // `code` is NULLABLE on an OpenAI error object while `type` is required, so
    // reading `code` alone discards the identifier (`invalid_request_error`, …)
    // on exactly the rows that carry no code. Prefer `code`, fall back to
    // `type` — never persist `providerCode: null` when the payload named one.
    const providerCode =
      typeof body?.error?.code === "string"
        ? body.error.code
        : typeof body?.error?.type === "string"
          ? body.error.type
          : null;
    return {
      customId: line.customId,
      status: "errored",
      error: toBatchV2Error({
        providerCode,
        providerStatus: response.status_code,
        message: typeof body?.error?.message === "string" ? body.error.message : null,
      }),
      rawBody: JSON.stringify(response.body),
    };
  }
  const body = response.body ?? {};
  const usage = readChatCompletionUsage(body);
  return {
    customId: line.customId,
    status: "succeeded",
    text: readChatCompletionText(body),
    model: typeof body.model === "string" ? body.model : null,
    ...(usage === null ? {} : { usage }),
    stopReason: readChatCompletionStopReason(body),
    rawBody: JSON.stringify(body),
  };
}

function readChatCompletionUsage(body: Record<string, unknown>): LlmUsageData | null {
  const usage = body.usage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        completion_tokens_details?: { reasoning_tokens?: unknown };
      }
    | undefined;
  if (!usage) return null;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  return {
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    cachedInputTokens: num(usage.prompt_tokens_details?.cached_tokens),
    reasoningOutputTokens: num(usage.completion_tokens_details?.reasoning_tokens),
  };
}

/** Sum a normalized outcome list into {@link LlmBatchV2Counts}. */
export function countOutcomes(outcomes: LlmBatchV2Outcome[]): LlmBatchV2Counts {
  const counts: LlmBatchV2Counts = {
    total: outcomes.length,
    processing: 0,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  };
  for (const outcome of outcomes) {
    if (outcome.status === "succeeded") counts.succeeded += 1;
    else if (outcome.status === "errored") counts.errored += 1;
    else if (outcome.status === "canceled") counts.canceled += 1;
    else counts.expired += 1;
  }
  return counts;
}
