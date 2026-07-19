/**
 * cinatra#1850 — `resolveConfiguredLlmRuntime` Anthropic last-resort fallback.
 *
 * Personal-skill generation (auditor drawer action, background skill-autosave
 * job, and the MCP skills_personal_skill_create_or_update primitive) is a
 * per-purpose task that may legitimately run on Anthropic. It opts in via
 * `{ allowAnthropicFallback: true }`. This locks the resolution matrix:
 *
 *   - Anthropic-only install + flag ON  -> resolves { provider: "anthropic" }.
 *   - Anthropic-only install + flag OFF -> null (global exclusion preserved).
 *   - Multi-provider install + flag ON  -> openai/gemini dbDefault-first winner
 *     is UNCHANGED; Anthropic never beats a configured OpenAI/Gemini.
 *   - No provider configured + flag ON  -> null.
 *   - Explicit `preferredProviders` supplied -> the flag has NO effect (the
 *     list is authoritative).
 *   - Anthropic present but with invalid credentials -> skipped -> null.
 *
 * Mock discipline mirrors the sibling personal-skill-injection.test.ts:
 * everything the index.ts module graph drags in is mocked BEFORE the
 * module-under-test is imported, and each test reconfigures per-provider
 * availability via the mocked accessors.
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

// Anthropic availability flows through getLlmProviderSurface("anthropic")
// .getConfiguredConnection() (see registry.ts getConfiguredAnthropicConnection).
// Adapter surfaces resolve to "absent" so the transitional in-core factory runs.
const anthropicGetConfiguredConnectionMock = vi.fn(async () => null as { apiKey?: string } | null);
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "anthropic"
      ? { getConfiguredConnection: anthropicGetConfiguredConnectionMock }
      : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
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

vi.mock("./providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn((connection: unknown) => ({
    provider: "openai" as const,
    connection,
  })),
  getConfiguredOpenAIConnection: vi.fn(async () => null as { apiKey: string } | null),
}));

vi.mock("./providers/anthropic", () => ({
  createAnthropicProviderAdapter: vi.fn((connection: unknown) => ({
    provider: "anthropic" as const,
    connection,
  })),
}));

vi.mock("./providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(() => ({ provider: "gemini" as const })),
  getConfiguredGeminiConnection: vi.fn(async () => null as { apiKey: string } | null),
}));

import { resolveConfiguredLlmRuntime } from "./index";
import { readDefaultLlmProviderFromDatabase } from "@/lib/database";
import { getConfiguredOpenAIConnection } from "./providers/openai";
import { getConfiguredGeminiConnection } from "./providers/gemini";

// Per-test provider availability knobs.
function configure(opts: {
  dbDefault?: "openai" | "gemini";
  openai?: boolean;
  gemini?: boolean;
  anthropic?: boolean | { apiKey?: string };
}) {
  vi.mocked(readDefaultLlmProviderFromDatabase).mockReturnValue(opts.dbDefault ?? "openai");
  vi.mocked(getConfiguredOpenAIConnection).mockResolvedValue(opts.openai ? { apiKey: "sk-openai" } : null);
  vi.mocked(getConfiguredGeminiConnection).mockResolvedValue(
    opts.gemini ? { apiKey: "gm-key", defaultModel: "gemini-2.0" } : null,
  );
  const anthropicConn =
    opts.anthropic === true
      ? { apiKey: "sk-anthropic" }
      : opts.anthropic && typeof opts.anthropic === "object"
        ? opts.anthropic
        : null;
  anthropicGetConfiguredConnectionMock.mockResolvedValue(anthropicConn);
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it("Anthropic present but with invalid credentials + flag -> skipped -> null", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: { apiKey: "" } });
    const runtime = await resolveConfiguredLlmRuntime({ allowAnthropicFallback: true });
    expect(runtime).toBeNull();
  });
});
