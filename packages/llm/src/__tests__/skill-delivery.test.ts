/**
 * SkillDeliveryAdapter behavior equivalence.
 *
 * Proves the selected adapter preserves provider-specific delivery behavior:
 *  - OpenAiShellSkillDelivery returns exactly what buildSkillTools returns,
 *    with NO system context because OpenAI receives skills as shell tools.
 *  - GeminiInlineSkillDelivery produces the exact
 *    "\n\nSkill instructions:\n...\n\n---\n\n..." string and NO tools.
 *  - selectSkillDeliveryAdapter routes per provider.
 *
 * Mocks the deterministic skills client + node:fs.existsSync, matching
 * skills-build.test.ts so the OpenAI delegate exercises the real
 * buildSkillTools code path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  readSkillFileContent: async () => "",
}));

// The openai `llm-provider-surface` GATED shellTools member (cinatra#151
// Stage 2): the settings reader + docker executor resolve via the capability.
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

import {
  selectSkillDeliveryAdapter,
  OpenAiShellSkillDelivery,
  GeminiInlineSkillDelivery,
  AnthropicContainerSkillDelivery,
} from "../tools/skill-delivery";
import { buildSkillTools } from "../tools/skills";

beforeEach(() => {
  installedGetMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
});

describe("selectSkillDeliveryAdapter — provider routing", () => {
  it("routes openai → OpenAiShellSkillDelivery", () => {
    expect(selectSkillDeliveryAdapter("openai")).toBeInstanceOf(OpenAiShellSkillDelivery);
  });
  it("routes gemini → GeminiInlineSkillDelivery", () => {
    expect(selectSkillDeliveryAdapter("gemini")).toBeInstanceOf(GeminiInlineSkillDelivery);
  });
  it("routes anthropic → AnthropicContainerSkillDelivery", () => {
    expect(selectSkillDeliveryAdapter("anthropic")).toBeInstanceOf(
      AnthropicContainerSkillDelivery,
    );
  });
});

describe("OpenAiShellSkillDelivery — tool delivery behavior", () => {
  it("returns exactly buildSkillTools output and empty systemContext", async () => {
    installedGetMock.mockResolvedValue({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "test skill",
      sourcePath: "/abs/path/to/SKILL.md",
    });

    const fromBuilder = await buildSkillTools({ skillIds: ["@x/y:z"] });
    const result = await selectSkillDeliveryAdapter("openai").deliver({
      skillIds: ["@x/y:z"],
    });

    expect(result.systemContext).toBe("");
    expect(result.tools).toHaveLength(fromBuilder.length);
    expect((result.tools[0] as { type: string }).type).toBe("shell");
    expect((result.tools[0] as { type: string }).type).toBe(
      (fromBuilder[0] as { type: string }).type,
    );
  });

  it("empty skillIds → no tools, no context", async () => {
    const result = await selectSkillDeliveryAdapter("openai").deliver({ skillIds: [] });
    expect(result.tools).toEqual([]);
    expect(result.systemContext).toBe("");
  });
});

describe("GeminiInlineSkillDelivery — inline context behavior", () => {
  it("inlines bodies into the exact system-prompt string, no tools", async () => {
    installedGetMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "@a:1"
          ? { id, name: "1", slug: "1", description: "", body: "BODY-ONE" }
          : { id, name: "2", slug: "2", description: "", body: "BODY-TWO" },
      ),
    );

    const result = await selectSkillDeliveryAdapter("gemini").deliver({
      skillIds: ["@a:1", "@b:2"],
    });

    expect(result.tools).toEqual([]);
    expect(result.systemContext).toBe(
      "\n\nSkill instructions:\nBODY-ONE\n\n---\n\nBODY-TWO",
    );
  });

  it("no valid bodies → empty systemContext", async () => {
    installedGetMock.mockResolvedValue(null);
    const result = await selectSkillDeliveryAdapter("gemini").deliver({
      skillIds: ["@a:1"],
    });
    expect(result.tools).toEqual([]);
    expect(result.systemContext).toBe("");
  });
});
