/**
 * Batch API surface tests — CORE orchestration dispatch.
 *
 * Asserts that:
 *   1. The batch types (LlmBatchRequest, LlmBatchSubmitInput, LlmBatchResult,
 *      LlmBatchStatus) are importable from `@cinatra-ai/llm`.
 *   2. `BatchNotSupportedError` is exported, extends Error, and carries
 *      `code: "batch_not_supported"` and the provider name.
 *   3. The four orchestrate-* dispatchers throw `BatchNotSupportedError` when
 *      the resolved adapter does NOT implement the batch method (anthropic /
 *      gemini here).
 *   4. When the resolved adapter DOES implement the batch methods (openai), the
 *      orchestrators FORWARD the request to the adapter and return its result.
 *
 * Post-#1715 switch-over: adapters resolve ONLY through the connector-registered
 * `llm-provider-adapter` surface — there is no in-core factory and no provider
 * SDK import in core. The SDK-level batch translation (files.create /
 * batches.create / JSONL parsing / field mapping) is the openai connector
 * adapter's responsibility and is covered by the connector's own tests; here we
 * pin the CORE dispatch layer against surface-supplied stub adapters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — stub the module graph ./index pulls in before the entry-point import.
// ---------------------------------------------------------------------------

// Surface-supplied stub adapters. The openai adapter exposes the four batch
// methods (vi.fn stubs); anthropic/gemini expose NONE, so the orchestrators
// fail with BatchNotSupportedError.
const h = vi.hoisted(() => {
  const submitBatchMock = vi.fn();
  const retrieveBatchMock = vi.fn();
  const downloadBatchResultsMock = vi.fn();
  const cancelBatchMock = vi.fn();
  return {
    submitBatchMock,
    retrieveBatchMock,
    downloadBatchResultsMock,
    cancelBatchMock,
    adaptersByProvider: {
      openai: {
        provider: "openai",
        defaultModel: "gpt-4o-mini",
        submitBatch: submitBatchMock,
        retrieveBatch: retrieveBatchMock,
        downloadBatchResults: downloadBatchResultsMock,
        cancelBatch: cancelBatchMock,
      },
      anthropic: { provider: "anthropic", defaultModel: "claude-sonnet-4-6" },
      gemini: { provider: "gemini", defaultModel: "gemini-2.5-flash" },
    } as Record<string, object>,
  };
});

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

// MCP-related stubs — mirror entry-point-actor-context.test.ts so importing
// ./index does not pull DB / Nango calls at module load.
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
}));

// Skill tool helpers — short-circuit so index.ts loads cleanly.
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

// Bypass the fail-closed actor-context gate — the batch entry points wrap their
// bodies the same way generate does; we only verify dispatch here.
beforeEach(() => {
  process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = "false";
  h.submitBatchMock.mockReset();
  h.retrieveBatchMock.mockReset();
  h.downloadBatchResultsMock.mockReset();
  h.cancelBatchMock.mockReset();
});

import {
  BatchNotSupportedError,
  orchestrateSubmitBatch,
  orchestrateRetrieveBatch,
  orchestrateDownloadBatchResults,
  orchestrateCancelBatch,
} from "../index";
import type {
  LlmBatchRequest,
  LlmBatchSubmitInput,
  LlmBatchResult,
  LlmBatchStatus,
} from "../index";

// ---------------------------------------------------------------------------
// Test 1 — TYPES: importing the new types compiles + the dispatchers are wired.
// ---------------------------------------------------------------------------
describe("batch types", () => {
  it("Test 1 (TYPES): batch types are importable + the four orchestrate-* dispatchers are exported", () => {
    const req: LlmBatchRequest = {
      customId: "abc",
      body: { model: "gpt-4o-mini", messages: [] },
    };
    const input: LlmBatchSubmitInput = { requests: [req] };
    const status: LlmBatchStatus = "validating";
    const result: LlmBatchResult = {
      batchId: "batch_x",
      status,
      inputFileId: "file_x",
      outputFileId: null,
      errorFileId: null,
      completedAt: null,
      errorMessage: null,
    };
    expect(input.requests[0]?.customId).toBe("abc");
    expect(result.batchId).toBe("batch_x");
    expect(typeof orchestrateSubmitBatch).toBe("function");
    expect(typeof orchestrateRetrieveBatch).toBe("function");
    expect(typeof orchestrateDownloadBatchResults).toBe("function");
    expect(typeof orchestrateCancelBatch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Test 2 — ERROR: BatchNotSupportedError shape.
// ---------------------------------------------------------------------------
describe("BatchNotSupportedError", () => {
  it("Test 2 (ERROR): new BatchNotSupportedError('anthropic') carries code + provider, instanceof Error", () => {
    const err = new BatchNotSupportedError("anthropic");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("batch_not_supported");
    expect(err.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Test 3-6 — an adapter that does NOT implement batch throws BatchNotSupported.
// ---------------------------------------------------------------------------
describe("batch dispatch — adapters without batch support (anthropic + gemini)", () => {
  it("Test 3 (ANTHROPIC SUBMIT): orchestrateSubmitBatch({ provider: 'anthropic' }) throws BatchNotSupportedError", async () => {
    await expect(
      orchestrateSubmitBatch({ provider: "anthropic", requests: [] }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "anthropic" });
  });

  it("Test 4 (GEMINI SUBMIT): orchestrateSubmitBatch({ provider: 'gemini' }) throws BatchNotSupportedError", async () => {
    await expect(
      orchestrateSubmitBatch({ provider: "gemini", requests: [] }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "gemini" });
  });

  it("Test 5 (ANTHROPIC RETRIEVE/DOWNLOAD/CANCEL): all three throw BatchNotSupportedError", async () => {
    await expect(
      orchestrateRetrieveBatch({ provider: "anthropic", batchId: "x" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "anthropic" });
    await expect(
      orchestrateDownloadBatchResults({ provider: "anthropic", fileId: "f" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "anthropic" });
    await expect(
      orchestrateCancelBatch({ provider: "anthropic", batchId: "x" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "anthropic" });
  });

  it("Test 6 (GEMINI RETRIEVE/DOWNLOAD/CANCEL): all three throw BatchNotSupportedError", async () => {
    await expect(
      orchestrateRetrieveBatch({ provider: "gemini", batchId: "x" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "gemini" });
    await expect(
      orchestrateDownloadBatchResults({ provider: "gemini", fileId: "f" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "gemini" });
    await expect(
      orchestrateCancelBatch({ provider: "gemini", batchId: "x" }),
    ).rejects.toMatchObject({ code: "batch_not_supported", provider: "gemini" });
  });
});

// ---------------------------------------------------------------------------
// Test 7-10 — the orchestrators FORWARD to the resolved adapter's batch methods
// and return the adapter's result (the SDK-level translation lives in the
// openai connector, not core).
// ---------------------------------------------------------------------------
describe("batch dispatch — forwards to the resolved openai adapter", () => {
  it("Test 7 (OPENAI SUBMIT): forwards { requests } to adapter.submitBatch and returns its result", async () => {
    const adapterResult = { batchId: "batch_abc", inputFileId: "file_input_xyz", status: "validating" };
    h.submitBatchMock.mockResolvedValue(adapterResult);

    const requests = [
      { customId: "abc", body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] } },
    ];
    const result = await orchestrateSubmitBatch({ provider: "openai", requests });

    expect(h.submitBatchMock).toHaveBeenCalledTimes(1);
    expect(h.submitBatchMock).toHaveBeenCalledWith({ requests });
    expect(result).toBe(adapterResult);
  });

  it("Test 8 (OPENAI RETRIEVE): forwards batchId to adapter.retrieveBatch and returns its result", async () => {
    const adapterResult = {
      batchId: "batch_abc",
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: null,
      completedAt: new Date(1700000000 * 1000).toISOString(),
      errorMessage: null,
    };
    h.retrieveBatchMock.mockResolvedValue(adapterResult);

    const result = await orchestrateRetrieveBatch({ provider: "openai", batchId: "batch_abc" });

    expect(h.retrieveBatchMock).toHaveBeenCalledWith("batch_abc");
    expect(result).toBe(adapterResult);
  });

  it("Test 9 (OPENAI DOWNLOAD): forwards fileId to adapter.downloadBatchResults and returns its result", async () => {
    const lines = [
      { customId: "row-1", response: { status_code: 200, body: { ok: true, value: 1 } }, error: null },
      { customId: "row-2", response: null, error: { code: "invalid_request", message: "bad input" } },
    ];
    h.downloadBatchResultsMock.mockResolvedValue(lines);

    const result = await orchestrateDownloadBatchResults({ provider: "openai", fileId: "file_xyz" });

    expect(h.downloadBatchResultsMock).toHaveBeenCalledWith("file_xyz");
    expect(result).toBe(lines);
  });

  it("Test 10 (OPENAI CANCEL): forwards batchId to adapter.cancelBatch and returns its result", async () => {
    const adapterResult = { batchId: "batch_abc", status: "cancelling" };
    h.cancelBatchMock.mockResolvedValue(adapterResult);

    const result = await orchestrateCancelBatch({ provider: "openai", batchId: "batch_abc" });

    expect(h.cancelBatchMock).toHaveBeenCalledWith("batch_abc");
    expect(result).toBe(adapterResult);
  });
});
