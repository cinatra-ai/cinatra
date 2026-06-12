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
 *  - openai shellTools MISSING/ABSENT ⇒ createShellTool fails loud with a
 *    descriptive error; the executor input carries NO administration
 *    override and the readSettings shape is runtime-guarded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable per-test surface registry the mocked resolver reads.
const { surfaces } = vi.hoisted(() => ({
  surfaces: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
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
// Keep the heavy skills-client graph out; createShellTool itself is REAL.
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: vi.fn(async () => ""),
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: vi.fn(() => ({ installed: { get: vi.fn() } })),
}));

import { resolveProviderAdapter } from "../registry";
import { writeLlmLogFile } from "../telemetry";
import { createShellTool } from "../tools/skills";
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

describe("openai shellTools — gated member resolution (design HIGH)", () => {
  it("createShellTool fails loud with NO openai surface", () => {
    expect(() => createShellTool({ mountedSkills: [] })).toThrow(/not installed\/active/);
  });

  it("createShellTool fails loud when the surface lacks shellTools (pre-Stage-2 skew)", () => {
    surfaces.set("openai", { providerId: "openai" });
    expect(() => createShellTool({ mountedSkills: [] })).toThrow(
      /does not expose the\s+gated shellTools/,
    );
  });

  it("execute forwards NO administration override and guards the settings shape", async () => {
    const runCommandInDocker = vi.fn(async (_input: unknown) => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    }));
    // Malformed settings shape: maxOutputKilobytes is a string — the runtime
    // guard must NOT do junk math; the limit defers to the executor's stored
    // settings (undefined).
    const readSettings = vi.fn(() => ({ maxOutputKilobytes: "64" }));
    surfaces.set("openai", {
      providerId: "openai",
      shellTools: { readSettings, runCommandInDocker },
    });

    const tool = createShellTool({ mountedSkills: [] });
    const results = await tool.execute({ commands: ["echo hi"] });
    expect(results).toEqual([
      { stdout: "ok", stderr: "", outcome: { type: "exit", exitCode: 0 } },
    ]);
    expect(runCommandInDocker).toHaveBeenCalledTimes(1);
    const forwarded = runCommandInDocker.mock.calls[0][0] as Record<string, unknown>;
    expect("administration" in forwarded).toBe(false);
    expect(forwarded.maxOutputLength).toBeUndefined();
  });

  it("a well-formed maxOutputKilobytes becomes the default output limit", async () => {
    const runCommandInDocker = vi.fn(async (_input: unknown) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    surfaces.set("openai", {
      providerId: "openai",
      shellTools: { readSettings: () => ({ maxOutputKilobytes: 64 }), runCommandInDocker },
    });

    const tool = createShellTool({ mountedSkills: [] });
    await tool.execute({ commands: ["echo hi"] });
    const forwarded = runCommandInDocker.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.maxOutputLength).toBe(64 * 1024);
  });
});
