/**
 * Execution-plane INJECTION COVERAGE across all four orchestration entry points
 * (exec-plane S1 #1706 AC5; S2 #1707 delivery).
 *
 * Proves the single injection site runs in `generate`, `stream`,
 * `runDeterministicLlmTask`, and `runSkillAwareDeterministicLlmTask`, and that
 * the S2 posture holds in every one of them:
 *  - flag ON + session + EXECUTOR ⇒ the sandbox tool AND its centrally-composed
 *    cue reach the adapter together (tool/cue cannot diverge), with a
 *    tool-aware step budget on the non-streaming arms;
 *  - flag ON + session but NO executor binding ⇒ `capability_unavailable`
 *    warning, tools stripped, model stays usable (fail-closed);
 *  - a flag-ON call with NO attributable session fails closed with a structured
 *    `no_session` warning while the model stays usable (fail-closed per entry
 *    point);
 *  - a caller-smuggled sandbox tool NEVER reaches an adapter on any
 *    non-injected path;
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
import type { LlmTool, SandboxExecutor } from "../../types";

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

/** Recording fake executor (S2) — the broker binding the app wiring supplies. */
function makeExecutor(): SandboxExecutor {
  return async (input) =>
    input.commands.map(() => ({
      stdout: "ok",
      stderr: "",
      outcome: { type: "exit" as const, exitCode: 0 },
    }));
}
function unavailableWarned(entryPoint: string) {
  return warnSpy.mock.calls.some(
    (c) =>
      String(c[0]).includes(`[execution-plane] ${entryPoint}`) &&
      String(c[0]).includes("capability_unavailable"),
  );
}

describe("flag ON + session + EXECUTOR — tool + cue delivered together (S2)", () => {
  it("generate: sandbox tool AND cue reach the adapter; tool-aware budget", async () => {
    enablePlane();
    await generate({
      provider: "openai",
      system: "SYS",
      prompt: "hi",
      actorContext: ctx,
      executionSession: session,
      executionExecutor: makeExecutor(),
    });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(true);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(true);
    // ≥1 post-tool step guaranteed on the non-streaming arm.
    expect(_capturedGenerate!.maxSteps).toBeGreaterThanOrEqual(2);
    expect(noWarn()).toBe(true);
  });

  it("stream: sandbox tool AND cue reach the adapter", async () => {
    enablePlane();
    await stream({
      provider: "openai",
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
      actorContext: ctx,
      executionSession: session,
      executionExecutor: makeExecutor(),
      ...noopStreamCallbacks,
    });
    expect(_capturedStream).toBeDefined();
    expect(hasSandboxTool(_capturedStream!.tools)).toBe(true);
    expect(cueLeaked(_capturedStream!.system)).toBe(true);
    expect(noWarn()).toBe(true);
  });

  it("runDeterministicLlmTask: sandbox tool AND cue reach the adapter; budget widened", async () => {
    enablePlane();
    await runDeterministicLlmTask({
      provider: "openai",
      system: "SYS",
      user: "hi",
      actorContext: ctx,
      executionSession: { ...session, surface: "deterministic_task" },
      executionExecutor: makeExecutor(),
    });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(true);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(true);
    expect(_capturedGenerate!.maxSteps).toBeGreaterThanOrEqual(2);
    expect(noWarn()).toBe(true);
  });

  it("runSkillAwareDeterministicLlmTask: sandbox tool AND cue reach the adapter", async () => {
    enablePlane();
    await runSkillAwareDeterministicLlmTask({
      provider: "openai",
      system: "SYS",
      user: "hi",
      actorContext: ctx,
      executionSession: { ...session, surface: "skill_task" },
      executionExecutor: makeExecutor(),
    });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(true);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(true);
    expect(_capturedGenerate!.maxSteps).toBeGreaterThanOrEqual(2);
    expect(noWarn()).toBe(true);
  });

  it("the sandbox tool that reaches the adapter carries NO sessionCarrier field", async () => {
    enablePlane();
    await generate({
      provider: "openai",
      system: "SYS",
      prompt: "hi",
      actorContext: ctx,
      executionSession: session,
      executionExecutor: makeExecutor(),
    });
    const sandbox = (_capturedGenerate!.tools ?? []).find(
      (t) => "type" in t && (t as { type?: string }).type === "sandbox_execution",
    );
    expect(sandbox).toBeDefined();
    expect(sandbox).not.toHaveProperty("sessionCarrier");
    expect(JSON.stringify(sandbox)).not.toContain("org-1");
  });
});

describe("flag ON + session, NO executor binding — fail-closed, model usable (S2)", () => {
  it("generate warns capability_unavailable; no tool, no cue reaches the adapter", async () => {
    enablePlane();
    await generate({ provider: "openai", system: "SYS", prompt: "hi", actorContext: ctx, executionSession: session });
    expect(_capturedGenerate).toBeDefined();
    expect(hasSandboxTool(_capturedGenerate!.tools)).toBe(false);
    expect(cueLeaked(_capturedGenerate!.system)).toBe(false);
    expect(unavailableWarned("generate")).toBe(true);
  });

  it("stream warns capability_unavailable; no tool, no cue reaches the adapter", async () => {
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
    expect(unavailableWarned("stream")).toBe(true);
  });

  it("runDeterministicLlmTask warns capability_unavailable; stays stripped", async () => {
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
    expect(unavailableWarned("runDeterministicLlmTask")).toBe(true);
  });

  it("runSkillAwareDeterministicLlmTask warns capability_unavailable; stays stripped", async () => {
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
    expect(unavailableWarned("runSkillAwareDeterministicLlmTask")).toBe(true);
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
    return [
      { type: "web_search" },
      buildSandboxExecutionTool({ sessionCarrier: carrier, executor: makeExecutor() }),
    ];
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
