/**
 * LLM provider adapter cutover (cinatra#151 Stage 2) — degraded-semantics
 * pins for the capability-resolved connector members in packages/llm:
 *
 *  - surface ABSENT ⇒ resolveProviderAdapter returns null for every provider
 *    (the existing "not configured" semantics — no new error class);
 *  - log writers (telemetry router + in-adapter) ⇒ NO-OP when the surface or
 *    member is absent, delegate (and propagate errors) when present;
 *  - gemini buildRequestHeaders MISSING on an active surface ⇒ descriptive
 *    fail-loud (design round MEDIUM: the headers carry the host self-client
 *    identity — never silently default);
 *
 * The openai shellTools cases were RETIRED with `createShellTool` (exec-plane
 * S2, cinatra#1707): skill execution runs on the core execution plane; the
 * connector's `shellTools` capability removal is S5.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable per-test surface registry the mocked resolver reads.
const { surfaces } = vi.hoisted(() => ({
  surfaces: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn((providerId: string) => surfaces.get(providerId) ?? null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    const surface = surfaces.get(providerId);
    if (!surface) {
      throw new Error(
        `The "${providerId}" LLM provider connector is not installed/active — ` +
          `install/activate it before using this setting.`,
      );
    }
    return surface;
  }),
  listLlmProviderSurfaces: vi.fn(() => [...surfaces.values()]),
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
vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
// Keep the heavy skills-client graph out.
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: vi.fn(async () => ""),
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: vi.fn(() => ({ installed: { get: vi.fn() } })),
}));

import { resolveProviderAdapter } from "../registry";
import { writeLlmLogFile } from "../telemetry";
import { getConfiguredOpenAIConnection } from "../providers/openai";

beforeEach(() => {
  surfaces.clear();
  vi.clearAllMocks();
});

describe("surface ABSENT — registry degrades to null adapters", () => {
  it.each(["openai", "anthropic", "gemini"] as const)(
    "resolveProviderAdapter(%s) returns null with no registered surface",
    async (provider) => {
      await expect(resolveProviderAdapter(provider)).resolves.toBeNull();
    },
  );

  it("getConfiguredOpenAIConnection returns null (not configured) when absent", async () => {
    await expect(getConfiguredOpenAIConnection()).resolves.toBeNull();
  });
});

describe("log writers — best-effort no-op on absence, delegation when present", () => {
  it("writeLlmLogFile no-ops for openai/gemini when no surface is registered", async () => {
    await expect(
      writeLlmLogFile({ provider: "openai", label: "l", kind: "request", body: {} }),
    ).resolves.toBeUndefined();
    await expect(
      writeLlmLogFile({ provider: "gemini", label: "l", kind: "request", body: {} }),
    ).resolves.toBeUndefined();
  });

  it("writeLlmLogFile no-ops when the surface exists but lacks writeLogFile", async () => {
    surfaces.set("openai", { providerId: "openai" });
    await expect(
      writeLlmLogFile({ provider: "openai", label: "l", kind: "request", body: {} }),
    ).resolves.toBeUndefined();
  });

  it("writeLlmLogFile delegates (and propagates member errors) when present", async () => {
    const writeLogFile = vi.fn(async (_input: unknown) => {});
    surfaces.set("gemini", { providerId: "gemini", writeLogFile });
    await writeLlmLogFile({ provider: "gemini", label: "lab", kind: "response", body: "x" });
    expect(writeLogFile).toHaveBeenCalledWith({ label: "lab", kind: "response", body: "x" });

    writeLogFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      writeLlmLogFile({ provider: "gemini", label: "lab", kind: "response", body: "x" }),
    ).rejects.toThrow("disk full");
  });
});

describe("gemini adapter — connection vs headers member (design MEDIUM)", () => {
  it("adapter resolves null when the gemini surface is absent (degraded, no throw)", async () => {
    await expect(resolveProviderAdapter("gemini")).resolves.toBeNull();
  });

  it("an ACTIVE surface missing buildRequestHeaders fails loud at adapter construction", async () => {
    surfaces.set("gemini", {
      providerId: "gemini",
      getConfiguredAPIKey: async () => "key-123",
      // buildRequestHeaders deliberately MISSING (pre-Stage-2 connector skew)
    });
    // The client is constructed inside createGeminiProviderAdapter — the
    // descriptive error surfaces at resolution rather than silently
    // defaulting headers (a skewed connector is a defect, not a degraded
    // mode: a CONFIGURED key proves the surface registered).
    await expect(resolveProviderAdapter("gemini")).rejects.toThrow(
      /does not expose\s+buildRequestHeaders/,
    );
  });
});
