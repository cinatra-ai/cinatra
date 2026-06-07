/**
 * Soft-fallback behavior for buildSkillTools.
 *
 * buildSkillTools must avoid failing production paths when any assigned skill
 * is not deliverable. Assigned skill ids can include GitHub-hosted or
 * user-scoped skills that resolve null under the model actor's visibility
 * filter, even though they have a sourcePath in the DB. The fallback rules are:
 *
 *   1. No skillIds (or empty) -> [] (no skill tool needed).
 *   2. All skillIds resolve with sourcePath -> shell tool.
 *   3. Some skillIds resolve, some don't -> shell tool emitted with
 *      mountable subset; dropped IDs logged as warnings.
 *   4. No skillIds resolve with sourcePath -> fall back to read_skill.
 *   5. Resolved skill's sourcePath file missing on disk -> still throws
 *      "Skill file missing at <path>" (this is a real on-disk corruption,
 *      not a visibility-filter ghost).
 *
 * The shell-only owner-mandate for chat is enforced upstream by
 * `ensureChatSkillRegistered` (and the widget self-heals); they guarantee
 * the chat/widget skills resolve with sourcePath, so the read_skill
 * fallback never fires for those paths in production.
 *
 * Mocks the deterministic skills client and node:fs.existsSync.
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

vi.mock("@cinatra-ai/openai-connector", () => ({
  readOpenAIShellSettings: async () => null,
  runOpenAIShellCommandInDocker: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

import { buildSkillTools } from "../tools/skills";

beforeEach(() => {
  installedGetMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
});

describe("buildSkillTools soft-fallback", () => {
  it("returns [] when no skillIds are passed", async () => {
    const tools = await buildSkillTools({});
    expect(tools).toEqual([]);
    expect(installedGetMock).not.toHaveBeenCalled();
  });

  it("returns [] when skillIds is an empty array", async () => {
    const tools = await buildSkillTools({ skillIds: [] });
    expect(tools).toEqual([]);
    expect(installedGetMock).not.toHaveBeenCalled();
  });

  it("returns shell tool when single skill resolves with sourcePath", async () => {
    installedGetMock.mockResolvedValueOnce({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "test skill",
      sourcePath: "/abs/path/to/SKILL.md",
    });
    const tools = await buildSkillTools({ skillIds: ["@x/y:z"] });
    expect(tools).toHaveLength(1);
    expect((tools[0] as { type: string }).type).toBe("shell");
  });

  it("returns [] with a warning when single skill resolves WITHOUT sourcePath", async () => {
    // The `read_skill` function-tool fallback was retired. Skills
    // without a sourcePath no longer get an inline tool; the LLM call
    // proceeds without skill delivery and the warning lets operators see
    // the missing registration.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installedGetMock.mockResolvedValueOnce({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "no sourcePath",
      // sourcePath intentionally undefined
    });
    const tools = await buildSkillTools({ skillIds: ["@x/y:z"] });
    expect(tools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no mountable skills resolved/),
    );
    warnSpy.mockRestore();
  });

  it("returns [] with a warning when skill not in catalog", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installedGetMock.mockResolvedValueOnce(null);
    const tools = await buildSkillTools({ skillIds: ["@x/y:z"] });
    expect(tools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no mountable skills resolved/),
    );
    warnSpy.mockRestore();
  });

  it("emits shell tool for the good skill and warns about the broken one in a mixed call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = (id: string) => {
      if (id === "@ok/a:good") {
        return {
          id: "@ok/a:good",
          name: "good",
          slug: "good",
          description: "ok",
          sourcePath: "/abs/path/to/good/SKILL.md",
        };
      }
      return null;
    };
    installedGetMock.mockImplementation((id: string) => Promise.resolve(lookup(id)));

    const tools = await buildSkillTools({ skillIds: ["@ok/a:good", "@bad/b:broken"] });
    expect(tools).toHaveLength(1);
    expect((tools[0] as { type: string }).type).toBe("shell");
    // The dropped skill is logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/dropped.*@bad\/b:broken/),
    );
    warnSpy.mockRestore();
  });

  it("THROWS when a resolved skill's sourcePath file is missing on disk", async () => {
    installedGetMock.mockResolvedValueOnce({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "test skill",
      sourcePath: "/abs/path/to/MISSING_SKILL.md",
    });
    existsSyncMock.mockReturnValueOnce(false);
    await expect(buildSkillTools({ skillIds: ["@x/y:z"] })).rejects.toThrow(
      /Skill file missing at \/abs\/path\/to\/MISSING_SKILL.md/,
    );
  });

  it("returns [] with a warning when ALL skills are unresolvable", async () => {
    // The `read_skill` function-tool fallback was retired; the
    // unresolvable case now returns no inline skill tool + a warning.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installedGetMock.mockImplementation(() => Promise.resolve(null));

    const tools = await buildSkillTools({ skillIds: ["@a/x:missing", "@b/y:also-missing"] });
    expect(tools).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no mountable skills resolved/),
    );
    warnSpy.mockRestore();
  });
});
