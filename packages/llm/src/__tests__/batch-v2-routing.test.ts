/**
 * cinatra#2396 — CORE batch routing: capability probe, v2 preference, the
 * legacy v1 fallback, and the SKEW matrix in both directions.
 *
 * What each block proves:
 *   - PROBE      — which surface a provider actually offers, including the trap
 *                  that the shipped Anthropic adapter defines all four v1
 *                  methods as THROWING stubs (a presence-only probe would call
 *                  it batch-capable and then feed it OpenAI-canonical bodies).
 *   - PREFERENCE — an adapter carrying BOTH surfaces is driven through v2, and
 *                  its v1 methods are never touched.
 *   - FALLBACK   — a v1-only adapter still serves the neutral API end to end.
 *   - SKEW       — new-core/old-connector (no `batchV2`) and old-core/new-connector
 *                  (the v1 entry points ignore `batchV2` entirely).
 *   - SEAM       — `outputSchema` is sanitized ONCE, core-side, on BOTH branches.
 *   - MIXED      — succeeded/errored/canceled/expired all land, and a partial
 *                  success keeps its successful rows.
 *
 * Harness mirrors `batch-api.test.ts` (the v1 dispatch suite) so the two read
 * as one story; adapters are supplied through the connector-registered surface
 * exactly as in production.
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
    // Mutated per test so one module graph can serve every skew combination.
    adaptersByProvider: {} as Record<string, object>,
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

vi.mock("../mcp-access", () => ({
  // cinatra#2565 — the reserved-first-party-label guard; identity here
  // (these suites do not exercise external-label impostors).
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
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

import {
  probeBatchCapability,
  orchestrateSubmitBatchV2,
  orchestrateRetrieveBatchV2,
  orchestrateDownloadBatchOutcomesV2,
  orchestrateCancelBatchV2,
  orchestrateSubmitBatch,
  isBatchNotSupportedError,
  isBatchResultsNotReadyError,
  isBatchFailedError,
} from "../index";
import type { LlmBatchV2Request } from "../index";

// ---------------------------------------------------------------------------
// Adapter fixtures — the four skew shapes.
// ---------------------------------------------------------------------------

/** A migrated connector: BOTH surfaces present (v1 untouched, v2 additive). */
function migratedAdapter(provider: string) {
  return {
    provider,
    defaultModel: `${provider}-default-model`,
    ...h.v1,
    batchV2: { version: 2 as const, ...h.v2 },
  };
}

/** An OLD connector: only the shipped v1 methods. */
function legacyAdapter(provider: string) {
  return { provider, defaultModel: `${provider}-default-model`, ...h.v1 };
}

/** No batch surface at all (today: gemini). */
function batchlessAdapter(provider: string) {
  return { provider, defaultModel: `${provider}-default-model` };
}

const REQUESTS: LlmBatchV2Request[] = [
  {
    customId: "row-1",
    system: "You are terse.",
    messages: [{ role: "user", content: "hi" }],
  },
];

beforeEach(() => {
  process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = "false";
  for (const fn of [...Object.values(h.v1), ...Object.values(h.v2)]) fn.mockReset();
  h.adaptersByProvider = {};
});

// ---------------------------------------------------------------------------
// PROBE
// ---------------------------------------------------------------------------
describe("probeBatchCapability", () => {
  it("reports version 2 for an adapter declaring the neutral surface", async () => {
    h.adaptersByProvider.anthropic = migratedAdapter("anthropic");
    expect(await probeBatchCapability("anthropic")).toEqual({
      provider: "anthropic",
      batchVersion: 2,
      cancelSupported: true,
    });
  });

  it("reports version 1 for the legacy OpenAI-canonical adapter", async () => {
    h.adaptersByProvider.openai = legacyAdapter("openai");
    expect(await probeBatchCapability("openai")).toEqual({
      provider: "openai",
      batchVersion: 1,
      cancelSupported: true,
    });
  });

  it("TRAP: an old Anthropic adapter whose v1 methods only THROW is NOT reported batch-capable", async () => {
    // The shipped stub shape: all four members exist, each throws
    // BatchNotSupportedError. Presence alone must not imply capability, or the
    // bridge would hand Anthropic OpenAI-canonical chat-completions bodies.
    h.adaptersByProvider.anthropic = {
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      submitBatch: async () => {
        throw new Error("unreachable");
      },
      retrieveBatch: async () => {
        throw new Error("unreachable");
      },
      downloadBatchResults: async () => {
        throw new Error("unreachable");
      },
      cancelBatch: async () => {
        throw new Error("unreachable");
      },
    };
    expect(await probeBatchCapability("anthropic")).toEqual({
      provider: "anthropic",
      batchVersion: null,
      cancelSupported: false,
    });
  });

  it("reports null for an adapter with no batch surface, and for an unresolvable provider", async () => {
    h.adaptersByProvider.gemini = batchlessAdapter("gemini");
    expect(await probeBatchCapability("gemini")).toMatchObject({ batchVersion: null });
    expect(await probeBatchCapability("openai")).toEqual({
      provider: "openai",
      batchVersion: null,
      cancelSupported: false,
    });
  });

  it("FAIL-CLOSED: an UNRECOGNISED batchV2.version is not treated as a newer surface", async () => {
    h.adaptersByProvider.anthropic = {
      ...batchlessAdapter("anthropic"),
      batchV2: { version: 99, submit: h.v2.submit, retrieve: h.v2.retrieve, download: h.v2.download },
    };
    // No v1 leg either (anthropic is not the canonical v1 provider) ⇒ unsupported.
    expect(await probeBatchCapability("anthropic")).toMatchObject({ batchVersion: null });
  });

  it("cancelSupported is probed SEPARATELY — a v2 surface may omit cancel", async () => {
    h.adaptersByProvider.anthropic = {
      ...batchlessAdapter("anthropic"),
      batchV2: { version: 2 as const, submit: h.v2.submit, retrieve: h.v2.retrieve, download: h.v2.download },
    };
    expect(await probeBatchCapability("anthropic")).toEqual({
      provider: "anthropic",
      batchVersion: 2,
      cancelSupported: false,
    });
  });
});

// ---------------------------------------------------------------------------
// PREFERENCE — v2 wins whenever it is declared
// ---------------------------------------------------------------------------
describe("core PREFERS v2 when the adapter declares it", () => {
  beforeEach(() => {
    h.adaptersByProvider.anthropic = migratedAdapter("anthropic");
  });

  it("submit goes to batchV2.submit and NEVER to the v1 method", async () => {
    h.v2.submit.mockResolvedValue({ batchId: "msgbatch_1", status: "in_progress" });
    const result = await orchestrateSubmitBatchV2({
      provider: "anthropic",
      requests: REQUESTS,
      metadata: { run: "r1" },
    });
    expect(result).toEqual({ batchId: "msgbatch_1", status: "in_progress" });
    expect(h.v2.submit).toHaveBeenCalledWith({
      requests: [
        { customId: "row-1", system: "You are terse.", messages: [{ role: "user", content: "hi" }] },
      ],
      metadata: { run: "r1" },
    });
    expect(h.v1.submitBatch).not.toHaveBeenCalled();
  });

  it("retrieve/download/cancel all route to the v2 surface", async () => {
    const state = {
      batchId: "msgbatch_1",
      status: "ended",
      counts: { total: 1, processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
      endedAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-05T00:00:00.000Z",
      errorMessage: null,
    };
    h.v2.retrieve.mockResolvedValue(state);
    h.v2.download.mockResolvedValue([]);
    h.v2.cancel.mockResolvedValue({ ...state, status: "canceling" });

    expect(await orchestrateRetrieveBatchV2({ provider: "anthropic", batchId: "msgbatch_1" })).toBe(state);
    expect(h.v2.retrieve).toHaveBeenCalledWith("msgbatch_1");
    await orchestrateDownloadBatchOutcomesV2({ provider: "anthropic", batchId: "msgbatch_1" });
    expect(h.v2.download).toHaveBeenCalledWith("msgbatch_1");
    expect(
      (await orchestrateCancelBatchV2({ provider: "anthropic", batchId: "msgbatch_1" })).status,
    ).toBe("canceling");
    expect(h.v1.retrieveBatch).not.toHaveBeenCalled();
    expect(h.v1.downloadBatchResults).not.toHaveBeenCalled();
    expect(h.v1.cancelBatch).not.toHaveBeenCalled();
  });

  it("rejects a malformed batch BEFORE any adapter call", async () => {
    await expect(
      orchestrateSubmitBatchV2({ provider: "anthropic", requests: [] }),
    ).rejects.toThrow(/at least one request/);
    expect(h.v2.submit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FALLBACK — a v1-only adapter still serves the neutral API
// ---------------------------------------------------------------------------
describe("legacy v1 FALLBACK (new core / old connector)", () => {
  beforeEach(() => {
    h.adaptersByProvider.openai = legacyAdapter("openai");
  });

  it("submit renders the canonical body and normalizes the v1 status", async () => {
    h.v1.submitBatch.mockResolvedValue({
      batchId: "batch_1",
      inputFileId: "file_in",
      status: "validating",
    });
    const result = await orchestrateSubmitBatchV2({ provider: "openai", requests: REQUESTS });
    expect(h.v1.submitBatch).toHaveBeenCalledWith({
      requests: [
        {
          customId: "row-1",
          body: {
            model: "openai-default-model",
            messages: [
              { role: "system", content: "You are terse." },
              { role: "user", content: "hi" },
            ],
            max_completion_tokens: 4096,
          },
        },
      ],
    });
    // "validating" is an OpenAI-only string; the neutral surface never leaks it.
    expect(result).toEqual({ batchId: "batch_1", status: "in_progress" });
  });

  it("retrieve normalizes the v1 envelope and reports counts as null", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "finalizing",
      inputFileId: "file_in",
      outputFileId: null,
      errorFileId: null,
      completedAt: null,
      errorMessage: null,
    });
    expect(await orchestrateRetrieveBatchV2({ provider: "openai", batchId: "batch_1" })).toEqual({
      batchId: "batch_1",
      status: "in_progress",
      counts: null,
      endedAt: null,
      expiresAt: null,
      errorMessage: null,
    });
  });

  it("download merges the OUTPUT and ERROR files into one normalized list", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: "file_err",
      completedAt: "2026-08-04T00:00:00.000Z",
      errorMessage: null,
    });
    h.v1.downloadBatchResults.mockImplementation(async (fileId: string) =>
      fileId === "file_out"
        ? [
            {
              customId: "row-1",
              response: { status_code: 200, body: { choices: [{ message: { content: "ok" } }] } },
              error: null,
            },
          ]
        : [
            {
              customId: "row-2",
              response: null,
              error: { code: "rate_limit_error", message: "slow down" },
            },
          ],
    );

    const outcomes = await orchestrateDownloadBatchOutcomesV2({
      provider: "openai",
      batchId: "batch_1",
    });
    expect(h.v1.downloadBatchResults).toHaveBeenCalledWith("file_out");
    expect(h.v1.downloadBatchResults).toHaveBeenCalledWith("file_err");
    expect(outcomes.map((o) => [o.customId, o.status])).toEqual([
      ["row-1", "succeeded"],
      ["row-2", "errored"],
    ]);
  });

  it("download SKIPS a null file id rather than calling with null", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: null,
      completedAt: null,
      errorMessage: null,
    });
    h.v1.downloadBatchResults.mockResolvedValue([]);
    await orchestrateDownloadBatchOutcomesV2({ provider: "openai", batchId: "batch_1" });
    expect(h.v1.downloadBatchResults).toHaveBeenCalledTimes(1);
    expect(h.v1.downloadBatchResults).toHaveBeenCalledWith("file_out");
  });

  it("download on a still-running batch throws BatchResultsNotReadyError — never an empty list", async () => {
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "in_progress",
      inputFileId: "file_in",
      outputFileId: null,
      errorFileId: null,
      completedAt: null,
      errorMessage: null,
    });
    const err = await orchestrateDownloadBatchOutcomesV2({
      provider: "openai",
      batchId: "batch_1",
    }).catch((e: unknown) => e);
    expect(isBatchResultsNotReadyError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "batch_results_not_ready",
      provider: "openai",
      batchId: "batch_1",
      status: "in_progress",
    });
    expect(h.v1.downloadBatchResults).not.toHaveBeenCalled();
  });

  it("download on a FAILED batch throws the TERMINAL BatchFailedError, not the retryable one", async () => {
    // A failed batch never acquires outcomes. Raising the not-ready sentinel
    // here would invite a consumer that recognises it to poll forever.
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "failed",
      inputFileId: "file_in",
      outputFileId: null,
      errorFileId: null,
      completedAt: null,
      errorMessage: "input file was malformed",
    });
    const err = await orchestrateDownloadBatchOutcomesV2({
      provider: "openai",
      batchId: "batch_1",
    }).catch((e: unknown) => e);
    expect(isBatchFailedError(err)).toBe(true);
    expect(isBatchResultsNotReadyError(err)).toBe(false);
    expect(err).toMatchObject({
      code: "batch_failed",
      provider: "openai",
      batchId: "batch_1",
      reason: "input file was malformed",
    });
    expect(h.v1.downloadBatchResults).not.toHaveBeenCalled();
  });

  it("cancel maps the v1 status and states honestly that counts are unknown", async () => {
    h.v1.cancelBatch.mockResolvedValue({ batchId: "batch_1", status: "cancelling" });
    expect(await orchestrateCancelBatchV2({ provider: "openai", batchId: "batch_1" })).toEqual({
      batchId: "batch_1",
      status: "canceling",
      counts: null,
      endedAt: null,
      expiresAt: null,
      errorMessage: null,
    });
  });
});

// ---------------------------------------------------------------------------
// NO SURFACE — the unchanged capability-routing signal
// ---------------------------------------------------------------------------
describe("a provider with NEITHER surface keeps raising BatchNotSupportedError", () => {
  it("all four v2 entry points raise the signal a capability router already handles", async () => {
    h.adaptersByProvider.gemini = batchlessAdapter("gemini");
    for (const call of [
      () => orchestrateSubmitBatchV2({ provider: "gemini", requests: REQUESTS }),
      () => orchestrateRetrieveBatchV2({ provider: "gemini", batchId: "x" }),
      () => orchestrateDownloadBatchOutcomesV2({ provider: "gemini", batchId: "x" }),
      () => orchestrateCancelBatchV2({ provider: "gemini", batchId: "x" }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(isBatchNotSupportedError(err)).toBe(true);
      expect(err).toMatchObject({ provider: "gemini" });
    }
  });

  it("a v2 surface WITHOUT cancel raises BatchNotSupportedError for cancel only", async () => {
    h.adaptersByProvider.anthropic = {
      ...batchlessAdapter("anthropic"),
      batchV2: { version: 2 as const, submit: h.v2.submit, retrieve: h.v2.retrieve, download: h.v2.download },
    };
    h.v2.retrieve.mockResolvedValue({
      batchId: "b",
      status: "ended",
      counts: null,
      endedAt: null,
      expiresAt: null,
      errorMessage: null,
    });
    await expect(
      orchestrateRetrieveBatchV2({ provider: "anthropic", batchId: "b" }),
    ).resolves.toMatchObject({ status: "ended" });
    const err = await orchestrateCancelBatchV2({ provider: "anthropic", batchId: "b" }).catch(
      (e: unknown) => e,
    );
    expect(isBatchNotSupportedError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SKEW — old core / new connector
// ---------------------------------------------------------------------------
describe("SKEW: old core / new connector — the v1 entry points ignore batchV2 entirely", () => {
  it("orchestrateSubmitBatch (v1) still forwards the caller's native body verbatim", async () => {
    // A migrated connector carries BOTH surfaces. An old core only knows the v1
    // methods; this asserts those keep their exact shipped behavior — the ABI
    // guarantee that lets the contract land before any connector release.
    h.adaptersByProvider.openai = migratedAdapter("openai");
    const adapterResult = { batchId: "batch_1", inputFileId: "file_in", status: "validating" };
    h.v1.submitBatch.mockResolvedValue(adapterResult);
    const requests = [{ customId: "abc", body: { model: "gpt-4o-mini", messages: [] } }];

    const result = await orchestrateSubmitBatch({ provider: "openai", requests });

    expect(h.v1.submitBatch).toHaveBeenCalledWith({ requests });
    expect(result).toBe(adapterResult);
    expect(h.v2.submit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SEAM — sanitization happens ONCE, core-side, on BOTH branches
// ---------------------------------------------------------------------------
describe("SCHEMA SANITIZATION at the batch seam (cinatra#2339/#2343)", () => {
  const schema = {
    type: "object",
    properties: { confidence: { type: "number", minimum: 0, maximum: 1 } },
    additionalProperties: false,
  };

  it("ANTHROPIC v2: the adapter receives an ALREADY-SANITIZED schema", async () => {
    h.adaptersByProvider.anthropic = migratedAdapter("anthropic");
    h.v2.submit.mockResolvedValue({ batchId: "b", status: "in_progress" });
    await orchestrateSubmitBatchV2({
      provider: "anthropic",
      requests: [{ ...REQUESTS[0], outputSchema: schema }],
    });
    const delivered = h.v2.submit.mock.calls[0][0].requests[0].outputSchema;
    expect(delivered.properties.confidence.minimum).toBeUndefined();
    expect(delivered.properties.confidence.maximum).toBeUndefined();
    expect(String(delivered.properties.confidence.description)).toContain("minimum 0 (inclusive)");
    // The caller's object is untouched — sanitization is a copy, not a mutation.
    expect(schema.properties.confidence.minimum).toBe(0);
  });

  it("OPENAI v1 bridge: the schema rides through byte-identical (same reference)", async () => {
    h.adaptersByProvider.openai = legacyAdapter("openai");
    h.v1.submitBatch.mockResolvedValue({ batchId: "b", inputFileId: "f", status: "validating" });
    await orchestrateSubmitBatchV2({
      provider: "openai",
      requests: [{ ...REQUESTS[0], outputSchema: schema }],
    });
    const body = h.v1.submitBatch.mock.calls[0][0].requests[0].body;
    expect(body.response_format.json_schema.schema).toBe(schema);
  });
});

// ---------------------------------------------------------------------------
// MIXED OUTCOMES
// ---------------------------------------------------------------------------
describe("MIXED-outcome batches", () => {
  it("v2: succeeded / errored / canceled / expired all survive the routing layer", async () => {
    h.adaptersByProvider.anthropic = migratedAdapter("anthropic");
    const outcomes = [
      { customId: "a", status: "succeeded", text: "yes", model: "claude", stopReason: "end_turn", rawBody: "{}" },
      {
        customId: "b",
        status: "errored",
        error: { code: "not_found", message: "no model", providerCode: "not_found_error", providerStatus: 404 },
        rawBody: "{}",
      },
      { customId: "c", status: "canceled" },
      { customId: "d", status: "expired" },
    ];
    h.v2.download.mockResolvedValue(outcomes);
    expect(
      await orchestrateDownloadBatchOutcomesV2({ provider: "anthropic", batchId: "b1" }),
    ).toEqual(outcomes);
  });

  it("v1 bridge: PARTIAL SUCCESS keeps its successful rows alongside the failed ones", async () => {
    h.adaptersByProvider.openai = legacyAdapter("openai");
    h.v1.retrieveBatch.mockResolvedValue({
      batchId: "batch_1",
      status: "completed",
      inputFileId: "file_in",
      outputFileId: "file_out",
      errorFileId: "file_err",
      completedAt: null,
      errorMessage: null,
    });
    h.v1.downloadBatchResults.mockImplementation(async (fileId: string) =>
      fileId === "file_out"
        ? [
            {
              customId: "ok-1",
              response: { status_code: 200, body: { choices: [{ message: { content: "A" } }] } },
              error: null,
            },
            {
              customId: "bad-2",
              response: { status_code: 404, body: { error: { code: "model_not_found", message: "nope" } } },
              error: null,
            },
          ]
        : [{ customId: "bad-3", response: null, error: { code: "server_error", message: "boom" } }],
    );

    const outcomes = await orchestrateDownloadBatchOutcomesV2({
      provider: "openai",
      batchId: "batch_1",
    });
    expect(outcomes).toHaveLength(3);
    const succeeded = outcomes.filter((o) => o.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({ customId: "ok-1", text: "A" });
    expect(outcomes.filter((o) => o.status === "errored").map((o) => o.customId)).toEqual([
      "bad-2",
      "bad-3",
    ]);
  });
});
