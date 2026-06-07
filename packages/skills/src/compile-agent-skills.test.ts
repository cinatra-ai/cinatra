/**
 * Coverage for agent-level skill compilation helpers.
 *
 * `compileAndRegisterAgentSkillsForRepo` auto-registers agent-level skills
 * at setup and install time. The suite verifies successful registration and
 * defensive skip behavior without loading the real database chain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));

const { upsertSkillMock } = vi.hoisted(() => ({
  upsertSkillMock: vi.fn(async (input: { skillId?: string; content?: string }) => ({
    id: input.skillId ?? "stub-id",
    content: input.content ?? "",
  })),
}));

vi.mock("./skills-store", () => ({
  upsertSkill: upsertSkillMock,
  // resolves cleanly under vitest without pulling in the real DB chain.
  readSkillsStorageConfig: vi.fn(() => ({ dataPath: "data/skills" })),
  syncInstalledSkillsToDatabase: vi.fn(async () => ({ skillPackages: [], skills: [] })),
}));

// skills-registry imports server-only and DB modules transitively; provide
// a minimal parseFrontmatter stub so compile-agent-skills.ts loads cleanly.
vi.mock("./skills-registry", () => ({
  parseFrontmatter: (content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return { attributes: {} as Record<string, string>, body: content };
    const attributes: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      attributes[key] = value;
    }
    return { attributes, body: content.slice(match[0].length) };
  },
}));

import { compileAndRegisterAgentSkillsForRepo } from "./compile-agent-skills";

// ---------------------------------------------------------------------------
// compileAndRegisterAgentSkillsForRepo
// ---------------------------------------------------------------------------

describe("compileAndRegisterAgentSkillsForRepo", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    upsertSkillMock.mockClear();
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cinatra-agent-skills-"));
  });

  it("walks <repoRoot>/agents/<slug>/skills and upserts each as level:'agent'", async () => {
    const agentDir = path.join(tmpRoot, "agents", "foo");
    const skillDir = path.join(agentDir, "skills", "bar");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "package.json"),
      JSON.stringify({ name: "@x/foo", version: "1.0.0" }),
    );
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: Bar Skill", "description: a description", "---", "body"].join("\n"),
    );

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual(["custom:foo:bar-skill"]);
    expect(result.skipped).toEqual([]);
    expect(upsertSkillMock).toHaveBeenCalledTimes(1);
    const callArg = upsertSkillMock.mock.calls[0][0];
    expect(callArg).toMatchObject({
      type: "agent",
      packageName: "@x/foo",
      agentId: "@x/foo",
      skillId: "custom:foo:bar-skill",
      name: "Bar Skill",
      description: "a description",
      prefillText: "-",
    });
    expect(callArg.content).toContain("body");

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns { registered: [], skipped: [] } when <repoRoot>/agents does not exist", async () => {
    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });
    expect(result).toEqual({ registered: [], skipped: [] });
    expect(upsertSkillMock).not.toHaveBeenCalled();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("skips agent dirs without package.json", async () => {
    const agentDir = path.join(tmpRoot, "agents", "no-pkg");
    await mkdir(path.join(agentDir, "skills", "x"), { recursive: true });
    await writeFile(
      path.join(agentDir, "skills", "x", "SKILL.md"),
      "---\nname: X\n---\nbody",
    );

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].slug).toBe("no-pkg");
    expect(upsertSkillMock).not.toHaveBeenCalled();

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("skips agent dirs with empty skills/ directory", async () => {
    const agentDir = path.join(tmpRoot, "agents", "empty");
    await mkdir(path.join(agentDir, "skills"), { recursive: true });
    await writeFile(
      path.join(agentDir, "package.json"),
      JSON.stringify({ name: "@x/empty" }),
    );

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual([]);
    expect(upsertSkillMock).not.toHaveBeenCalled();

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects malformed package.json names", async () => {
    const agentDir = path.join(tmpRoot, "agents", "bad");
    const skillDir = path.join(agentDir, "skills", "s");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "package.json"),
      JSON.stringify({ name: "../etc/passwd" }),
    );
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: S\n---\nbody");

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toMatch(/package\.json#name/i);
    expect(upsertSkillMock).not.toHaveBeenCalled();

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects directory slugs containing path separators", async () => {
    // Can't actually create a dir named "foo/bar" on disk; instead create
    // a normal entry and verify the validator rejects ".." style names if
    // somehow encountered. This test exercises the same defensive path.
    const agentDir = path.join(tmpRoot, "agents", "..-bad");
    const skillDir = path.join(agentDir, "skills", "x");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "package.json"),
      JSON.stringify({ name: "@x/dotted" }),
    );
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: X\n---\nbody");

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toMatch(/slug/i);
    expect(upsertSkillMock).not.toHaveBeenCalled();

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("collects per-skill errors in skipped without throwing", async () => {
    const agentDir = path.join(tmpRoot, "agents", "ok");
    const skillDir = path.join(agentDir, "skills", "good");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "package.json"),
      JSON.stringify({ name: "@x/ok" }),
    );
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: Good\n---\nbody");

    upsertSkillMock.mockImplementationOnce(async () => {
      throw new Error("simulated upsert failure");
    });

    const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

    expect(result.registered).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toContain("simulated upsert failure");

    await rm(tmpRoot, { recursive: true, force: true });
  });
});
