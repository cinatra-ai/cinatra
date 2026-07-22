/**
 * cinatra#1850 — `resolveConfiguredLlmRuntime` Anthropic last-resort fallback,
 * re-proven against the #1715 switch-over resolution model (adapters resolve
 * ONLY through the connector-registered `llm-provider-adapter` surface; the
 * openai connection snapshot is re-sourced from the openai connector module).
 *
 * The resolution matrix is unchanged:
 *   - Anthropic-only install + flag ON  -> resolves { provider: "anthropic" }.
 *   - Anthropic-only install + flag OFF -> null (global exclusion preserved).
 *   - Multi-provider install + flag ON  -> openai/gemini dbDefault-first winner
 *     is UNCHANGED; Anthropic never beats a configured OpenAI/Gemini.
 *   - No provider configured + flag ON  -> null.
 *   - Explicit `preferredProviders` supplied -> the flag has NO effect.
 *   - Anthropic present but unconfigured (connector adapter -> null) -> skipped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

// Per-provider availability: `resolveProviderAdapter(provider)` resolves an
// adapter iff the connector-registered adapter surface is present AND its
// `createAdapter()` returns non-null. Both "connector absent" and "connector
// present but unconfigured" collapse to "provider unavailable" here.
const availability = { openai: false, gemini: false, anthropic: false } as Record<string, boolean>;
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    availability[providerId]
      ? {
          abiVersion: 1 as const,
          providerId,
          createAdapter: async () => ({ provider: providerId }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

// The openai connection snapshot is re-sourced from the openai connector module
// (the in-tree provider relocated — #1715). Returns a connection iff openai is
// available.
const openaiConnectionMock = vi.fn(async () => null as { apiKey: string } | null);
vi.mock("@/lib/connector-modules.server", () => ({
  loadConnectorModule: vi.fn(async (slug: string) =>
    slug === "openai-connector"
      ? { getConfiguredOpenAIConnection: openaiConnectionMock }
      : null,
  ),
}));

vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));

// Break the circular workspace self-import (./index -> ./tools/skills ->
// @cinatra-ai/skills -> @cinatra-ai/llm).
vi.mock("./tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: vi.fn(),
}));

import { resolveConfiguredLlmRuntime } from "./index";
import { readDefaultLlmProviderFromDatabase } from "@/lib/database";

// Per-test provider availability knobs.
function configure(opts: {
  dbDefault?: "openai" | "gemini";
  openai?: boolean;
  gemini?: boolean;
  anthropic?: boolean;
}) {
  vi.mocked(readDefaultLlmProviderFromDatabase).mockReturnValue(opts.dbDefault ?? "openai");
  availability.openai = Boolean(opts.openai);
  availability.gemini = Boolean(opts.gemini);
  availability.anthropic = Boolean(opts.anthropic);
  openaiConnectionMock.mockResolvedValue(opts.openai ? { apiKey: "sk-openai" } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  availability.openai = false;
  availability.gemini = false;
  availability.anthropic = false;
});

describe("resolveConfiguredLlmRuntime — Anthropic last-resort fallback (cinatra#1850)", () => {
  it("Anthropic-only install + allowAnthropicFallback:true -> resolves the Anthropic runtime", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toEqual({ provider: "anthropic" });
  });

  it("Anthropic-only install WITHOUT the flag -> null (global exclusion preserved)", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime();
    expect(runtime).toBeNull();
  });

  it("multi-provider install (dbDefault=gemini) + flag -> gemini wins; Anthropic never beats it", async () => {
    configure({ dbDefault: "gemini", openai: true, gemini: true, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toEqual({ provider: "gemini" });
  });

  it("multi-provider install (dbDefault=openai) + flag -> openai wins; Anthropic never beats it", async () => {
    configure({ dbDefault: "openai", openai: true, gemini: true, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toEqual({ provider: "openai", connection: { apiKey: "sk-openai" } });
  });

  it("openai unavailable but gemini available + flag -> gemini wins (Anthropic stays last)", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: true, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toEqual({ provider: "gemini" });
  });

  it("no provider configured + flag -> null", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: false });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toBeNull();
  });

  it("explicit preferredProviders is authoritative -> the flag has no effect (Anthropic not appended)", async () => {
    // Only Anthropic is configured, but the caller pins [openai]. The flag must
    // NOT smuggle Anthropic into an explicit list.
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({
      preferredProviders: ["openai"],
      allowAnthropicFallback: true,
    });
    expect(runtime).toBeNull();
  });

  it("explicit preferredProviders:[anthropic] resolves Anthropic verbatim (unchanged contract)", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: true });
    const runtime = await resolveConfiguredLlmRuntime({ preferredProviders: ["anthropic"] });
    expect(runtime).toEqual({ provider: "anthropic" });
  });

  it("Anthropic present but unconfigured (connector adapter -> null) + flag -> skipped -> null", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: false });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toBeNull();
  });
});
