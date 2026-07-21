/**
 * llm-providers S4 (cinatra#1715) — `resolveProviderAdapter` honours the
 * connector-registered `llm-provider-adapter` surface:
 *   - surface WINS (the in-core factory is not consulted),
 *   - a surface `createAdapter()->null` is AUTHORITATIVE (no legacy fallback),
 *   - an ABSENT surface falls through to the transitional in-core factory
 *     (zero behavior change for the current, un-relocated image),
 *   - a malformed surface's fail-closed throw PROPAGATES (never silent fallback).
 *
 * Mocks mirror the sibling `registry-declared-toolboxes.test.ts` discipline
 * (registered BEFORE the module-under-test is imported).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn((connection: unknown) => ({
    provider: "openai",
    via: "legacy",
    connection,
  })),
  getConfiguredOpenAIConnection: vi.fn(async () => ({ apiKey: "sk-legacy" })),
}));
vi.mock("./providers/anthropic", () => ({
  createAnthropicProviderAdapter: vi.fn(),
}));
vi.mock("./providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(),
  getConfiguredGeminiConnection: vi.fn(async () => null),
}));
vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(),
  listLlmProviderSurfaces: vi.fn(() => []),
  // llm-providers S4: co-located with the surface resolver in the same module.
  getLlmProviderAdapterSurface: vi.fn(() => null),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  sanitizeExternalMcpToolboxTools: vi.fn((tools: unknown) => tools),
}));

import { getLlmProviderAdapterSurface } from "@/lib/llm-provider-surfaces";
import { getConfiguredOpenAIConnection, createOpenAIProviderAdapter } from "./providers/openai";
import { resolveProviderAdapter } from "./registry";
import type { LlmProviderAdapter } from "./types";

function surface(createAdapter: () => Promise<LlmProviderAdapter | null>) {
  return { abiVersion: 1 as const, providerId: "openai", createAdapter };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(null);
});

describe("resolveProviderAdapter — llm-provider-adapter surface (S4)", () => {
  it("uses the connector-registered adapter and does NOT consult the in-core factory", async () => {
    // Deliberate partial stub — this test proves reference identity + null
    // authority, not adapter shape; cast to the firmed ABI type (S4.0).
    const adapter = { provider: "openai", via: "surface" } as unknown as LlmProviderAdapter;
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(surface(async () => adapter));

    const result = await resolveProviderAdapter("openai");

    expect(result).toBe(adapter);
    expect(vi.mocked(getConfiguredOpenAIConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(createOpenAIProviderAdapter)).not.toHaveBeenCalled();
  });

  it("treats a surface createAdapter()->null as AUTHORITATIVE (no legacy fallback)", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(surface(async () => null));

    const result = await resolveProviderAdapter("openai");

    expect(result).toBeNull();
    expect(vi.mocked(getConfiguredOpenAIConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(createOpenAIProviderAdapter)).not.toHaveBeenCalled();
  });

  it("falls back to the in-core factory when NO surface is registered (transitional zero-behavior-change)", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(null);

    const result = await resolveProviderAdapter("openai");

    expect(vi.mocked(getConfiguredOpenAIConnection)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createOpenAIProviderAdapter)).toHaveBeenCalledWith({ apiKey: "sk-legacy" });
    expect(result).toMatchObject({ provider: "openai", via: "legacy" });
  });

  it("propagates a fail-closed throw from a malformed surface (never silent fallback)", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockImplementation(() => {
      throw new Error("llm-provider-adapter surface is registered but malformed");
    });

    await expect(resolveProviderAdapter("openai")).rejects.toThrow(/malformed/);
    expect(vi.mocked(getConfiguredOpenAIConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(createOpenAIProviderAdapter)).not.toHaveBeenCalled();
  });
});
