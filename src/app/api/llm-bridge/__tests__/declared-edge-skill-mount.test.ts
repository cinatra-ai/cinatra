/**
 * Declared-edge skill mount — the dependency → injection projection
 * (cinatra#2090 S3, epic #2086).
 *
 * The separation rule moves a genuine knowledge bundle OUT of the producing
 * extension into its own `kind:"skill"` package, reached by a declared
 * `cinatra.dependencies` edge. The bridge's co-located probe cannot see that
 * bundle (it lives under the PROVIDER's directory), so the route consults the
 * projection on a probe MISS and mounts what it resolves.
 *
 * What these pin:
 *   - a declared edge is consulted ONLY after the co-located probe misses (an
 *     extension that still ships its own bundle is byte-identical to before);
 *   - the mounted bundle registers under the PROVIDER's catalog id, never the
 *     `@vendor/<bundle-dir>` name the path-shape derivation would invent;
 *   - the shell tool is built from the provider's bundle path;
 *   - a null projection (nothing declared / provider absent / ambiguous) leaves
 *     the run with no skill tool — the same degradation as a probe miss;
 *   - an EXPLICIT skill_source_path never consults the projection.
 *
 * Mock topology is the multi-vendor suite's, plus a controllable projection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

// Fixed, absolute runtime-mount root — deliberately OUTSIDE cwd so the derived
// package name can never be contaminated by the repo living under a
// `cinatra-ai/` folder (the exact latent bug the substring test had).
const MOUNT = path.join(path.sep, "test-agent-mount");

const skillMd = (root: string, ...segs: string[]) =>
  path.join(root, ...segs, "SKILL.md");

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  createLocalSkillShellToolMock,
  registerExtensionSkillMock,
  existsSyncMock,
  readdirSyncMock,
  resolveDeclaredSkillEdgeMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  // Typed input (unlike the sibling multi-vendor suite's bare stub) so the
  // MOUNTED bundle path is assertable — that path is the whole point here.
  createLocalSkillShellToolMock: vi.fn(
    (_input: { mountedSkills?: Array<{ sourcePath?: string }> }) => ({
      type: "function",
      name: "local_skill_tool",
    }),
  ),
  registerExtensionSkillMock: vi.fn(
    async (input: {
      skillMdPath: string;
      packageName: string;
      skillId: string;
    }) => ({ sourcePath: input.skillMdPath }),
  ),
  existsSyncMock: vi.fn((_p: string): boolean => false),
  resolveDeclaredSkillEdgeMock: vi.fn(
    async (
      _dir: string,
    ): Promise<{
      packageName: string;
      slug: string;
      skillId: string;
      sourcePath: string;
    } | null> => null,
  ),
  readdirSyncMock: vi.fn(
    (_dir: string): Array<{ name: string; isDirectory: () => boolean }> => [],
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask:
    runResolvedSkillAwareDeterministicLlmTaskMock,
  createLocalSkillShellTool: createLocalSkillShellToolMock,
  openAiModelSupportsShell: (modelId: string) =>
    modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  resolveConfiguredLlmRuntime: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  getLlmMcpCredentials: vi.fn(() => null),
  resolveProviderAdapter: vi.fn(async () => ({})),
  PreferredProviderUnavailableError: class extends Error {},
}));

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: vi.fn(),
  clearRunContext: vi.fn(),
}));

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({ ok: false })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  resolveDeclaredSkillEdgeForExtensionDir: resolveDeclaredSkillEdgeMock,
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
  registerExtensionSkill: registerExtensionSkillMock,
  // A3 (cinatra#1363): the explicit-path lifecycle gate reads the catalog. Empty
  // ⇒ these vendor SKILL.md temp paths are not custom skills ⇒ derived ⇒
  // deliverable, so multi-vendor package derivation is exercised unchanged.
  readSkillsCatalog: vi.fn(async () => ({ skills: [] })),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

// Deterministic runtime mount so the derived vendor is exact.
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => MOUNT,
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    canProviderSatisfyCapability: () => true,
    describeCapabilityRequirement: () => "requirement",
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
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-6"],
      gemini: ["gemini-2.5-flash"],
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  };
});

const TEST_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
const dirent = (name: string) => ({ name, isDirectory: () => true });

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = TEST_TOKEN;
  existsSyncMock.mockReturnValue(false);
  readdirSyncMock.mockReturnValue([]);
  resolveDeclaredSkillEdgeMock.mockResolvedValue(null);
  const mod = await import("../route");
  POST = mod.POST;
});

/** Make ONLY the listed absolute paths report as existing. */
function existOnly(paths: string[]) {
  const set = new Set(paths);
  existsSyncMock.mockImplementation((p: string) => set.has(p));
}

/** Return the given vendor dir names when `readdirSync(MOUNT)` is called. */
function mountVendors(names: string[]) {
  readdirSyncMock.mockImplementation((dir: string) =>
    dir === MOUNT ? names.map(dirent) : [],
  );
}

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": TEST_TOKEN,
      },
      body: JSON.stringify({ user: "u", system: "s", ...body }),
    }),
  );


const PROVIDER_BUNDLE = skillMd(
  MOUNT,
  "cinatra-ai",
  "web-research-skill",
  "skills",
  "web-research",
);
const PROVIDER_EDGE = {
  packageName: "@cinatra-ai/web-research-skill",
  slug: "web-research",
  skillId: "@cinatra-ai/web-research-skill:web-research",
  sourcePath: PROVIDER_BUNDLE,
};

const registeredCall = () => registerExtensionSkillMock.mock.calls[0]?.[0];

describe("declared-edge skill mount (cinatra#2090 S3)", () => {
  it("mounts the declared provider's bundle when the agent ships none", async () => {
    // The agent's own co-located probe misses; the provider's bundle exists.
    mountVendors(["cinatra-ai"]);
    existOnly([PROVIDER_BUNDLE]);
    resolveDeclaredSkillEdgeMock.mockResolvedValue(PROVIDER_EDGE);

    const res = await post({ agent_id: "web-research-agent" });
    expect(res.status).toBe(200);
    expect(resolveDeclaredSkillEdgeMock).toHaveBeenCalledWith("web-research-agent");
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
    expect(createLocalSkillShellToolMock.mock.calls[0]?.[0]?.mountedSkills?.[0]?.sourcePath).toBe(
      PROVIDER_BUNDLE,
    );
  });

  it("registers under the PROVIDER's catalog id, not a path-derived name", async () => {
    mountVendors(["cinatra-ai"]);
    existOnly([PROVIDER_BUNDLE]);
    resolveDeclaredSkillEdgeMock.mockResolvedValue(PROVIDER_EDGE);

    await post({ agent_id: "web-research-agent" });
    // The path-shape derivation would have produced @cinatra-ai/web-research
    // (vendor + BUNDLE dir) and a divergent second catalog row for the same
    // bytes. The declared edge carries the real package identity instead.
    expect(registeredCall()?.packageName).toBe("@cinatra-ai/web-research-skill");
    expect(registeredCall()?.skillId).toBe("@cinatra-ai/web-research-skill:web-research");
  });

  it("is NOT consulted when the agent still ships a co-located bundle", async () => {
    const own = skillMd(MOUNT, "cinatra-ai", "foo", "skills", "foo");
    mountVendors(["cinatra-ai"]);
    existOnly([own]);

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(resolveDeclaredSkillEdgeMock).not.toHaveBeenCalled();
    expect(registeredCall()?.packageName).toBe("@cinatra-ai/foo");
  });

  it("is NOT consulted for an EXPLICIT skill_source_path", async () => {
    const p = skillMd(MOUNT, "cinatra-ai", "email-delivery-agent", "skills", "email-delivery");
    existOnly([p]);

    const res = await post({ skill_source_path: p });
    expect(res.status).toBe(200);
    expect(resolveDeclaredSkillEdgeMock).not.toHaveBeenCalled();
  });

  it("degrades to NO skill tool when nothing is declared (null projection)", async () => {
    mountVendors(["cinatra-ai"]);
    // Neither a co-located bundle nor a declared edge.
    const res = await post({ agent_id: "web-research-agent" });
    expect(res.status).toBe(200);
    expect(resolveDeclaredSkillEdgeMock).toHaveBeenCalledTimes(1);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("still refuses a resolved bundle that escapes the allowed skill roots", async () => {
    const outside = skillMd(path.join(path.sep, "elsewhere"), "cinatra-ai", "x", "skills", "x");
    existOnly([outside]);
    resolveDeclaredSkillEdgeMock.mockResolvedValue({ ...PROVIDER_EDGE, sourcePath: outside });

    const res = await post({ agent_id: "web-research-agent" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("a malformed agent_id never reaches the projection", async () => {
    const res = await post({ agent_id: "../../etc" });
    expect(res.status).toBe(200);
    expect(resolveDeclaredSkillEdgeMock).not.toHaveBeenCalled();
  });
});
