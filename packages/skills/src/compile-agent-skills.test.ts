/**
 * Coverage for agent-level skill compilation helpers.
 *
 * `compileAndRegisterAgentSkillsForRepo` auto-registers agent-level skills
 * at setup and install time. The suite verifies successful registration and
 * defensive skip behavior without loading the real database chain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
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

import { compileAndRegisterAgentSkillsForRepo, resolveWithin } from "./compile-agent-skills";

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

  // -------------------------------------------------------------------------
  // Path-injection containment (js/path-injection, code-scanning).
  //
  // Every fs read descends from the exported `repoRoot` parameter. The fail-
  // closed barrier resolves each child against its resolved parent and confines
  // it. Legitimate trees (validated dir slugs, hardcoded `agents`/`skills`/
  // `SKILL.md` leaves) are byte-identical; a `..` baked into `repoRoot` is
  // normalized by resolve and never escapes the resolved base.
  // -------------------------------------------------------------------------
  describe("path-injection containment", () => {
    it("normalizes a repoRoot containing '..' and still registers the legitimate tree", async () => {
      // tmpRoot/nested/.. resolves back to tmpRoot — the agents tree lives at
      // tmpRoot/agents/foo/skills/bar. The resolve must collapse the `..`
      // without escaping, and registration must be byte-identical to the
      // canonical-root case.
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

      const repoRootWithDotDot = path.join(tmpRoot, "nested", "..");
      const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: repoRootWithDotDot });

      expect(result.registered).toEqual(["custom:foo:bar-skill"]);
      expect(result.skipped).toEqual([]);
      expect(upsertSkillMock).toHaveBeenCalledTimes(1);

      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("does not read SKILL.md outside the agents tree for a traversal-named skill dir", async () => {
      // Plant a secret OUTSIDE the agents tree and an agent referencing a
      // traversal-named skill dir. isValidDirectorySlug rejects the `..`
      // segment, and even if it slipped through, the resolveWithin guard would
      // skip it — so the secret is never read and upsert is never called with
      // its content.
      const secretPath = path.join(tmpRoot, "secret.md");
      await writeFile(secretPath, "---\nname: Secret\n---\nTOP SECRET");

      const agentDir = path.join(tmpRoot, "agents", "ok");
      await mkdir(path.join(agentDir, "skills"), { recursive: true });
      await writeFile(path.join(agentDir, "package.json"), JSON.stringify({ name: "@x/ok" }));
      // A literal "..-escape" entry: isValidDirectorySlug rejects any name
      // containing "..".
      await mkdir(path.join(agentDir, "skills", "..-escape"), { recursive: true });
      await writeFile(
        path.join(agentDir, "skills", "..-escape", "SKILL.md"),
        "---\nname: Escape\n---\nbody",
      );

      const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

      expect(result.registered).toEqual([]);
      expect(result.skipped.some((s) => /slug/i.test(s.reason))).toBe(true);
      expect(upsertSkillMock).not.toHaveBeenCalled();

      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("does not read skills when agents/<slug>/skills is a symlink to outside the repo", async () => {
      // The escape: `agents/<slug>/skills` is itself a SYMLINK to a directory
      // OUTSIDE the repo root containing a SKILL.md. Lexically `skills` is inside
      // `agentDir`, so the literal path.join would readdir the link's outside
      // target, and the per-skill resolveWithin(skillsDir, …) would canonicalize
      // that outside target as its realParent — making every child look
      // contained and reading SKILL.md OUT of the repo. Confining `skills`
      // through resolveWithin(agentDir, "skills") catches the symlink and skips
      // the agent (no-throw contract). A legitimate non-symlink sibling agent
      // still compiles, proving behavior is unchanged for normal layouts.
      const outsideSkills = path.join(tmpRoot, "outside-skills");
      await mkdir(path.join(outsideSkills, "leaked"), { recursive: true });
      await writeFile(
        path.join(outsideSkills, "leaked", "SKILL.md"),
        "---\nname: Leaked\n---\nTOP SECRET",
      );

      // Malicious agent: skills/ is a symlink to the outside dir.
      const evilAgentDir = path.join(tmpRoot, "agents", "evil");
      await mkdir(evilAgentDir, { recursive: true });
      await writeFile(path.join(evilAgentDir, "package.json"), JSON.stringify({ name: "@x/evil" }));
      await symlink(outsideSkills, path.join(evilAgentDir, "skills"), "dir");

      // Legitimate agent: a real, non-symlink skills tree that must still compile.
      const goodAgentDir = path.join(tmpRoot, "agents", "good");
      const goodSkillDir = path.join(goodAgentDir, "skills", "bar");
      await mkdir(goodSkillDir, { recursive: true });
      await writeFile(path.join(goodAgentDir, "package.json"), JSON.stringify({ name: "@x/good" }));
      await writeFile(
        path.join(goodSkillDir, "SKILL.md"),
        ["---", "name: Bar Skill", "description: a description", "---", "body"].join("\n"),
      );

      const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

      // The leaked skill is never read/compiled; the evil agent is skipped.
      expect(result.registered).toEqual(["custom:good:bar-skill"]);
      expect(
        result.skipped.some((s) => s.slug === "evil" && /skills dir escapes/i.test(s.reason)),
      ).toBe(true);
      // upsertSkill is called exactly once — for the legitimate skill only.
      expect(upsertSkillMock).toHaveBeenCalledTimes(1);
      expect(
        upsertSkillMock.mock.calls.every(([arg]) => !arg.content?.includes("TOP SECRET")),
      ).toBe(true);

      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("does not read a SKILL.md that is a FILE symlink to outside the repo (leaf confinement)", async () => {
      // The escape (next layer beyond #300's directory containment): the skill
      // DIRECTORY is legitimately confined inside the repo, but the SKILL.md
      // FILE inside it is a SYMLINK to a secret OUTSIDE the repo. The directory
      // guards all pass — `agents/evil/skills/leaf` resolves inside the repo —
      // but `readFile(SKILL.md)` would follow the file-symlink and ingest the
      // outside secret. fileLeafContainedIn must reject the leaf so it is
      // skipped (no-throw), while a legitimate non-symlink SKILL.md still
      // compiles, proving behavior is unchanged for normal files.
      const secret = path.join(tmpRoot, "secret-skill.md");
      await writeFile(secret, ["---", "name: Leaked", "---", "TOP SECRET"].join("\n"));

      // Malicious agent: a real, confined skill dir whose SKILL.md is a symlink
      // to the outside secret.
      const evilAgentDir = path.join(tmpRoot, "agents", "evil");
      const evilSkillDir = path.join(evilAgentDir, "skills", "leaf");
      await mkdir(evilSkillDir, { recursive: true });
      await writeFile(path.join(evilAgentDir, "package.json"), JSON.stringify({ name: "@x/evil" }));
      await symlink(secret, path.join(evilSkillDir, "SKILL.md"), "file");

      // Legitimate agent: a real, non-symlink SKILL.md that must still compile.
      const goodAgentDir = path.join(tmpRoot, "agents", "good");
      const goodSkillDir = path.join(goodAgentDir, "skills", "bar");
      await mkdir(goodSkillDir, { recursive: true });
      await writeFile(path.join(goodAgentDir, "package.json"), JSON.stringify({ name: "@x/good" }));
      await writeFile(
        path.join(goodSkillDir, "SKILL.md"),
        ["---", "name: Bar Skill", "description: a description", "---", "body"].join("\n"),
      );

      const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

      // The leaked skill is never read/compiled; the evil leaf is skipped.
      expect(result.registered).toEqual(["custom:good:bar-skill"]);
      expect(
        result.skipped.some(
          (s) => s.slug === "evil/leaf" && /SKILL\.md escapes the skill dir \(symlink\)/i.test(s.reason),
        ),
      ).toBe(true);
      // upsertSkill is called exactly once — for the legitimate skill only.
      expect(upsertSkillMock).toHaveBeenCalledTimes(1);
      expect(
        upsertSkillMock.mock.calls.every(([arg]) => !arg.content?.includes("TOP SECRET")),
      ).toBe(true);

      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("does not read a package.json that is a FILE symlink to outside the repo (leaf confinement)", async () => {
      // Same leaf escape applied to the package.json read: the agent DIRECTORY
      // is confined inside the repo, but its package.json is a SYMLINK to a file
      // outside. The directory guards pass; fileLeafContainedIn must reject the
      // leaf so `readFile(package.json)` never follows the symlink, skipping the
      // agent. A legitimate non-symlink agent still compiles.
      const outsidePkg = path.join(tmpRoot, "outside-package.json");
      await writeFile(outsidePkg, JSON.stringify({ name: "@x/leaked" }));

      const evilAgentDir = path.join(tmpRoot, "agents", "evilpkg");
      const evilSkillDir = path.join(evilAgentDir, "skills", "s");
      await mkdir(evilSkillDir, { recursive: true });
      await symlink(outsidePkg, path.join(evilAgentDir, "package.json"), "file");
      await writeFile(path.join(evilSkillDir, "SKILL.md"), "---\nname: S\n---\nbody");

      const goodAgentDir = path.join(tmpRoot, "agents", "goodpkg");
      const goodSkillDir = path.join(goodAgentDir, "skills", "bar");
      await mkdir(goodSkillDir, { recursive: true });
      await writeFile(path.join(goodAgentDir, "package.json"), JSON.stringify({ name: "@x/goodpkg" }));
      await writeFile(
        path.join(goodSkillDir, "SKILL.md"),
        ["---", "name: Bar Skill", "description: a description", "---", "body"].join("\n"),
      );

      const result = await compileAndRegisterAgentSkillsForRepo({ repoRoot: tmpRoot });

      expect(result.registered).toEqual(["custom:goodpkg:bar-skill"]);
      expect(
        result.skipped.some(
          (s) => s.slug === "evilpkg" && /package\.json escapes the agent dir \(symlink\)/i.test(s.reason),
        ),
      ).toBe(true);
      expect(upsertSkillMock).toHaveBeenCalledTimes(1);

      await rm(tmpRoot, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // resolveWithin realpath/symlink containment (#300).
  //
  // resolveWithin is the per-segment guard. Pre-#300 it was lexical-only, so a
  // child built on a symlinked parent passed the prefix check and a downstream
  // fs op followed the link outside the parent. It now realpath-confines and
  // returns null on a symlink escape (preserving the no-throw contract), while
  // legitimate non-symlink and not-yet-created children still resolve.
  // -------------------------------------------------------------------------
  describe("resolveWithin realpath/symlink containment", () => {
    it("resolves a legitimate non-symlink child inside the parent", async () => {
      await mkdir(path.join(tmpRoot, "agents"), { recursive: true });
      const child = resolveWithin(path.resolve(tmpRoot), "agents");
      expect(child).toBe(path.join(path.resolve(tmpRoot), "agents"));
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("resolves a not-yet-existing child (nearest-ancestor realpath)", async () => {
      // The parent exists; the child segment does not. realpath of the missing
      // child throws — the guard must resolve the existing parent and accept.
      const child = resolveWithin(path.resolve(tmpRoot), "does-not-exist-yet");
      expect(child).toBe(path.join(path.resolve(tmpRoot), "does-not-exist-yet"));
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it("returns null when the resolved child is a symlink pointing outside the parent", async () => {
      // The escape: a child SEGMENT that exists as a symlink to a target
      // outside the parent. `realparent/agents` is a symlink to `outside/agents`
      // (a real dir outside the parent). Lexically `agents` is inside
      // `realparent`, but it realpath's to `outside/agents` which is NOT inside
      // realpath(realparent) -> resolveWithin must return null. A downstream
      // readdir would otherwise walk the linked-out tree.
      const realParentDir = path.join(tmpRoot, "realparent");
      const outside = path.join(tmpRoot, "outside2");
      await mkdir(realParentDir, { recursive: true });
      await mkdir(path.join(outside, "agents"), { recursive: true });
      const linkChild = path.join(realParentDir, "agents");
      await symlink(path.join(outside, "agents"), linkChild, "dir");
      const resolved = resolveWithin(path.resolve(realParentDir), "agents");
      expect(resolved).toBeNull();
      await rm(tmpRoot, { recursive: true, force: true });
    });
  });
});
