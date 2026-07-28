// `registerArtifactExtensionSkillsForPackage` — WHICH packages may own a
// matcher skill (cinatra#2090 S3, epic #2086).
//
// The matcher's boot-order heal calls this on a catalog miss. Before the S3
// extraction the only legitimate owner was the artifact extension itself, and
// this helper hard-refused every other kind. Post-extraction a matcher bundle
// lives in its own one-bundle `kind:"skill"` extension that the artifact
// declares a `role:"matcher"` edge on, and the matcher resolves that edge to
// the PROVIDER before calling here — so a `kind:"skill"` refusal would leave
// every extracted matcher unable to heal a cold catalog (the artifact package
// has no `skills/` dir at all any more).
//
// The matcher-runtime suite MOCKS this helper, so nothing there can catch that.
// This suite drives the REAL function against temp fixture dirs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { registerColocatedMock } = vi.hoisted(() => ({
  registerColocatedMock: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("@cinatra-ai/skills", () => ({
  registerColocatedWorkspaceSkills: registerColocatedMock,
  registerExtensionSkill: vi.fn(),
  deriveSkillRegistration: (pkgName: string, _dir: string, slug: string) => ({
    packageName: pkgName,
    skillId: `${pkgName}:${slug}`,
  }),
  registerPackageAgentSkill: vi.fn(),
}));
vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

import { registerArtifactExtensionSkillsForPackage } from "@/lib/extensions-dev-watcher";

let tmpRoot: string;
let origCwd: string;

function writePkg(dirName: string, name: string, kind: string, slugs: string[] = [], vendor = "cinatra-ai") {
  const pkgDir = path.join(tmpRoot, "extensions", vendor, dirName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "0.1.0", cinatra: { kind } }),
  );
  for (const slug of slugs) {
    const sd = path.join(pkgDir, "skills", slug);
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "SKILL.md"), `---\nname: ${slug}\n---\nbody`);
  }
}

beforeEach(() => {
  registerColocatedMock.mockReset();
  registerColocatedMock.mockResolvedValue([]);
  tmpRoot = mkdtempSync(path.join(tmpdir(), "matcher-owner-"));
  origCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("registerArtifactExtensionSkillsForPackage — owning kinds", () => {
  it("registers a kind:artifact package's co-located bundle (pre-extraction)", async () => {
    writePkg("pdf-artifact", "@cinatra-ai/pdf-artifact", "artifact", ["pdf-matcher"]);
    registerColocatedMock.mockResolvedValue(["@cinatra-ai/pdf-artifact:pdf-matcher"]);
    await expect(registerArtifactExtensionSkillsForPackage("@cinatra-ai/pdf-artifact")).resolves.toBe(1);
  });

  it("registers a kind:skill PROVIDER package (post-extraction) — the P1 this closes", async () => {
    writePkg("pdf-matcher-skill", "@cinatra-ai/pdf-matcher-skill", "skill", ["pdf-matcher"]);
    registerColocatedMock.mockResolvedValue(["@cinatra-ai/pdf-matcher-skill:pdf-matcher"]);
    await expect(
      registerArtifactExtensionSkillsForPackage("@cinatra-ai/pdf-matcher-skill"),
    ).resolves.toBe(1);
  });

  it("REFUSES any other kind on a name match", async () => {
    writePkg("sneaky-connector", "@cinatra-ai/sneaky-connector", "connector", ["pdf-matcher"]);
    await expect(
      registerArtifactExtensionSkillsForPackage("@cinatra-ai/sneaky-connector"),
    ).resolves.toBe(0);
    expect(registerColocatedMock).not.toHaveBeenCalled();
  });

  it("an unknown package name registers nothing (never throws)", async () => {
    writePkg("pdf-artifact", "@cinatra-ai/pdf-artifact", "artifact", ["pdf-matcher"]);
    await expect(registerArtifactExtensionSkillsForPackage("@cinatra-ai/nope")).resolves.toBe(0);
    expect(registerColocatedMock).not.toHaveBeenCalled();
  });

  it("finds a provider under ANY vendor directory, not just cinatra-ai", async () => {
    // The resolver that decides WHICH package to heal walks every vendor dir,
    // so pinning this heal to one vendor left a resolvable third-party
    // provider unable to register on a cold catalog (codex round 2).
    writePkg("widget-matcher-skill", "@other-vendor/widget-matcher-skill", "skill", ["widget-matcher"], "other-vendor");
    registerColocatedMock.mockResolvedValue(["@other-vendor/widget-matcher-skill:widget-matcher"]);
    await expect(
      registerArtifactExtensionSkillsForPackage("@other-vendor/widget-matcher-skill"),
    ).resolves.toBe(1);
    expect(registerColocatedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pkgName: "@other-vendor/widget-matcher-skill",
        pkgDirName: "widget-matcher-skill",
      }),
    );
  });

  it("an owning-kind package with no skills/ dir registers nothing", async () => {
    writePkg("bare-skill", "@cinatra-ai/bare-skill", "skill", []);
    await expect(registerArtifactExtensionSkillsForPackage("@cinatra-ai/bare-skill")).resolves.toBe(0);
  });
});
