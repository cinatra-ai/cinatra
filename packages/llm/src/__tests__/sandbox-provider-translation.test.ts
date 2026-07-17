/**
 * Exec-plane S2 (cinatra#1707) — per-provider adapter CONTRACT tests for the
 * `sandbox_execution` tool, driving the REAL adapters with scripted SDK
 * responses:
 *
 *  OpenAI (both wire forms — the native/fallback distinction exists only here):
 *   - shell-capable model ⇒ the SINGLE native `type:"shell"` entry, bound to
 *     the execution session; skills-on-the-request merge into ITS skill
 *     listing (singular-native-shell rule) — never a second shell;
 *   - skills WITHOUT execution ⇒ the restricted `skill_file_read` NAMED
 *     function tool, NO `type:"shell"` at all (never a privileged shell);
 *   - model-rejects-native (gpt-5) ⇒ BOTH surfaces are named function tools;
 *   - caller-supplied duplicate sandbox tools ⇒ still exactly one surface
 *     (defensive singularity);
 *   - dispatch: `shell_call` → the session-bound sandbox executor;
 *     `function_call` sandbox_execute / skill_file_read → their executors;
 *     legacy `shell_call` with NO sandbox tool falls back to the skill shell.
 *
 *  Anthropic:
 *   - plain function tool with `input_schema`;
 *   - MCP-mode strip survival: with native MCP servers present the shell tool
 *     is stripped but `sandbox_execute` still reaches the request;
 *   - `tool_use` dispatch to the sandbox executor.
 *
 *  Gemini:
 *   - named functionDeclaration; `functionCall` dispatch to the executor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LlmSandboxExecutionTool,
  LlmShellTool,
  LlmTool,
  SandboxExecuteAction,
  SandboxExecuteOutput,
} from "../types";

// ---------------------------------------------------------------------------
// SDK mocks (all three providers) + surface resolver
// ---------------------------------------------------------------------------
const { responsesCreate, responsesStream, anthropicBetaCreate, anthropicCreate, geminiGenerate } =
  vi.hoisted(() => ({
    responsesCreate: vi.fn(),
    responsesStream: vi.fn(),
    anthropicBetaCreate: vi.fn(),
    anthropicCreate: vi.fn(),
    geminiGenerate: vi.fn(),
  }));

vi.mock("openai", () => ({
  default: class {
    responses = { create: responsesCreate, stream: responsesStream };
    constructor(_opts: unknown) {}
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create: anthropicBetaCreate } };
    messages = { create: anthropicCreate };
    constructor(_opts: unknown) {}
  },
}));

vi.mock("@google/genai", async () => {
  const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
  class MockGoogleGenAI {
    models = { generateContent: geminiGenerate };
    constructor(_config: unknown) {}
  }
  return { ...actual, GoogleGenAI: MockGoogleGenAI };
});

const { geminiSurface } = vi.hoisted(() => ({
  geminiSurface: {
    providerId: "gemini",
    getConfiguredAPIKey: async () => "test-key",
    buildRequestHeaders: () => ({}),
    writeLogFile: async () => {},
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "gemini" ? geminiSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "gemini") return geminiSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [geminiSurface]),
}));

vi.mock("../telemetry", () => ({
  writeAnthropicLogFile: vi.fn(async () => {}),
}));

import { createOpenAIProviderAdapter } from "../providers/openai";
import { createAnthropicProviderAdapter } from "../providers/anthropic";
import { createGeminiProviderAdapter } from "../providers/gemini";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSandboxTool(): {
  tool: LlmSandboxExecutionTool;
  calls: SandboxExecuteAction[];
} {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmSandboxExecutionTool = {
    type: "sandbox_execution",
    toolName: "sandbox_execute",
    description: "Execute shell commands in an isolated sandbox.",
    stagedSkills: [
      {
        skillId: "skill-1",
        slug: "my-skill",
        description: "does things",
        resolveFiles: async () => [
          { path: "SKILL.md", content: "# body", digest: "d".repeat(64) },
        ],
      },
    ],
    execute: async (action): Promise<SandboxExecuteOutput[]> => {
      calls.push(action);
      return action.commands.map(() => ({
        stdout: "sandbox-ok",
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

function makeSkillShellTool(): {
  tool: LlmShellTool;
  calls: SandboxExecuteAction[];
} {
  const calls: SandboxExecuteAction[] = [];
  const tool: LlmShellTool = {
    type: "shell",
    skills: [
      { name: "my-skill", description: "does things", path: "/skills/my-skill" },
    ],
    execute: async (action) => {
      calls.push(action as SandboxExecuteAction);
      return action.commands.map(() => ({
        stdout: "reader-ok",
        stderr: "",
        outcome: { type: "exit" as const, exitCode: 0 },
      }));
    },
  };
  return { tool, calls };
}

const FINAL_MESSAGE = {
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  ],
};

function openaiAdapter() {
  return createOpenAIProviderAdapter({ apiKey: "k", defaultModel: "gpt-5.5" });
}

function sentTools(callIndex = 0): Array<Record<string, unknown>> {
  const body = responsesCreate.mock.calls[callIndex][0] as { tools?: Array<Record<string, unknown>> };
  return body.tools ?? [];
}

beforeEach(() => {
  responsesCreate.mockReset();
  responsesStream.mockReset();
  anthropicBetaCreate.mockReset();
  anthropicCreate.mockReset();
  geminiGenerate.mockReset();
});

// ---------------------------------------------------------------------------
// OpenAI — translation
// ---------------------------------------------------------------------------

describe("OpenAI translation — singular-native-shell rule", () => {
  it("execution-authorized on a shell-capable model ⇒ exactly ONE native shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool } = makeSandboxTool();
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [tool] });
    const tools = sentTools();
    const shells = tools.filter((t) => t.type === "shell");
    expect(shells).toHaveLength(1);
    // Staged skills ride the single shell's environment listing.
    const env = shells[0].environment as { type: string; skills: Array<{ path: string }> };
    expect(env.type).toBe("local");
    expect(env.skills.map((s) => s.path)).toEqual(["/skills/my-skill"]);
    // No function-tool fallback forms alongside the native shell.
    expect(tools.some((t) => t.name === "sandbox_execute")).toBe(false);
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(false);
  });

  it("skills + execution ⇒ ONE native shell with the union skill listing — never a second shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: skillShell } = makeSkillShellTool();
    // Give the skill shell a second, distinct skill to prove the union.
    skillShell.skills.push({ name: "other", description: "other skill", path: "/skills/other" });
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [skillShell, sandbox] });
    const tools = sentTools();
    const shells = tools.filter((t) => t.type === "shell");
    expect(shells).toHaveLength(1);
    const env = shells[0].environment as { skills: Array<{ path: string }> };
    expect(env.skills.map((s) => s.path).sort()).toEqual(["/skills/my-skill", "/skills/other"]);
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(false);
  });

  it("skills WITHOUT execution ⇒ restricted skill_file_read function tool, NO shell", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: skillShell } = makeSkillShellTool();
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [skillShell] });
    const tools = sentTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    const reader = tools.find((t) => t.name === "skill_file_read");
    expect(reader).toBeDefined();
    expect(reader!.type).toBe("function");
    expect(String(reader!.description)).toContain("/skills/my-skill");
  });

  it("model-rejects-native (gpt-5) ⇒ BOTH surfaces are named function tools", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: skillShell } = makeSkillShellTool();
    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [skillShell, sandbox],
    });
    const tools = sentTools();
    expect(tools.filter((t) => t.type === "shell")).toHaveLength(0);
    expect(tools.find((t) => t.name === "sandbox_execute")?.type).toBe("function");
    expect(tools.find((t) => t.name === "skill_file_read")?.type).toBe("function");
  });

  it("caller-supplied DUPLICATE sandbox tools ⇒ still exactly one native shell (defensive)", async () => {
    responsesCreate.mockResolvedValue(FINAL_MESSAGE);
    const { tool: a } = makeSandboxTool();
    const { tool: b } = makeSandboxTool();
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [a, b] });
    expect(sentTools().filter((t) => t.type === "shell")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OpenAI — dispatch
// ---------------------------------------------------------------------------

describe("OpenAI dispatch", () => {
  it("shell_call dispatches to the session-bound sandbox executor (not the in-process reader)", async () => {
    const { tool: sandbox, calls: sandboxCalls } = makeSandboxTool();
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "shell_call",
            call_id: "c1",
            action: { commands: ["cat /skills/my-skill/SKILL.md"] },
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);
    const res = await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      tools: [skillShell, sandbox],
      maxSteps: 3,
    });
    expect(res.text).toBe("done");
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
    expect(readerCalls).toHaveLength(0);
    // The shell_call_output that goes back carries the sandbox result.
    const secondBody = responsesCreate.mock.calls[1][0] as { input: Array<Record<string, unknown>> };
    const output = secondBody.input.find((i) => i.type === "shell_call_output") as {
      output: Array<{ stdout: string }>;
    };
    expect(output.output[0].stdout).toBe("sandbox-ok");
  });

  it("legacy shell_call with NO sandbox tool falls back to the skill shell reader", async () => {
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          { type: "shell_call", call_id: "c1", action: { commands: ["cat /skills/my-skill/SKILL.md"] } },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", tools: [skillShell], maxSteps: 3 });
    expect(readerCalls).toHaveLength(1);
  });

  it("function_call sandbox_execute (fallback form) dispatches to the sandbox executor", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "sandbox_execute",
            arguments: JSON.stringify({ commands: ["echo hi"], timeout_ms: 5000 }),
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);
    await openaiAdapter().generate({ system: "SYS", prompt: "hi", model: "gpt-5", tools: [sandbox], maxSteps: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["echo hi"]);
    expect(calls[0].timeoutMs).toBe(5000);
  });

  it("function_call skill_file_read routes to the restricted reader — never the sandbox", async () => {
    const { tool: sandbox, calls: sandboxCalls } = makeSandboxTool();
    const { tool: skillShell, calls: readerCalls } = makeSkillShellTool();
    responsesCreate
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "skill_file_read",
            arguments: JSON.stringify({ command: "cat /skills/my-skill/SKILL.md" }),
          },
        ],
      })
      .mockResolvedValueOnce(FINAL_MESSAGE);
    await openaiAdapter().generate({
      system: "SYS",
      prompt: "hi",
      model: "gpt-5",
      tools: [skillShell, sandbox],
      maxSteps: 3,
    });
    expect(readerCalls).toHaveLength(1);
    expect(readerCalls[0].commands).toEqual(["cat /skills/my-skill/SKILL.md"]);
    expect(sandboxCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const ANTHROPIC_TEXT = {
  content: [{ type: "text", text: "done" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe("Anthropic translation + dispatch", () => {
  it("translates sandbox_execution to a plain function tool with input_schema", async () => {
    anthropicCreate.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool } = makeSandboxTool();
    await createAnthropicProviderAdapter({ apiKey: "k" }).generate({
      system: "SYS",
      prompt: "hi",
      tools: [tool],
    });
    const body = anthropicCreate.mock.calls[0][0] as { tools?: Array<Record<string, unknown>> };
    const def = (body.tools ?? []).find((t) => t.name === "sandbox_execute");
    expect(def).toBeDefined();
    const schema = def!.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual(["commands"]);
  });

  it("survives native MCP-mode tool stripping (shell stripped, sandbox stays)", async () => {
    anthropicBetaCreate.mockResolvedValue(ANTHROPIC_TEXT);
    const { tool: sandbox } = makeSandboxTool();
    const { tool: skillShell } = makeSkillShellTool();
    // Anthropic must never receive a skill-bearing shell tool; use a
    // non-skill shell tool to exercise the strip without the fail-closed guard.
    skillShell.skills = [];
    const mcpTool: LlmTool = {
      type: "mcp",
      serverLabel: "cinatra",
      serverUrl: "http://mcp.invalid/api/mcp",
    };
    await createAnthropicProviderAdapter({ apiKey: "k" }).generate({
      system: "SYS",
      prompt: "hi",
      tools: [mcpTool, skillShell, sandbox],
    });
    const body = anthropicBetaCreate.mock.calls[0][0] as { tools?: Array<Record<string, unknown>> };
    const names = (body.tools ?? []).map((t) => t.name ?? t.type);
    expect(names).toContain("sandbox_execute");
    // The shell tool was stripped on the MCP path (no bash function tool).
    expect(names).not.toContain("bash");
  });

  it("dispatches a sandbox_execute tool_use to the executor", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    anthropicCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "sandbox_execute",
            input: { commands: ["pip install requests"] },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce(ANTHROPIC_TEXT);
    const res = await createAnthropicProviderAdapter({ apiKey: "k" }).generate({
      system: "SYS",
      prompt: "hi",
      tools: [sandbox],
      maxSteps: 3,
    });
    expect(res.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["pip install requests"]);
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe("Gemini translation + dispatch", () => {
  it("translates sandbox_execution to a named function declaration and dispatches functionCall", async () => {
    const { tool: sandbox, calls } = makeSandboxTool();
    geminiGenerate
      .mockResolvedValueOnce({
        text: "",
        functionCalls: [
          { name: "sandbox_execute", args: { commands: ["node -v"] } },
        ],
      })
      .mockResolvedValueOnce({ text: "done", functionCalls: null });
    const res = await createGeminiProviderAdapter("key").generate({
      system: "SYS",
      prompt: "hi",
      tools: [sandbox],
      maxSteps: 3,
    });
    expect(res.text).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].commands).toEqual(["node -v"]);
    const body = geminiGenerate.mock.calls[0][0] as {
      config: { tools?: Array<{ functionDeclarations: Array<{ name: string }> }> };
    };
    const decls = body.config.tools?.[0]?.functionDeclarations ?? [];
    expect(decls.map((d) => d.name)).toContain("sandbox_execute");
  });
});
