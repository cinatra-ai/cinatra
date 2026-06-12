/**
 * Batch API surface tests.
 *
 * Asserts that:
 *   1. The new batch types (LlmBatchRequest, LlmBatchSubmitInput,
 *      LlmBatchResult, LlmBatchStatus) are importable from
 *      `@cinatra-ai/llm`.
 *   2. `BatchNotSupportedError` is exported, extends Error, and carries
 *      `code: "batch_not_supported"` and the provider name.
 *   3. The four orchestrate-* dispatchers (`orchestrateSubmitBatch`,
 *      `orchestrateRetrieveBatch`, `orchestrateDownloadBatchResults`,
 *      `orchestrateCancelBatch`) throw `BatchNotSupportedError` when
 *      routed to anthropic or gemini providers.
 *   4. The OpenAI provider implements all four batch methods against
 *      `client.files.create({ purpose: "batch" })`, `client.files.content`,
 *      `client.batches.create`, `client.batches.retrieve`, and
 *      `client.batches.cancel` with the documented response mapping.
 *
 * Mocks the openai SDK and the @cinatra-ai/openai-connector connection
 * helper so no real API key / network call is required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — stub heavy / network-bound dependencies before the entry-point
// import below pulls in the orchestration index.ts module graph.
// ---------------------------------------------------------------------------

const filesCreateMock = vi.fn();
const filesContentMock = vi.fn();
const batchesCreateMock = vi.fn();
const batchesRetrieveMock = vi.fn();
const batchesCancelMock = vi.fn();

vi.mock("openai", () => {
  // OpenAI client constructor returns a stub with the surface we exercise.
  class MockOpenAI {
    files = {
      create: filesCreateMock,
      content: filesContentMock,
    };
    batches = {
      create: batchesCreateMock,
      retrieve: batchesRetrieveMock,
      cancel: batchesCancelMock,
    };
    // The real adapter constructor reads connection.apiKey; the mock just
    // ignores the constructor args.
    constructor(_config: unknown) {}
  }
  return { default: MockOpenAI };
});

// All three LLM provider surfaces (cinatra#151 Stage 2): connection
// readers / headers / log writers resolve through the capability resolver.
const { llmSurfaces } = vi.hoisted(() => ({
  llmSurfaces: {
    openai: {
      providerId: "openai",
      // Minimal stub so getConfiguredOpenAIConnection returns a usable shape.
      getConfiguredConnection: async () => ({ apiKey: "sk-test", defaultModel: "gpt-4o-mini" }),
      writeLogFile: async () => {},
    },
    anthropic: {
      providerId: "anthropic",
      getConfiguredConnection: async () => ({ apiKey: "sk-ant-test" }),
    },
    gemini: {
      providerId: "gemini",
      getConfiguredAPIKey: async () => "gem-test",
      buildRequestHeaders: () => ({}),
      writeLogFile: async () => {},
    },
  } as Record<string, object>,
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn((providerId: string) => llmSurfaces[providerId] ?? null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    const surface = llmSurfaces[providerId];
    if (!surface) {
      throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
    }
    return surface;
  }),
  listLlmProviderSurfaces: vi.fn(() => Object.values(llmSurfaces)),
}));

// Stub Anthropic + Gemini client modules so importing their providers does
// not require real SDK boot for this test file.
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    constructor(_config: unknown) {}
    beta = { messages: { create: vi.fn() }, files: { upload: vi.fn(), delete: vi.fn() } };
    messages = { create: vi.fn() };
    models = { list: vi.fn() };
  }
  return { default: MockAnthropic };
});
vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    constructor(_config: unknown) {}
    files = { upload: vi.fn(), delete: vi.fn() };
    models = { list: vi.fn(), generateContent: vi.fn(), generateContentStream: vi.fn() };
  }
  return { GoogleGenAI: MockGoogleGenAI };
});
// MCP-related stubs — mirror entry-point-actor-context.test.ts so importing
// ./index does not pull DB / Nango calls.
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

// Bypass the fail-closed actor-context gate. The batch entry points wrap
// their bodies the same way generate does; we don't want every
// test to have to set up an ALS frame just to verify dispatch.
beforeEach(() => {
  process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = "false";
  filesCreateMock.mockReset();
  filesContentMock.mockReset();
  batchesCreateMock.mockReset();
  batchesRetrieveMock.mockReset();
  batchesCancelMock.mockReset();
});

// ---------------------------------------------------------------------------
// Imports under test — pulled in lazily inside each test so the mocks above
// are guaranteed to be applied first.
// ---------------------------------------------------------------------------

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
// Test 1 — TYPES: importing the new types compiles.
// ---------------------------------------------------------------------------
describe("batch types", () => {
  it("Test 1 (TYPES): LlmBatchRequest / LlmBatchSubmitInput / LlmBatchResult / LlmBatchStatus are importable", () => {
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
    // The types-only assertions above already exercise the shape; this
    // expect-call is here so vitest counts it as a passing assertion.
    expect(input.requests[0]?.customId).toBe("abc");
    expect(result.batchId).toBe("batch_x");
    // Runtime gate: confirm the four orchestrate-* dispatchers are wired
    // up as named exports. RED phase: these are undefined → fails.
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
// Test 3-6 — provider stubs throw BatchNotSupportedError.
// ---------------------------------------------------------------------------
describe("batch dispatch — anthropic + gemini stubs", () => {
  it("Test 3 (ANTHROPIC SUBMIT): orchestrateSubmitBatch({ provider: 'anthropic' }) throws BatchNotSupportedError", async () => {
    await expect(
      orchestrateSubmitBatch({ provider: "anthropic", requests: [] }),
    ).rejects.toMatchObject({
      code: "batch_not_supported",
      provider: "anthropic",
    });
  });

  it("Test 4 (GEMINI SUBMIT): orchestrateSubmitBatch({ provider: 'gemini' }) throws BatchNotSupportedError", async () => {
    await expect(
      orchestrateSubmitBatch({ provider: "gemini", requests: [] }),
    ).rejects.toMatchObject({
      code: "batch_not_supported",
      provider: "gemini",
    });
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
// Test 7 — OpenAI submitBatch shape.
// ---------------------------------------------------------------------------
describe("OpenAI batch implementation", () => {
  it("Test 7 (OPENAI SUBMIT): uploads JSONL via files.create + creates batch via batches.create", async () => {
    filesCreateMock.mockResolvedValue({ id: "file_input_xyz" });
    batchesCreateMock.mockResolvedValue({
      id: "batch_abc",
      status: "validating",
      input_file_id: "file_input_xyz",
    });

    const result = await orchestrateSubmitBatch({
      provider: "openai",
      requests: [
        {
          customId: "abc",
          body: {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            response_format: { type: "json_object" },
            max_tokens: 200,
          },
        },
      ],
    });

    expect(filesCreateMock).toHaveBeenCalledTimes(1);
    const filesArgs = filesCreateMock.mock.calls[0]?.[0] as { purpose: string };
    expect(filesArgs.purpose).toBe("batch");

    expect(batchesCreateMock).toHaveBeenCalledTimes(1);
    const batchArgs = batchesCreateMock.mock.calls[0]?.[0] as {
      input_file_id: string;
      endpoint: string;
      completion_window: string;
    };
    expect(batchArgs.input_file_id).toBe("file_input_xyz");
    expect(batchArgs.endpoint).toBe("/v1/chat/completions");
    expect(batchArgs.completion_window).toBe("24h");

    expect(result).toEqual({
      batchId: "batch_abc",
      inputFileId: "file_input_xyz",
      status: "validating",
    });
  });

  // -------------------------------------------------------------------------
  // Test 8 — OpenAI retrieveBatch shape.
  // -------------------------------------------------------------------------
  it("Test 8 (OPENAI RETRIEVE): maps SDK fields to LlmBatchResult shape", async () => {
    batchesRetrieveMock.mockResolvedValue({
      id: "batch_abc",
      status: "completed",
      input_file_id: "file_in",
      output_file_id: "file_out",
      error_file_id: null,
      completed_at: 1700000000, // unix seconds
      errors: null,
    });

    const result = await orchestrateRetrieveBatch({
      provider: "openai",
      batchId: "batch_abc",
    });

    expect(result).toEqual({
      batchId: "batch_abc",
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: null,
      completedAt: new Date(1700000000 * 1000).toISOString(),
      errorMessage: null,
    });
  });

  // -------------------------------------------------------------------------
  // Test 9 — OpenAI downloadBatchResults parses JSONL.
  // -------------------------------------------------------------------------
  it("Test 9 (OPENAI DOWNLOAD): parses two JSONL lines into LlmBatchOutputLine[]", async () => {
    const jsonl = [
      JSON.stringify({
        custom_id: "row-1",
        response: { status_code: 200, body: { ok: true, value: 1 } },
      }),
      JSON.stringify({
        custom_id: "row-2",
        error: { code: "invalid_request", message: "bad input" },
      }),
    ].join("\n");

    filesContentMock.mockResolvedValue({
      text: async () => jsonl,
    });

    const result = await orchestrateDownloadBatchResults({
      provider: "openai",
      fileId: "file_xyz",
    });

    expect(filesContentMock).toHaveBeenCalledWith("file_xyz");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      customId: "row-1",
      response: { status_code: 200, body: { ok: true, value: 1 } },
      error: null,
    });
    expect(result[1]).toEqual({
      customId: "row-2",
      response: null,
      error: { code: "invalid_request", message: "bad input" },
    });
  });

  // -------------------------------------------------------------------------
  // Test 10 — OpenAI cancelBatch shape.
  // -------------------------------------------------------------------------
  it("Test 10 (OPENAI CANCEL): returns { batchId, status }", async () => {
    batchesCancelMock.mockResolvedValue({
      id: "batch_abc",
      status: "cancelling",
    });

    const result = await orchestrateCancelBatch({
      provider: "openai",
      batchId: "batch_abc",
    });

    expect(batchesCancelMock).toHaveBeenCalledWith("batch_abc");
    expect(result).toEqual({ batchId: "batch_abc", status: "cancelling" });
  });
});
