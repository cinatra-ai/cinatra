/**
 * cinatra#2578 — the OpenAI Batch path reaches the usage ledger.
 *
 * A batch's tokens are billed by the provider but reported only on the RESULT
 * rows: no `adapter.generate()` ever happens, so the adapter-level metering
 * proxy cannot see them. Skill/agent install fires these batches, which made
 * them pure invisible spend before this change.
 *
 * `orchestrateDownloadBatchOutcomesV2` is where BOTH branches (native v2 and the
 * v1 bridge) converge holding outcomes, so it is the batch surface's choke
 * point. What is pinned here:
 *
 *   - every succeeded outcome carrying usage produces exactly one ledger row,
 *     on BOTH branches;
 *   - the keys are DERIVED from `{provider, batchId, customId}`, so re-downloading
 *     an ended batch (a retry, a restarted worker) re-emits identical keys and
 *     the ledger's unique index collapses them instead of doubling the spend;
 *   - non-succeeded outcomes and usage-less rows contribute nothing — a
 *     zero-token row would be a fabrication;
 *   - the outcome list handed back to the caller is unchanged.
 *
 * Harness mirrors `batch-v2-routing.test.ts` so the two read as one story.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const v2 = {
    submit: vi.fn(),
    retrieve: vi.fn(),
    download: vi.fn(),
    cancel: vi.fn(),
  };
  const v1 = {
    submitBatch: vi.fn(),
    retrieveBatch: vi.fn(),
    downloadBatchResults: vi.fn(),
    cancelBatch: vi.fn(),
  };
  return {
    v2,
    v1,
    emitUsageEvent: vi.fn(),
    adaptersByProvider: {} as Record<string, object>,
  };
});

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: h.emitUsageEvent,
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) => {
    const adapter = h.adaptersByProvider[providerId];
    return adapter
      ? { abiVersion: 1 as const, providerId, createAdapter: async () => adapter }
      : null;
  }),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));
vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
  getLlmMcpCredentials: vi.fn(),
  hasLlmMcpAccess: vi.fn(),
  getLlmMcpAccessStatus: vi.fn(),
  getPublicMcpServerUrl: vi.fn(),
  buildA2aBearerToken: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
  readLlmProviderFailoverPolicyFromDatabase: vi.fn(() => "exact"),
}));
vi.mock("../tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

import { orchestrateDownloadBatchOutcomesV2 } from "../index";

const USAGE = {
  inputTokens: 120,
  outputTokens: 40,
  cachedInputTokens: 30,
  reasoningOutputTokens: 10,
};

function migratedAdapter(provider: string) {
  return {
    provider,
    defaultModel: `${provider}-default-model`,
    ...h.v1,
    batchV2: { version: 2 as const, ...h.v2 },
  };
}

function legacyAdapter(provider: string) {
  return { provider, defaultModel: `${provider}-default-model`, ...h.v1 };
}

const rows = () =>
  h.emitUsageEvent.mock.calls.map((call) => call[0] as Record<string, unknown>);

beforeEach(() => {
  process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = "false";
  for (const fn of [...Object.values(h.v1), ...Object.values(h.v2)]) fn.mockReset();
  h.emitUsageEvent.mockReset();
  h.adaptersByProvider = {};
});

describe("batch outcomes reach the usage ledger — native v2 branch", () => {
  beforeEach(() => {
    h.adaptersByProvider.openai = migratedAdapter("openai");
  });

  it("emits one row per succeeded outcome carrying usage", async () => {
    h.v2.download.mockResolvedValue([
      { customId: "row-1", status: "succeeded", text: "a", model: "gpt-batch", usage: USAGE },
      { customId: "row-2", status: "succeeded", text: "b", model: "gpt-batch", usage: USAGE },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({
      source: "llm",
      provider: "openai",
      model: "gpt-batch",
      operation: "batch",
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 30,
      reasoningOutputTokens: 10,
      idempotencyKey: "batch:openai:batch_1:row-1",
    });
    expect(rows()[1]?.idempotencyKey).toBe("batch:openai:batch_1:row-2");
  });

  it("falls back to the adapter's default model when the row names none", async () => {
    h.v2.download.mockResolvedValue([
      { customId: "row-1", status: "succeeded", text: "a", model: null, usage: USAGE },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });

    expect(rows()[0]?.model).toBe("openai-default-model");
  });

  it("records NOTHING for errored / canceled / expired rows or rows without usage", async () => {
    h.v2.download.mockResolvedValue([
      { customId: "row-1", status: "errored", error: { code: "rate_limit", message: "x" } },
      { customId: "row-2", status: "canceled" },
      { customId: "row-3", status: "expired" },
      { customId: "row-4", status: "succeeded", text: "d", model: "gpt-batch" },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });

    expect(rows()).toHaveLength(0);
  });

  it("re-downloading the SAME batch re-emits identical keys (the ledger de-duplicates)", async () => {
    h.v2.download.mockResolvedValue([
      { customId: "row-1", status: "succeeded", text: "a", model: "gpt-batch", usage: USAGE },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });
    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });

    expect(rows()).toHaveLength(2);
    expect(new Set(rows().map((row) => row.idempotencyKey)).size).toBe(1);
  });

  it("hands the caller the outcome list unchanged", async () => {
    const outcomes = [
      { customId: "row-1", status: "succeeded", text: "a", model: "gpt-batch", usage: USAGE },
    ];
    h.v2.download.mockResolvedValue(outcomes);

    const result = await orchestrateDownloadBatchOutcomesV2({
      provider: "openai",
      batchId: "batch_1",
    });

    expect(result).toEqual(outcomes);
  });
});

describe("batch outcomes reach the usage ledger — legacy v1 bridge", () => {
  beforeEach(() => {
    h.adaptersByProvider.openai = legacyAdapter("openai");
  });

  it("emits a row per succeeded JSONL line, keyed the same way as the v2 branch", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_9",
      status: "completed",
      outputFileId: "file-out",
      errorFileId: null,
      completedAt: "2026-08-09T00:00:00.000Z",
      errorMessage: null,
    });
    h.v1.downloadBatchResults.mockResolvedValue([
      {
        customId: "row-1",
        response: {
          status_code: 200,
          body: {
            model: "gpt-batch-v1",
            choices: [{ message: { content: "a" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 40,
              prompt_tokens_details: { cached_tokens: 30 },
              completion_tokens_details: { reasoning_tokens: 10 },
            },
          },
        },
        error: null,
      },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_9" });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      provider: "openai",
      model: "gpt-batch-v1",
      operation: "batch",
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 30,
      reasoningOutputTokens: 10,
      idempotencyKey: "batch:openai:batch_9:row-1",
    });
  });

  it("records nothing for an error-file row", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_9",
      status: "completed",
      outputFileId: null,
      errorFileId: "file-err",
      completedAt: "2026-08-09T00:00:00.000Z",
      errorMessage: null,
    });
    h.v1.downloadBatchResults.mockResolvedValue([
      { customId: "row-1", response: null, error: { code: "rate_limit_exceeded", message: "x" } },
    ]);

    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_9" });

    expect(rows()).toHaveLength(0);
  });
});
