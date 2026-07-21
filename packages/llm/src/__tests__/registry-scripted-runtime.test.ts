// hasConfiguredLlmRuntime scripted-awareness (cinatra#1919 AC3) + the
// resolveDefaultAdapter conformance pin.
//
//   - With the deterministic provider enabled, hasConfiguredLlmRuntime reports
//     CONFIGURED without consulting any provider/DB — so the widget broker gate
//     (`/api/assistants/chat`) does not 400 the turn before the scripted stream
//     can answer.
//   - With the flag off, it delegates unchanged (false when no provider).
//   - resolveDefaultAdapter is UNCHANGED in BOTH modes (it never gained scripted
//     awareness): scripted mode still resolves null when no provider is
//     configured — the runtime's widget short-circuit runs BEFORE it.

import { afterEach, describe, expect, it, vi } from "vitest";

const readDefaultLlmProviderFromDatabase = vi.fn(() => "openai");

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => null,
  getLlmProviderAdapterSurface: () => null,
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: () => readDefaultLlmProviderFromDatabase(),
  readDefaultImageProviderFromDatabase: () => null,
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  loadExternalMcpToolboxByServerId: vi.fn(async () => null),
}));
vi.mock("../providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn(),
  getConfiguredOpenAIConnection: vi.fn(async () => null),
}));
vi.mock("../providers/anthropic", () => ({ createAnthropicProviderAdapter: vi.fn() }));
vi.mock("../providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(),
  getConfiguredGeminiConnection: vi.fn(async () => null),
}));
vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(),
  buildExternalMcpServerTools: vi.fn(),
}));

import { hasConfiguredLlmRuntime, resolveDefaultAdapter } from "../registry";

const ORIG_FLAG = process.env.CINATRA_TEST_LLM_PROVIDER;
afterEach(() => {
  process.env.CINATRA_TEST_LLM_PROVIDER = ORIG_FLAG;
  readDefaultLlmProviderFromDatabase.mockClear();
});

describe("hasConfiguredLlmRuntime scripted-awareness", () => {
  it("reports CONFIGURED under the scripted provider WITHOUT consulting any provider/DB", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    expect(await hasConfiguredLlmRuntime()).toBe(true);
    // Early return — the DB default (adapter-resolution path) was never consulted.
    expect(readDefaultLlmProviderFromDatabase).not.toHaveBeenCalled();
  });

  it("delegates unchanged when the flag is OFF (false when no provider is configured)", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    expect(await hasConfiguredLlmRuntime()).toBe(false);
    expect(readDefaultLlmProviderFromDatabase).toHaveBeenCalled();
  });
});

describe("resolveDefaultAdapter conformance pin (unchanged in both modes)", () => {
  it("still resolves null when no provider is configured — even under the scripted flag", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    expect(await resolveDefaultAdapter()).toBeNull();
  });

  it("resolves null with the flag off (no provider configured)", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    expect(await resolveDefaultAdapter()).toBeNull();
  });
});
