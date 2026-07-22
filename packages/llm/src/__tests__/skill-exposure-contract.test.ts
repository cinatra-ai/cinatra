/**
 * S10 efficacy loop — skill-ID-bearing exposure contract per delivery mode
 * (cinatra#1368).
 *
 * Proves each delivery adapter reports which skills it EXPOSED, tagged with the
 * delivery mode + invocation-attributability, and that the OpenAI shell tool
 * attributes a skill READ to its catalog id (the only attributable per-skill
 * invocation signal). Non-attributable modes (Gemini inline, Anthropic
 * container) report exposure with invocationAttributable=false.
 *
 * Mock harness mirrors skill-delivery.test.ts so the OpenAI delegate exercises
 * the real buildSkillTools path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { installedGetMock, existsSyncMock } = vi.hoisted(() => ({
  installedGetMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: installedGetMock },
  }),
}));

vi.mock("@cinatra-ai/skills", () => ({
  // Returns a non-empty body so a shell read succeeds and fires onSkillRead.
  readSkillFileContent: async () => "SKILL BODY",
}));

const { openaiShellSurface } = vi.hoisted(() => ({
  openaiShellSurface: {
    providerId: "openai",
    shellTools: {
      readSettings: () => null,
      runCommandInDocker: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  // llm-providers S4.x (cinatra#1964): selectSkillDeliveryAdapter resolves
  // through this seam first; absent -> in-core fallback (unchanged routing).
  getLlmSkillDeliveryAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "openai" ? openaiShellSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "openai") return openaiShellSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [openaiShellSurface]),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

import { selectSkillDeliveryAdapter } from "../tools/skill-delivery";
import { createLocalSkillShellTool } from "../tools/skills";
import {
  setAnthropicSkillSyncMap,
  resetAnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "../tools/anthropic-skill-sync-map";
import type { LlmShellTool } from "../types";

beforeEach(() => {
  installedGetMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
});

afterEach(() => {
  resetAnthropicSkillSyncMap();
});

describe("OpenAiShellSkillDelivery — exposure", () => {
  it("exposes each MOUNTED skill as openai_shell + attributable", async () => {
    installedGetMock.mockResolvedValue({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "test skill",
      sourcePath: "/abs/path/to/SKILL.md",
    });
    const result = await selectSkillDeliveryAdapter("openai").deliver({
      skillIds: ["@x/y:z"],
    });
    expect(result.exposure).toEqual([
      { skillId: "@x/y:z", deliveryMode: "openai_shell", invocationAttributable: true },
    ]);
  });

  it("does NOT expose a requested skill with no on-disk sourcePath (unmountable)", async () => {
    installedGetMock.mockResolvedValue({
      id: "@x/y:nopath",
      name: "nopath",
      slug: "nopath",
      description: "no source path",
      // no sourcePath ⇒ no directoryPath ⇒ not mounted ⇒ not exposed
    });
    const result = await selectSkillDeliveryAdapter("openai").deliver({
      skillIds: ["@x/y:nopath"],
    });
    expect(result.exposure).toEqual([]);
  });

  it("empty skillIds ⇒ no exposure", async () => {
    const result = await selectSkillDeliveryAdapter("openai").deliver({ skillIds: [] });
    expect(result.exposure).toEqual([]);
  });
});

describe("GeminiInlineSkillDelivery — exposure", () => {
  it("exposes only content-bearing skills as gemini_inline + non-attributable", async () => {
    installedGetMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "@a:1"
          ? { id, name: "1", slug: "1", description: "", body: "BODY-ONE" }
          : { id, name: "2", slug: "2", description: "", body: "" },
      ),
    );
    const result = await selectSkillDeliveryAdapter("gemini").deliver({
      skillIds: ["@a:1", "@b:2"],
    });
    // Only @a:1 had a body — @b:2 (empty) is neither inlined nor exposed.
    expect(result.exposure).toEqual([
      { skillId: "@a:1", deliveryMode: "gemini_inline", invocationAttributable: false },
    ]);
    // Byte-identical system context preserved.
    expect(result.systemContext).toBe("\n\nSkill instructions:\nBODY-ONE");
  });
});

describe("AnthropicContainerSkillDelivery — exposure", () => {
  it("exposes the SELECTED skills as anthropic_container + non-attributable", async () => {
    installedGetMock.mockImplementation((id: string) =>
      Promise.resolve({ id, name: id, slug: id, description: `desc ${id}` }),
    );
    setAnthropicSkillSyncMap({
      resolve: async (catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null> =>
        ({
          "@a:one": { skillId: "skill_111", version: "v1", catalogSkillId: "@a:one" },
          "@b:two": { skillId: "skill_222", version: "v2", catalogSkillId: "@b:two" },
        })[catalogSkillId] ?? null,
    });
    const result = await selectSkillDeliveryAdapter("anthropic").deliver({
      skillIds: ["@a:one", "@b:two"],
    });
    expect(result.exposure).toEqual([
      { skillId: "@a:one", deliveryMode: "anthropic_container", invocationAttributable: false },
      { skillId: "@b:two", deliveryMode: "anthropic_container", invocationAttributable: false },
    ]);
  });

  it("empty skillIds ⇒ no exposure", async () => {
    const result = await selectSkillDeliveryAdapter("anthropic").deliver({ skillIds: [] });
    expect(result.exposure).toEqual([]);
  });
});

describe("OpenAI shell tool — invocation attribution", () => {
  it("fires onSkillRead with the catalog id when the model reads the skill file", async () => {
    const reads: string[] = [];
    const tool: LlmShellTool = createLocalSkillShellTool({
      mountedSkills: [
        {
          id: "@x/y:z",
          name: "z",
          slug: "myslug",
          description: "test",
          sourcePath: "/abs/dir/SKILL.md",
          directoryPath: "/abs/dir",
        },
      ],
      onSkillRead: (id) => reads.push(id),
    });
    const results = await tool.execute!({
      commands: ["cat /skills/myslug/SKILL.md"],
    });
    expect(results[0]?.outcome).toEqual({ type: "exit", exitCode: 0 });
    expect(reads).toEqual(["@x/y:z"]);
  });

  it("does not fire onSkillRead for an unsupported command", async () => {
    const reads: string[] = [];
    const tool: LlmShellTool = createLocalSkillShellTool({
      mountedSkills: [
        {
          id: "@x/y:z",
          name: "z",
          slug: "myslug",
          description: "test",
          sourcePath: "/abs/dir/SKILL.md",
          directoryPath: "/abs/dir",
        },
      ],
      onSkillRead: (id) => reads.push(id),
    });
    const results = await tool.execute!({ commands: ["ls /skills/myslug"] });
    expect(results[0]?.outcome).toEqual({ type: "exit", exitCode: 1 });
    expect(reads).toEqual([]);
  });
});
