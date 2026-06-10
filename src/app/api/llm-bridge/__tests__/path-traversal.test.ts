// @ts-nocheck
/**
 * Path traversal containment tests.
 *
 * Regression test for the substring-prefix bypass in
 * src/app/api/llm-bridge/route.ts. A sibling directory whose name starts with
 * the cwd prefix must not pass the skill_source_path containment gate; the
 * canonical example is `${cwd}-evil/SKILL.md`.
 *
 *   cwd                 = /Users/x/Code/cinatra
 *   skill_source_path   = /Users/x/Code/cinatra-evil/SKILL.md
 *   resolvedPath        = /Users/x/Code/cinatra-evil/SKILL.md
 *   resolvedPath.startsWith(cwd) === true   ← the bug
 *
 * Correct containment uses `path.relative(cwd, resolvedPath)`: the relative
 * path must NOT start with `..` and must NOT be absolute, and the empty string
 * (candidate equals cwd exactly) is treated as inside.
 *
 * Three cases:
 *   A. Prefix attack `${cwd}-evil/SKILL.md` is REJECTED (no shell tool created).
 *   B. Legitimate path under cwd is ACCEPTED (shell tool created).
 *   C. Relative-escape `../../etc/SKILL.md` is REJECTED.
 *
 * Mock topology mirrors personal-skill-resolution.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  createLocalSkillShellToolMock,
  setRunContextMock,
  clearRunContextMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  existsSyncMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  createLocalSkillShellToolMock: vi.fn(() => ({
    type: "function",
    name: "local_skill_tool",
  })),
  setRunContextMock: vi.fn(),
  clearRunContextMock: vi.fn(),
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  getLlmMcpCredentialsMock: vi.fn(() => null),
  existsSyncMock: vi.fn(() => true),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask:
    runResolvedSkillAwareDeterministicLlmTaskMock,
  createLocalSkillShellTool: createLocalSkillShellToolMock,
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  // Bridge route imports this for cinatra_llm dispatch.
  resolveProviderAdapter: vi.fn(async () => ({})),
  PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
    requestedProvider: string;
    reason: string;
    constructor(requestedProvider: string, reason: string) {
      super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
      this.requestedProvider = requestedProvider;
      this.reason = reason;
    }
  },
}));

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
}));

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({ ok: false })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

// Route imports OasCinatraLlmSchema + ALLOWED_MODEL_IDS.
// Stub the schema via real zod; avoid vi.importActual because @cinatra-ai/agents
// barrel pulls heavy transitive deps (mcp-server, etc.) that don't load in the
// root vitest sandbox.
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z
          .enum(["media_input", "function_tools", "native_mcp"])
          .optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai", "anthropic", "gemini"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
      anthropic: [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "claude-3-7-sonnet-latest",
        "claude-3-5-haiku-latest",
      ],
      gemini: [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-1.5-pro",
      ],
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: existsSyncMock };
});

const TEST_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";

let POST;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = TEST_TOKEN;
  existsSyncMock.mockReturnValue(true);
  const mod = await import("../route");
  POST = mod.POST;
});

describe("path traversal containment", () => {
  it("Case A: prefix-attack path ${cwd}-evil/SKILL.md is REJECTED (no shell tool created)", async () => {
    const evilPath = `${process.cwd()}-evil/SKILL.md`;
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": TEST_TOKEN,
      },
      body: JSON.stringify({
        user: "test",
        system: "sys",
        skill_source_path: evilPath,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("Case B: legitimate path under cwd is ACCEPTED (shell tool created)", async () => {
    const legitPath = path.join(
      process.cwd(),
      "agents",
      "foo",
      "skills",
      "foo",
      "SKILL.md",
    );
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": TEST_TOKEN,
      },
      body: JSON.stringify({
        user: "test",
        system: "sys",
        skill_source_path: legitPath,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
  });

  it("Case C: relative-escape path ../../etc/SKILL.md is REJECTED", async () => {
    const escapePath = "../../etc/SKILL.md";
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": TEST_TOKEN,
      },
      body: JSON.stringify({
        user: "test",
        system: "sys",
        skill_source_path: escapePath,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Slug guard for body.agent_id (defense-in-depth).
  // The skill auto-discovery path that derives from agent_id must reject
  // slugs containing path separators / "..", so a malicious agent_id never
  // reaches the path.relative containment check below.
  // -------------------------------------------------------------------------

  const buildAgentIdReq = (agentId: string) =>
    new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": TEST_TOKEN,
      },
      body: JSON.stringify({
        user: "test",
        system: "sys",
        agent_id: agentId,
      }),
    });

  it("agent_id with '..' is rejected by slug guard (no shell tool)", async () => {
    const res = await POST(buildAgentIdReq("../../etc"));
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("agent_id with '/' is rejected by slug guard", async () => {
    const res = await POST(buildAgentIdReq("with/slash"));
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("agent_id with '\\' is rejected by slug guard", async () => {
    const res = await POST(buildAgentIdReq("with\\backslash"));
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("clean agent_id passes the slug guard (auto-discovery proceeds)", async () => {
    existsSyncMock.mockReturnValue(true);
    const res = await POST(buildAgentIdReq("valid-agent"));
    expect(res.status).toBe(200);
    // valid agent_id resolves under cwd → containment check passes → shell tool created.
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
  });
});
