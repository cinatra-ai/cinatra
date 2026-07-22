/**
 * Assembly contract test for custom skill instruction rendering.
 *
 * Verifies that runSkillAwareDeterministicLlmTask renders customSkillContent
 * as a separate "Custom skill instructions:" section in the system prompt.
 *
 * The orchestration code at index.ts:404-408 already implements this
 * (personalContext is appended after input.system):
 *
 *   const personalContext = input.customSkillContent
 *     ? `\n\nCustom skill instructions:\n${input.customSkillContent}`
 *     : "";
 *   const system = [input.system, personalContext, skillContext].filter(Boolean).join("\n\n");
 *
 * This test locks the contract so customSkillContent support cannot be
 * dropped without breaking this assertion.
 *
 * The external registry mock uses the CORRECT shape:
 *   buildRegisteredExternalMcpServerTools + buildSingleExternalMcpTool
 *   (NOT listRegisteredExternalMcpServers which does not exist).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GenerateInput, LlmResponse } from "./types";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

// CORRECT external registry mock shape.
// DO NOT use `listRegisteredExternalMcpServers` — it does not exist.
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
            generate: _generateMock,
            stream: vi.fn(async () => undefined),
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

// Break the circular workspace self-import. One transitive path drags in
// @cinatra-ai/skills, which itself imports @cinatra-ai/llm:
//   ./index → ./tools/skills → @cinatra-ai/skills/personal-skills.ts
// (The second pre-cutover path — the openai-connector parseStructuredJson
// re-export — is GONE: the utility now lives in ./structured-json.)
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

// The metric-usage-api may be imported transitively.
vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Capture adapter.generate calls so tests can assert on params.system.
// The OpenAI provider mock returns a factory that captures generate calls.
// ---------------------------------------------------------------------------

let _capturedGenerateInput: GenerateInput | undefined;
const _generateMock = vi.fn(async (input: GenerateInput): Promise<LlmResponse> => {
  _capturedGenerateInput = input;
  return { text: "mock-response", status: null, incompleteReason: null, rawBody: "", usage: undefined, model: "mock-model" };
});

import { runSkillAwareDeterministicLlmTask } from "./index";
import { withActorContext } from "./actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

// runSkillAwareDeterministicLlmTask fail-closes without an ALS actor frame
// (requireActorFrame in index.ts) — establish the deterministic dev actor the
// way every real caller does.
const testActor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-test",
  organizationId: "org-test",
  authSource: "ui",
  policyVersion: "v2",
};
const runWithActor = <T,>(fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(withActorContext(testActor, fn));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSkillAwareDeterministicLlmTask — personal skill rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _capturedGenerateInput = undefined;
    // Restore generate mock after clearAllMocks
    _generateMock.mockImplementation(async (input: GenerateInput): Promise<LlmResponse> => {
      _capturedGenerateInput = input;
      return { text: "mock-response", status: null, incompleteReason: null, rawBody: "", usage: undefined, model: "mock-model" };
    });
  });

  it("appends Custom skill instructions: block when customSkillContent is provided", async () => {
    await runWithActor(() => runSkillAwareDeterministicLlmTask({
      provider: "openai",
      system: "BASE-SYSTEM",
      user: "user prompt",
      customSkillContent: "DELTA-CONTENT-MARKER-XYZ",
    }));

    expect(_capturedGenerateInput).toBeDefined();
    const capturedSystem = _capturedGenerateInput?.system ?? "";

    // Must contain the original base system
    expect(capturedSystem).toContain("BASE-SYSTEM");

    // Must contain the "Custom skill instructions:" section header followed by the delta content
    expect(capturedSystem).toContain("Custom skill instructions:");
    expect(capturedSystem).toContain("DELTA-CONTENT-MARKER-XYZ");

    // The "Custom skill instructions:" section must come AFTER the base system
    const baseIndex = capturedSystem.indexOf("BASE-SYSTEM");
    const customIndex = capturedSystem.indexOf("Custom skill instructions:");
    expect(customIndex).toBeGreaterThan(baseIndex);
  });

  it("does NOT include Custom skill instructions: block when customSkillContent is undefined", async () => {
    await runWithActor(() => runSkillAwareDeterministicLlmTask({
      provider: "openai",
      system: "BASE-SYSTEM",
      user: "user prompt",
      // customSkillContent is deliberately omitted
    }));

    expect(_capturedGenerateInput).toBeDefined();
    const capturedSystem = _capturedGenerateInput?.system ?? "";

    expect(capturedSystem).toContain("BASE-SYSTEM");
    expect(capturedSystem).not.toContain("Custom skill instructions:");
  });
});
