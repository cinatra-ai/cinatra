/**
 * Entry-point ActorContext wrapping tests.
 *
 * Asserts that the four orchestration entry points wrap their bodies in
 * `withActorContext(input.actorContext, ...)` when actorContext is
 * provided AND no outer frame is active. When an outer frame is already
 * active, the entry point must NOT re-wrap (outer frame stays
 * authoritative).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  GenerateInput,
  LlmResponse,
  LlmMcpServerTool,
  StreamInput,
} from "../types";
import type { ActorContext } from "@/lib/authz/actor-context";

// Mocks — same shape as index.mcp-injection.test.ts so importing ./index
// does not drag in real provider SDKs / DB / Nango.
vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
// LLM provider surfaces resolve to "absent" — registry/telemetry degrade
// (anthropic connection null, log writers no-op), same semantics as the
// pre-cutover connector mocks (cinatra#151 Stage 2).
vi.mock("@/lib/llm-provider-surfaces", () => ({
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

// Capture-aware OpenAI adapter: generate/stream record getActorContext()
// at call time. Per-test setter switches the closure used by the adapter.
let _capturedCtx: ActorContext | undefined = "untouched" as unknown as ActorContext;
let _generateImpl: (input: GenerateInput) => Promise<LlmResponse> = async () => {
  // default — capture and return a stub response.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getActorContext } = await import("../actor-context");
  _capturedCtx = getActorContext();
  return { text: "", usage: undefined, model: "mock-model" } as LlmResponse;
};
let _streamImpl: (input: StreamInput) => Promise<void> = async () => {
  const { getActorContext } = await import("../actor-context");
  _capturedCtx = getActorContext();
};

vi.mock("../providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn(() => ({
    provider: "openai" as const,
    defaultModel: "mock-model",
    generate: (input: GenerateInput) => _generateImpl(input),
    stream: (input: StreamInput) => _streamImpl(input),
  })),
  getConfiguredOpenAIConnection: vi.fn(async () => ({ apiKey: "mock-key" })),
}));
vi.mock("../providers/anthropic", () => ({
  createAnthropicProviderAdapter: vi.fn(),
}));
vi.mock("../providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(),
  getConfiguredGeminiConnection: vi.fn(async () => null),
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
  runDeterministicLlmTask,
  runSkillAwareDeterministicLlmTask,
  generate,
  stream,
  withActorContext,
  getActorContext,
} from "../index";

const outerCtx: ActorContext = {
  principalType: "HumanUser",
  principalId: "outer",
  authSource: "ui",
  policyVersion: "v2",
};
const innerCtx: ActorContext = {
  principalType: "HumanUser",
  principalId: "inner",
  authSource: "ui",
  policyVersion: "v2",
};

beforeEach(() => {
  _capturedCtx = "untouched" as unknown as ActorContext;
});

describe("entry-point ActorContext wrapping", () => {
  it("runDeterministicLlmTask: passes actorContext into adapter via ALS frame", async () => {
    await runDeterministicLlmTask({
      provider: "openai",
      system: "s",
      user: "u",
      actorContext: innerCtx,
    });
    expect(_capturedCtx?.principalId).toBe("inner");
  });

  it("runDeterministicLlmTask: no actorContext + no outer frame → throws ACTOR_CONTEXT_MISSING (fail-closed)", async () => {
    await expect(
      runDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
      }),
    ).rejects.toMatchObject({ code: "ACTOR_CONTEXT_MISSING" });
  });

  it("runDeterministicLlmTask: outer frame wins over inner actorContext (no double-wrap)", async () => {
    await withActorContext(outerCtx, async () => {
      await runDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        actorContext: innerCtx,
      });
    });
    expect(_capturedCtx?.principalId).toBe("outer");
    // Outer frame is gone after the call returns.
    expect(getActorContext()).toBeUndefined();
  });

  it("runSkillAwareDeterministicLlmTask: wraps body in actorContext", async () => {
    await runSkillAwareDeterministicLlmTask({
      provider: "openai",
      system: "s",
      user: "u",
      actorContext: innerCtx,
    });
    expect(_capturedCtx?.principalId).toBe("inner");
  });

  it("runSkillAwareDeterministicLlmTask: outer frame wins", async () => {
    await withActorContext(outerCtx, async () => {
      await runSkillAwareDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        actorContext: innerCtx,
      });
    });
    expect(_capturedCtx?.principalId).toBe("outer");
  });

  it("generate: wraps body in actorContext", async () => {
    await generate({
      provider: "openai",
      system: "s",
      prompt: "u",
      actorContext: innerCtx,
    });
    expect(_capturedCtx?.principalId).toBe("inner");
  });

  it("generate: outer frame wins", async () => {
    await withActorContext(outerCtx, async () => {
      await generate({
        provider: "openai",
        system: "s",
        prompt: "u",
        actorContext: innerCtx,
      });
    });
    expect(_capturedCtx?.principalId).toBe("outer");
  });

  it("stream: wraps body in actorContext", async () => {
    await stream({
      provider: "openai",
      system: "s",
      messages: [],
      onTextDelta: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onStepStart: () => undefined,
      onStepFinish: () => undefined,
      onFinish: () => undefined,
      actorContext: innerCtx,
    } as unknown as Parameters<typeof stream>[0]);
    expect(_capturedCtx?.principalId).toBe("inner");
  });

  it("stream: no actorContext, no outer frame → throws ACTOR_CONTEXT_MISSING (fail-closed)", async () => {
    await expect(
      stream({
        provider: "openai",
        system: "s",
        messages: [],
      } as unknown as Parameters<typeof stream>[0]),
    ).rejects.toMatchObject({ code: "ACTOR_CONTEXT_MISSING" });
  });

  it("stream: outer frame wins", async () => {
    await withActorContext(outerCtx, async () => {
      await stream({
        provider: "openai",
        system: "s",
        messages: [],
        actorContext: innerCtx,
      } as unknown as Parameters<typeof stream>[0]);
    });
    expect(_capturedCtx?.principalId).toBe("outer");
  });
});
