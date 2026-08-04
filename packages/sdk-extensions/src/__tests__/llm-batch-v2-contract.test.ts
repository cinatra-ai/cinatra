// cinatra#2396 — COMPILE-PROOF + ABI-COMPAT proof for the ADDITIVE batch-v2
// surface.
//
// Two guarantees are proven here, and they are the ones the whole slice rests
// on:
//
//  1. ADDITIVITY. An adapter that implements ONLY the shipped v1 batch methods
//     still satisfies `LlmProviderAdapter` with no `batchV2` member at all. If
//     the v2 surface had been bolted on as required — or the v1 types reshaped
//     in place — this file would not compile, which is exactly the break the
//     issue forbids. `pnpm typecheck` compiles this file wholesale, so the
//     assignments below are genuine compile proofs rather than vitest-erased
//     type annotations.
//
//  2. CONNECTOR REACHABILITY. Everything the v2 surface needs resolves from the
//     PUBLIC subpath specifier `@cinatra-ai/sdk-extensions/llm-provider-adapter-contract`
//     alone — not a relative path, not `@cinatra-ai/llm` — mirroring what a
//     connector build actually sees.
//
// Note the deliberate `version: 2 as const` rather than a value import of
// `LLM_BATCH_V2_VERSION`: under old-host/new-connector skew the host-resolved
// SDK may predate this constant, so a connector must not depend on it at
// RUNTIME. The `satisfies`/assignment below still type-checks it against
// `typeof LLM_BATCH_V2_VERSION`, so drift is caught at compile time.
import { describe, expect, it } from "vitest";
import type {
  LlmProviderAdapter,
  GenerateInput,
  LlmResponse,
  StreamInput,
  LlmBatchSubmitInput,
  LlmBatchSubmitResult,
  LlmBatchV2Outcome,
  LlmBatchV2State,
  LlmBatchV2SubmitInput,
  LlmBatchV2SubmitResult,
  LlmBatchV2Surface,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";
import { LLM_BATCH_V2_VERSION } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const baseAdapter = {
  provider: "openai" as const,
  defaultModel: "test-model",
  async generate(input: GenerateInput): Promise<LlmResponse> {
    return { text: `echo:${input.prompt}`, status: "completed", incompleteReason: null, rawBody: "{}" };
  },
  async stream(input: StreamInput): Promise<void> {
    input.onStepEnd(0);
  },
};

// (1) ABI COMPAT — v1-only, no `batchV2`. The shipped shape, untouched.
const v1OnlyAdapter: LlmProviderAdapter = {
  ...baseAdapter,
  async submitBatch(_input: LlmBatchSubmitInput): Promise<LlmBatchSubmitResult> {
    return { batchId: "batch_1", inputFileId: "in_1", status: "validating" };
  },
  async retrieveBatch(batchId: string) {
    return {
      batchId,
      status: "completed" as const,
      inputFileId: "in_1",
      outputFileId: "out_1",
      errorFileId: null,
      completedAt: null,
      errorMessage: null,
    };
  },
  async downloadBatchResults() {
    return [];
  },
};

// (2) A migrated connector — BOTH surfaces, v1 untouched, v2 additive.
const batchV2Surface: LlmBatchV2Surface = {
  version: 2 as const,
  async submit(input: LlmBatchV2SubmitInput): Promise<LlmBatchV2SubmitResult> {
    return { batchId: "msgbatch_1", status: input.requests.length > 0 ? "in_progress" : "ended" };
  },
  async retrieve(batchId: string): Promise<LlmBatchV2State> {
    return {
      batchId,
      status: "ended",
      counts: { total: 1, processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
      endedAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-05T00:00:00.000Z",
      errorMessage: null,
    };
  },
  async download(): Promise<LlmBatchV2Outcome[]> {
    // Every branch of the outcome union is constructed, so a shape change in
    // any of the four is a compile error here.
    return [
      {
        customId: "a",
        status: "succeeded",
        text: "ok",
        model: "test-model",
        stopReason: "end_turn",
        rawBody: "{}",
      },
      {
        customId: "b",
        status: "errored",
        error: {
          code: "invalid_request",
          message: "bad",
          providerCode: "invalid_request_error",
          providerStatus: 400,
        },
        rawBody: "{}",
      },
      { customId: "c", status: "canceled" },
      { customId: "d", status: "expired" },
    ];
  },
};

const migratedAdapter: LlmProviderAdapter = {
  ...v1OnlyAdapter,
  batchV2: batchV2Surface,
};

// (3) A v2 surface may OMIT `cancel` — the member is optional by contract.
const cancellessSurface: LlmBatchV2Surface = {
  version: 2 as const,
  submit: batchV2Surface.submit,
  retrieve: batchV2Surface.retrieve,
  download: batchV2Surface.download,
};

describe("batch-v2 contract (cinatra#2396)", () => {
  it("ABI COMPAT: a v1-only adapter is still a valid LlmProviderAdapter (batchV2 absent)", () => {
    expect(v1OnlyAdapter.batchV2).toBeUndefined();
    expect(typeof v1OnlyAdapter.submitBatch).toBe("function");
  });

  it("ADDITIVE: a migrated adapter carries BOTH surfaces, v1 unchanged", async () => {
    expect(typeof migratedAdapter.submitBatch).toBe("function");
    expect(migratedAdapter.batchV2?.version).toBe(2);
    await expect(
      migratedAdapter.submitBatch!({ requests: [{ customId: "a", body: {} }] }),
    ).resolves.toMatchObject({ batchId: "batch_1", inputFileId: "in_1" });
  });

  it("the version discriminator is the literal 2 and matches the exported constant", () => {
    expect(LLM_BATCH_V2_VERSION).toBe(2);
    expect(batchV2Surface.version).toBe(LLM_BATCH_V2_VERSION);
  });

  it("download covers BOTH streams — all four outcome kinds are constructible", async () => {
    const outcomes = await batchV2Surface.download("msgbatch_1");
    expect(outcomes.map((o) => o.status)).toEqual([
      "succeeded",
      "errored",
      "canceled",
      "expired",
    ]);
  });

  it("cancel is OPTIONAL on the v2 surface", () => {
    expect(cancellessSurface.cancel).toBeUndefined();
  });

  it("retrieve reports neutral status + counts (no OpenAI-only strings, no file ids)", async () => {
    const state = await batchV2Surface.retrieve("msgbatch_1");
    expect(state.status).toBe("ended");
    expect(state.counts).toEqual({
      total: 1,
      processing: 0,
      succeeded: 1,
      errored: 0,
      canceled: 0,
      expired: 0,
    });
    expect(state).not.toHaveProperty("outputFileId");
    expect(state).not.toHaveProperty("errorFileId");
  });
});
