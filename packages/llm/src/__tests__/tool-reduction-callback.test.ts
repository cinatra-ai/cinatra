import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateInput, StreamInput, LlmToolReduction, LlmToolReference } from "../index";

let captured: GenerateInput | StreamInput | undefined;
const removed: readonly LlmToolReference[] = [{ type: "mcp", serverLabel: "injected-platform" }];
const reduction: LlmToolReduction = { removed };
const _generateImpl = async (input: GenerateInput) => {
  captured = input;
  input.onToolsReduced?.(reduction);
  return { text: "reduced answer", status: "completed", incompleteReason: null, rawBody: "{}" };
};
const _streamImpl = async (input: StreamInput) => {
  captured = input;
  input.onToolsReduced?.(reduction);
  input.onTextDelta("reduced answer");
};

vi.mock("../mcp-access", () => ({
  // cinatra#2565 — the reserved-first-party-label guard; identity here
  // (these suites do not exercise external-label impostors).
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(async () => ({
    type: "mcp", serverLabel: "injected-platform", serverUrl: "https://example.test/mcp",
  })),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
// The OpenAI adapter resolves through the connector-registered
// `llm-provider-adapter` surface (cinatra#1715 switch-over — there is no in-core
// factory). The surface supplies the capture-aware adapter; every other surface
// is absent (telemetry log writers no-op).
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    providerId === "openai"
      ? {
          abiVersion: 1 as const,
          providerId: "openai",
          createAdapter: async () => ({
            provider: "openai" as const,
            defaultModel: "mock-model",
            generate: (input: GenerateInput) => _generateImpl(input),
            stream: (input: StreamInput) => _streamImpl(input),
          }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
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

import { generate, stream } from "../index";

const actorContext = {
  principalType: "HumanUser" as const,
  principalId: "u1", authSource: "ui" as const, policyVersion: "v2",
};
const callbacks = {
  onTextDelta: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(),
  onStepStart: vi.fn(), onStepEnd: vi.fn(), onError: vi.fn(),
};

beforeEach(() => { captured = undefined; vi.clearAllMocks(); });

describe("orchestration preserves the optional tool-reduction callback", () => {
  it.each(["stream", "generate"] as const)("passes it through %s after real tool assembly", async (mode) => {
    const onToolsReduced = vi.fn();
    const common = {
      provider: "openai" as const, system: "s", actorContext,
      declaredToolboxIds: ["cinatra-mcp"],
      tools: [{ type: "web_search" as const }], onToolsReduced,
    };
    if (mode === "stream") {
      await stream({ ...common, messages: [{ role: "user", content: "hello" }], ...callbacks });
    } else {
      await generate({ ...common, prompt: "hello" });
    }
    expect(captured?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mcp", serverLabel: "injected-platform" }),
    ]));
    expect(captured?.onToolsReduced).toBe(onToolsReduced);
    expect(onToolsReduced).toHaveBeenCalledExactlyOnceWith(reduction);
  });

  it("does not add a callback to a caller that did not supply it", async () => {
    await generate({ provider: "openai", system: "s", prompt: "hello", actorContext });
    expect(captured).not.toHaveProperty("onToolsReduced");
    await stream({ provider: "openai", system: "s", messages: [], actorContext, ...callbacks });
    expect(captured).not.toHaveProperty("onToolsReduced");
  });
});
