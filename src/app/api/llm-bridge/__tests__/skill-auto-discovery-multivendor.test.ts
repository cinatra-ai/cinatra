/**
 * Skill auto-discovery — scope-derived multi-vendor probe (cinatra#1196, slice-1
 * audit final row).
 *
 * The bridge route's SKILL.md auto-discovery previously assumed the single
 * first-party vendor: it probed only `<root>/cinatra-ai/<slug>/…` and stamped
 * the catalog package name `@cinatra-ai/<slug>` off a `/cinatra-ai/` substring
 * test. These tests pin the multi-vendor behavior mirroring the sibling
 * run-mount slice (13bb6b97): the vendor is DERIVED from the on-disk projection
 * (`<mount>/<vendor>/<slug>/…`), first-party stays byte-identical, an operator
 * vendor is derived, malformed/traversal names collapse safely, and an
 * ambiguous same-slug-across-vendors probe fails CLOSED.
 *
 * Fail-closed axes:
 *   - first-party unchanged (`@cinatra-ai/<slug>`, precedence preserved)
 *   - third-party vendor derived (`@<vendor>/<slug>`)
 *   - agent-dir ≠ skill-dir explicit path keeps the vendor (no regression)
 *   - malformed slug / unsafe vendor dir / traversal → no skill (fail closed)
 *   - duplicate vendor (2+ same-slug) → fail closed, first-party never shadowed
 *   - probe-miss → no skill (identical to the legacy single-vendor miss)
 *   - legacy-flat fallback preserved → bare-slug package name
 *
 * Mock topology mirrors path-traversal.test.ts; adds a registerExtensionSkill
 * capture (to assert the derived package name), a deterministic runtime-mount
 * dir, and a readdirSync mock (to inject the projected vendor dirs).
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
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  createLocalSkillShellToolMock: vi.fn(() => ({
    type: "function",
    name: "local_skill_tool",
  })),
  registerExtensionSkillMock: vi.fn(
    async (input: {
      skillMdPath: string;
      packageName: string;
      skillId: string;
    }) => ({ sourcePath: input.skillMdPath }),
  ),
  existsSyncMock: vi.fn((_p: string): boolean => false),
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
  // cinatra#2090 S3: the declared-edge projection the route consults when a
  // co-located bundle probe misses. Null here = "no declared skill edge",
  // which keeps every case in this file on the co-located path.
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
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

const registeredPackageName = () =>
  registerExtensionSkillMock.mock.calls[0]?.[0]?.packageName;

describe("skill auto-discovery — scope-derived multi-vendor (cinatra#1196)", () => {
  it("first-party unchanged: @cinatra-ai/<slug> derived, byte-identical", async () => {
    const fp = skillMd(MOUNT, "cinatra-ai", "foo", "skills", "foo");
    mountVendors(["cinatra-ai"]);
    existOnly([fp]);

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
    expect(registeredPackageName()).toBe("@cinatra-ai/foo");
  });

  it("third-party vendor derived: @acme/<slug> from the on-disk projection", async () => {
    const acme = skillMd(MOUNT, "acme", "foo", "skills", "foo");
    mountVendors(["cinatra-ai", "acme"]);
    existOnly([acme]); // first-party path does NOT exist

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
    expect(registeredPackageName()).toBe("@acme/foo");
  });

  it("first-party precedence: never shadowed by a same-slug third-party vendor", async () => {
    const fp = skillMd(MOUNT, "cinatra-ai", "foo", "skills", "foo");
    const acme = skillMd(MOUNT, "acme", "foo", "skills", "foo");
    mountVendors(["cinatra-ai", "acme"]);
    existOnly([fp, acme]); // both exist — first-party must win

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(registeredPackageName()).toBe("@cinatra-ai/foo");
  });

  it("explicit path with agent-dir ≠ skill-dir keeps the vendor scope (no regression)", async () => {
    // e.g. email-delivery-agent projects skill `email-delivery`.
    const p = skillMd(
      MOUNT,
      "cinatra-ai",
      "email-delivery-agent",
      "skills",
      "email-delivery",
    );
    existOnly([p]);

    const res = await post({ skill_source_path: p });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
    // slug is the SKILL dir; vendor is seg[0] — NOT collapsed to a bare slug.
    expect(registeredPackageName()).toBe("@cinatra-ai/email-delivery");
  });

  it("explicit third-party path with differing dirs derives @vendor/<skill-dir>", async () => {
    const p = skillMd(MOUNT, "acme", "xyz-agent", "skills", "xyz");
    existOnly([p]);

    const res = await post({ skill_source_path: p });
    expect(res.status).toBe(200);
    expect(registeredPackageName()).toBe("@acme/xyz");
  });

  it("duplicate vendor (2+ same-slug) fails CLOSED — no wrong-vendor pick", async () => {
    const acme = skillMd(MOUNT, "acme", "foo", "skills", "foo");
    const beta = skillMd(MOUNT, "beta", "foo", "skills", "foo");
    mountVendors(["acme", "beta"]);
    existOnly([acme, beta]); // ambiguous — no first-party to disambiguate

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("unsafe vendor dir name is ignored (fail closed, not probed)", async () => {
    // A `..`-named dir on disk must never be probed/joined.
    const escaped = skillMd(MOUNT, "..", "foo", "skills", "foo");
    mountVendors([".."]);
    existOnly([escaped]); // even if it "exists", the guard filters the dir

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("malformed slug '.' collapses safely to no skill", async () => {
    // The caller guard only blocks `/ \\ ..`; a lone `.` must still fail closed.
    existsSyncMock.mockReturnValue(true); // everything "exists" — guard must still win
    mountVendors(["cinatra-ai"]);

    const res = await post({ agent_id: "." });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("probe-miss: nothing projected → no skill (identical to legacy miss)", async () => {
    mountVendors(["cinatra-ai", "acme"]);
    // existsSync stays all-false → no candidate resolves.
    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).not.toHaveBeenCalled();
  });

  it("legacy-flat fallback preserved when no vendor projects the slug → bare slug", async () => {
    const flat = skillMd(MOUNT, "foo", "skills", "foo"); // <mount>/foo/skills/foo/SKILL.md
    mountVendors([]); // no vendor dirs
    existOnly([flat]);

    const res = await post({ agent_id: "foo" });
    expect(res.status).toBe(200);
    expect(createLocalSkillShellToolMock).toHaveBeenCalledTimes(1);
    // Flat layout has no vendor scope → bare slug (unchanged from legacy).
    expect(registeredPackageName()).toBe("foo");
  });
});
