import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The `kind:"artifact"` dev-watcher branch registers co-located
// `skills/<slug>/SKILL.md` into the catalog. Without that registration,
// the matcher runtime has nothing to resolve. These tests drive the real
// `loadOnePackage` (test-only export) against temp fixture dirs and assert
// the registration call shape: package-owned `packageName` is the matcher
// trust anchor, so it MUST be the artifact extension's own package name.

const { registerExtensionSkillMock } = vi.hoisted(() => ({
  registerExtensionSkillMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => {
  // `loadOnePackage` delegates the co-located skill walk to the skills
  // package's shared `registerColocatedWorkspaceSkills`. Replicate that walk
  // here so it routes through the captured `registerExtensionSkill` spy and
  // returns the registered skill-ids (fail-soft per skill).
  const registerColocatedWorkspaceSkills = async (input: {
    pkgDir: string;
    pkgName: string;
    pkgDirName: string;
  }): Promise<string[]> => {
    const { existsSync, readdirSync } = require("node:fs");
    const nodePath = require("node:path");
    const skillsRoot = nodePath.join(input.pkgDir, "skills");
    if (!existsSync(skillsRoot)) return [];
    const registered: string[] = [];
    for (const slugEntry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!slugEntry.isDirectory()) continue;
      const slug = slugEntry.name;
      const skillMdPath = nodePath.join(skillsRoot, slug, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const { packageName, skillId } = deriveSkillRegistration(
        input.pkgName,
        input.pkgDirName,
        slug,
      );
      try {
        await registerExtensionSkillMock({ skillId, packageName, skillMdPath });
        registered.push(skillId);
      } catch {
        // Fail-soft per skill: a single bad SKILL.md never aborts the bundle.
      }
    }
    return registered;
  };
  const deriveSkillRegistration = (
    pkgName: string,
    pkgDirName: string,
    slug: string,
  ): { packageName: string; skillId: string } => {
    if (pkgDirName === "assistant-skills") {
      return { packageName: "@cinatra-ai/chat", skillId: `@cinatra-ai/chat:${slug}` };
    }
    const packageName = pkgName.startsWith("@") ? pkgName : `@${pkgName}`;
    return { packageName, skillId: `${packageName}:${slug}` };
  };
  return {
    registerExtensionSkill: registerExtensionSkillMock,
    registerColocatedWorkspaceSkills,
    deriveSkillRegistration,
    // loadOnePackage's agent branch also dynamic-imports
    // registerPackageAgentSkill; unused here but must resolve so the module loads.
    registerPackageAgentSkill: vi.fn(),
  };
});

// extensions-dev-watcher.ts statically imports
// @cinatra-ai/objects/register-artifact-extensions, which bridges artifact
// descriptors into the object registry. vitest does not resolve that workspace
// subpath alias; the artifact descriptor path is not exercised by
// these skill-walk tests, so stub it.
vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

import { __loadOnePackageForTests as loadOnePackage } from "@/lib/extensions-dev-watcher";

let tmpRoot: string;

function writePkg(
  dirName: string,
  pkgJson: Record<string, unknown>,
  skills: Array<{ slug: string; body: string }> = [],
): string {
  const pkgDir = path.join(tmpRoot, dirName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );
  for (const s of skills) {
    const sd = path.join(pkgDir, "skills", s.slug);
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "SKILL.md"), s.body);
  }
  return pkgDir;
}

describe("loadOnePackage — kind:artifact co-located skill registration", () => {
  beforeEach(() => {
    registerExtensionSkillMock.mockReset();
    registerExtensionSkillMock.mockResolvedValue(undefined);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "slice5a-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("registers every skills/<slug>/SKILL.md for a kind:artifact package", async () => {
    const pkgDir = writePkg(
      "marketing-icp-artifact",
      {
        name: "@cinatra-ai/marketing-icp-artifact",
        version: "0.1.0",
        cinatra: { kind: "artifact" },
      },
      [
        { slug: "icp-matcher", body: "---\nname: icp-matcher\n---\nClassify ICP." },
        { slug: "icp-validator", body: "# validate" },
      ],
    );
    const res = await loadOnePackage(pkgDir);
    expect(res.kind).toBe("artifact");
    expect(res.skillsRegistered).toBe(2);
    expect(registerExtensionSkillMock).toHaveBeenCalledTimes(2);
    // Package-owned trust anchor: skillId + packageName MUST carry the
    // artifact extension's own package name.
    const calls = registerExtensionSkillMock.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.packageName)).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
      "@cinatra-ai/marketing-icp-artifact",
    ]);
    expect(calls.map((c) => c.skillId).sort()).toEqual([
      "@cinatra-ai/marketing-icp-artifact:icp-matcher",
      "@cinatra-ai/marketing-icp-artifact:icp-validator",
    ]);
    for (const c of calls) {
      expect(c.skillMdPath).toMatch(/skills\/icp-(matcher|validator)\/SKILL\.md$/);
    }
  });

  it("kind:artifact with NO skills/ dir → skillsRegistered 0 (no throw)", async () => {
    const pkgDir = writePkg("bare-artifact", {
      name: "@cinatra-ai/bare-artifact",
      version: "0.1.0",
      cinatra: { kind: "artifact" },
    });
    const res = await loadOnePackage(pkgDir);
    expect(res.kind).toBe("artifact");
    expect(res.skillsRegistered).toBe(0);
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("a single failing SKILL.md does NOT abort the rest of the bundle", async () => {
    const pkgDir = writePkg(
      "multi-artifact",
      {
        name: "@cinatra-ai/multi-artifact",
        version: "0.1.0",
        cinatra: { kind: "artifact" },
      },
      [
        { slug: "a", body: "a" },
        { slug: "b", body: "b" },
        { slug: "c", body: "c" },
      ],
    );
    registerExtensionSkillMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("bad SKILL.md b"))
      .mockResolvedValueOnce(undefined);
    const res = await loadOnePackage(pkgDir);
    // All 3 attempted; 2 succeed, the throwing one is skipped.
    expect(registerExtensionSkillMock).toHaveBeenCalledTimes(3);
    expect(res.skillsRegistered).toBe(2);
  });

  it("kind:skill branch is byte-identical (shared helper, regression guard)", async () => {
    const pkgDir = writePkg(
      "some-skill-pkg",
      {
        name: "@cinatra-ai/some-skill-pkg",
        version: "0.1.0",
        cinatra: { kind: "skill" },
      },
      [{ slug: "only", body: "skill body" }],
    );
    const res = await loadOnePackage(pkgDir);
    expect(res.kind).toBe("skill");
    expect(res.skillsRegistered).toBe(1);
    expect(registerExtensionSkillMock).toHaveBeenCalledWith({
      skillId: "@cinatra-ai/some-skill-pkg:only",
      packageName: "@cinatra-ai/some-skill-pkg",
      skillMdPath: path.join(pkgDir, "skills", "only", "SKILL.md"),
    });
  });
});
