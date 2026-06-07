// Multi-scope discovery proof.
//
// The dev-watcher loader walks `extensions/<vendor>/<pkg>/` GENERICALLY.
// This test mounts a fixture vendored `@anthropics/skills` package inside a
// temp dir and asserts the loader registers its inner skill correctly with
// the package-owned packageName as the matcher trust anchor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { registerExtensionSkillMock } = vi.hoisted(() => ({
  registerExtensionSkillMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => {
  // `loadOnePackage` delegates the co-located skill walk to the skills
  // package's shared `registerColocatedWorkspaceSkills`. Replicate that walk
  // here so it routes through the captured `registerExtensionSkill` spy and
  // returns the registered skill-ids (fail-soft per skill).
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
        // Fail-soft per skill.
      }
    }
    return registered;
  };
  return {
    registerExtensionSkill: registerExtensionSkillMock,
    registerColocatedWorkspaceSkills,
    deriveSkillRegistration,
    registerPackageAgentSkill: vi.fn(),
  };
});

vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

import { __loadOnePackageForTests as loadOnePackage } from "@/lib/extensions-dev-watcher";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "vendor-scope-"));
  registerExtensionSkillMock.mockReset();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writePkg(
  vendorScope: string,
  dirName: string,
  pkgJson: Record<string, unknown>,
  skills: Array<{ slug: string; body: string }> = [],
): string {
  const vendorDir = path.join(tmpRoot, vendorScope);
  mkdirSync(vendorDir, { recursive: true });
  const pkgDir = path.join(vendorDir, dirName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2));
  for (const s of skills) {
    const sd = path.join(pkgDir, "skills", s.slug);
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "SKILL.md"), s.body);
  }
  return pkgDir;
}

describe("loadOnePackage — multi-scope discovery (anthropics carve-out)", () => {
  it("registers a vendored @anthropics/skills package's inner skill under its own packageName", async () => {
    const pkgDir = writePkg(
      "anthropics",
      "skills",
      {
        name: "@anthropics/skills",
        version: "0.0.0",
        cinatra: {
          apiVersion: "cinatra.ai/v1",
          kind: "skill",
          vendoredFrom: {
            owner: "anthropics",
            repo: "skills",
            sha: "deadbeefcafe",
            url: "https://github.com/anthropics/skills",
          },
        },
        license: "Apache-2.0",
      },
      [
        {
          slug: "skill-creator",
          body: [
            "---",
            "name: skill-creator",
            "description: Skill-authoring methodology vendored from Anthropic",
            "---",
            "",
            "# Skill creator",
            "",
            "Body text.",
          ].join("\n"),
        },
      ],
    );

    const res = await loadOnePackage(pkgDir);
    expect(res.agentChanged).toBe(false);

    expect(registerExtensionSkillMock).toHaveBeenCalled();
    const callArg = registerExtensionSkillMock.mock.calls[0]?.[0] ?? {};
    expect(callArg.packageName).toBe("@anthropics/skills");
    expect(callArg.skillId).toBe("@anthropics/skills:skill-creator");
    expect(typeof callArg.skillMdPath).toBe("string");
    expect(callArg.skillMdPath.endsWith("SKILL.md")).toBe(true);
  });

  it("registers an @cinatra-ai/<slug>-skills bundle under its own packageName (parity)", async () => {
    // Use a fixture name that doesn't collide with the assistant-skills
    // `@cinatra-ai/chat:*` legacy-namespace carve-out (see
    // extensions-dev-watcher.ts:39 — only `assistant-skills` is remapped).
    const pkgDir = writePkg(
      "cinatra-ai",
      "fixture-vendor-scope-skills",
      {
        name: "@cinatra-ai/fixture-vendor-scope-skills",
        version: "1.0.0",
        cinatra: { apiVersion: "cinatra.ai/v1", kind: "skill" },
      },
      [
        {
          slug: "fixture-skill",
          body: ["---", "name: fixture-skill", "description: example", "---", "# body"].join("\n"),
        },
      ],
    );

    const res = await loadOnePackage(pkgDir);
    expect(res.agentChanged).toBe(false);
    expect(registerExtensionSkillMock).toHaveBeenCalled();
    const callArg = registerExtensionSkillMock.mock.calls[0]?.[0] ?? {};
    expect(callArg.packageName).toBe("@cinatra-ai/fixture-vendor-scope-skills");
  });
});
