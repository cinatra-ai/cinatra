/**
 * Execution-plane INJECTION COVERAGE across all four orchestration entry points
 * (exec-plane S1, cinatra#1706 AC5).
 *
 * Proves the single injection site runs in `generate`, `stream`,
 * `runDeterministicLlmTask`, and `runSkillAwareDeterministicLlmTask`, and that
 * S1's provider-boundary posture holds in every one of them:
 *  - the sandbox tool + carrier + cue NEVER reach a provider adapter in S1
 *    (byte-identical provider payload — provider translation is S2);
 *  - a flag-ON call with NO attributable session fails closed with a structured
 *    `no_session` warning while the model stays usable (fail-closed per entry
 *    point);
 *  - default (flag OFF) is byte-identical with no warning.
 *
 * Mock shape mirrors entry-point-actor-context.test.ts so importing ./index
 * does not drag in real provider SDKs / DB / Nango.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GenerateInput, LlmResponse, StreamInput } from "../../types";
import type { ActorContext } from "@/lib/authz/actor-context";

vi.mock("../../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
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

let _capturedGenerate: GenerateInput | undefined;
let _capturedStream: StreamInput | undefined;

vi.mock("../../providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn(() => ({
    provider: "openai" as const,
    defaultModel: "mock-model",
    generate: (input: GenerateInput) => {
      _capturedGenerate = input;
      return Promise.resolve({
        text: "",
        usage: undefined,
        model: "mock-model",
      } as LlmResponse);
    },
    stream: (input: StreamInput) => {
      _capturedStream = input;
      return Promise.resolve();
    },
  })),
  getConfiguredOpenAIConnection: vi.fn(async () => ({ apiKey: "mock-key" })),
}));
vi.mock("../../providers/anthropic", () => ({
  createAnthropicProviderAdapter: vi.fn(),
}));
vi.mock("../../providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(),
  getConfiguredGeminiConnection: vi.fn(async () => null),
}));
vi.mock("../../tools/skills", () => ({
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
  buildSandboxExecutionTool,
  sealExecutionSession,
} from "../../index";
import type { ExecutionSession } from "../../index";
import type { LlmTool } from "../../types";

const ctx: ActorContext = {
  principalType: "HumanUser",
  principalId: "u",
  authSource: "ui",
  policyVersion: "v2",
};
const session: ExecutionSession = {
  orgId: "org-1",
  userId: "user-1",
  surface: "chat",
};

function hasSandboxTool(tools: unknown): boolean {
  return (
    Array.isArray(tools) &&
    tools.some((t) => t && typeof t === "object" && (t as { type?: string }).type === "sandbox_execution")
  );
}
function cueLeaked(system: unknown): boolean {
  return typeof system === "string" && system.includes("sandbox_execute");
}

const noopStreamCallbacks = {
  onTextDelta: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onStepStart: () => {},
  onStepEnd: () => {},
  onError: () => {},
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let priorRollout: string | undefined;
let priorSecret: string | undefined;

beforeEach(() => {
  _capturedGenerate = undefined;
  _capturedStream = undefined;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  priorRollout = process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  priorSecret = process.env.EXECUTION_BROKER_SECRET;
});
afterEach(() => {
  warnSpy.mockRestore();
  if (priorRollout === undefined) delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  else process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = priorRollout;
  if (priorSecret === undefined) delete process.env.EXECUTION_BROKER_SECRET;
  else process.env.EXECUTION_BROKER_SECRET = priorSecret;
});

function enablePlane() {
  process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = "on";
  process.env.EXECUTION_BROKER_SECRET = "entry-test-secret";
}
function noWarn() {
  return !warnSpy.mock.calls.some((c) => String(c[0]).includes("[execution-plane]"));
}
function noSessionWarned(entryPoint: string) {
  return warnSpy.mock.calls.some(
    (c) => String(c[0]).includes(`[execution-plane] ${entryPoint}`) && String(c[0]).includes("no_session"),
  );
}

describe("flag ON + valid session — provider payload is byte-identical (S1)", () => {
  it("generate: no sandbox tool, no cue reaches the adapter", async () => {
    enablePlane();
    await generate({ provider: "openai", system: "SYS", prompt: "hi", actorContext: ctx, executionSession: session });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(false);
    expect(noWarn()).toBe(true);
  });

  it("stream: no sandbox tool, no cue reaches the adapter", async () => {
    enablePlane();
    await stream({
      provider: "openai",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      actorContext: ctx,
      executionSession: session,
      ...noopStreamCallbacks,
    });
    expect(_capturedStream).toBeDefined();
    expect(hasSandboxTool(_capturedStream!.tools)).toBe(false);
    expect(cueLeaked(_capturedStream!.system)).toBe(false);
    expect(noWarn()).toBe(true);
  });

  it("runDeterministicLlmTask: no sandbox tool, no cue reaches the adapter", async () => {
    enablePlane();
    await runDeterministicLlmTask({
      provider: "openai",
      system: "SYS",
      user: "hi",
      actorContext: ctx,
      executionSession: { ...session, surface: "deterministic_task" },
    });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(false);
    expect(noWarn()).toBe(true);
  });

  it("runSkillAwareDeterministicLlmTask: no sandbox tool, no cue reaches the adapter", async () => {
    enablePlane();
    await runSkillAwareDeterministicLlmTask({
      provider: "openai",
      system: "SYS",
      user: "hi",
      actorContext: ctx,
      executionSession: { ...session, surface: "skill_task" },
    });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(false);
    expect(noWarn()).toBe(true);
  });
});

describe("flag ON + NO session — fail-closed per entry point, model still usable", () => {
  it("generate warns no_session and still calls the adapter", async () => {
    enablePlane();
    await generate({ provider: "openai", system: "SYS", prompt: "hi", actorContext: ctx });
    expect(noSessionWarned("generate")).toBe(true);
    expect(_capturedGenerate).toBeDefined(); // model stays usable
  });

  it("stream warns no_session and still calls the adapter", async () => {
    enablePlane();
    await stream({
      provider: "openai",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      actorContext: ctx,
      ...noopStreamCallbacks,
    });
    expect(noSessionWarned("stream")).toBe(true);
    expect(_capturedStream).toBeDefined();
  });

  it("runDeterministicLlmTask warns no_session and still calls the adapter", async () => {
    enablePlane();
    await runDeterministicLlmTask({ provider: "openai", system: "SYS", user: "hi", actorContext: ctx });
    expect(noSessionWarned("runDeterministicLlmTask")).toBe(true);
    expect(_capturedGenerate).toBeDefined();
  });

  it("runSkillAwareDeterministicLlmTask warns no_session and still calls the adapter", async () => {
    enablePlane();
    await runSkillAwareDeterministicLlmTask({ provider: "openai", system: "SYS", user: "hi", actorContext: ctx });
    expect(noSessionWarned("runSkillAwareDeterministicLlmTask")).toBe(true);
    expect(_capturedGenerate).toBeDefined();
  });
});

describe("provider-boundary strip — a caller-smuggled sandbox tool NEVER reaches an adapter (codex round 2)", () => {
  function smuggledTools(): LlmTool[] {
    const carrier = sealExecutionSession(
      { orgId: "o", userId: "u", surface: "chat" },
      { secret: "strip-test-secret" },
    );
    return [{ type: "web_search" }, buildSandboxExecutionTool(carrier)];
  }

  it("generate strips a smuggled sandbox tool with the flag ON", async () => {
    enablePlane();
    await generate({
      provider: "openai",
      system: "SYS",
      prompt: "hi",
      actorContext: ctx,
      executionSession: session,
      tools: smuggledTools(),
    });
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
  });

  it("generate strips a smuggled sandbox tool with the flag OFF (carrier never crosses the boundary)", async () => {
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
    await generate({
      provider: "openai",
      system: "SYS",
      prompt: "hi",
      actorContext: ctx,
      tools: smuggledTools(),
    });
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
  });

  it("stream strips a smuggled sandbox tool with the flag OFF", async () => {
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
    await stream({
      provider: "openai",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      actorContext: ctx,
      tools: smuggledTools(),
      ...noopStreamCallbacks,
    });
    expect(hasSandboxTool(_capturedStream!.tools)).toBe(false);
  });
});

describe("flag OFF (default) — byte-identical, no warning, no session required", () => {
  it("generate is untouched", async () => {
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
    await generate({ provider: "openai", system: "SYS", prompt: "hi", actorContext: ctx, executionSession: session });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(false);
    expect(noWarn()).toBe(true);
  });
});
