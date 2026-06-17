/**
 * Symlink / realpath containment test for github.ts's `assertWithinSkillsRoot`
 * guard (#300).
 *
 * github.ts's module graph (./skills-store -> @/lib/database -> notifications /
 * background-jobs) needs the full DB chain, so — exactly like github.test.ts —
 * we MOCK ./skills-store and the network deps rather than loading them. The
 * only skills-store surface the guard touches is `getSkillsDataRootPath`, which
 * we pin to a real temp directory so the guard canonicalizes against an on-disk
 * root we control and can plant a symlinked ancestor under.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-gh-symlink-guard-"));
const skillsRoot = path.join(tmpBase, "data", "skills");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(skillsRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
// On macOS /tmp -> /private/tmp; the guard's canonical root is the realpath.
const realSkillsRoot = realpathSync.native(skillsRoot);

vi.mock("server-only", () => ({}));

vi.mock("@/lib/github-api", () => ({
  getGitHubAccessToken: vi.fn(),
  getGitHubAPIStatus: vi.fn(),
  getGitHubOAuthSettings: vi.fn(),
}));

vi.mock("octokit", () => ({
  Octokit: function MockOctokit() {
    return {};
  },
}));

vi.mock("./skills-store", () => ({
  upsertRepositoryBackedSkillPackage: vi.fn(),
  getSkillsDataRootPath: vi.fn(() => skillsRoot),
}));

vi.mock("./compile-agent-skills", () => ({
  compileAndRegisterAgentSkillsForRepo: vi.fn(),
}));

import { assertWithinSkillsRoot } from "./github";

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("assertWithinSkillsRoot realpath/symlink containment (#300)", () => {
  const ERR = "escape";

  it("sanity: the mocked skills root resolves to our temp tree", () => {
    expect(realSkillsRoot).toBe(realpathSync.native(skillsRoot));
  });

  it("accepts a legitimate non-symlink directory inside the skills data root", () => {
    const dir = path.join(skillsRoot, "workspace", "owner", "repo");
    mkdirSync(dir, { recursive: true });
    expect(assertWithinSkillsRoot(dir, ERR)).toBe(path.resolve(dir));
  });

  it("accepts a not-yet-existing leaf inside the skills data root (nearest-ancestor realpath)", () => {
    const parent = path.join(skillsRoot, "workspace", "owner2");
    mkdirSync(parent, { recursive: true });
    const missingLeaf = path.join(parent, "repo-not-created");
    expect(assertWithinSkillsRoot(missingLeaf, ERR)).toBe(path.resolve(missingLeaf));
  });

  it("accepts the skills data root itself", () => {
    expect(assertWithinSkillsRoot(skillsRoot, ERR)).toBe(path.resolve(skillsRoot));
  });

  it("REJECTS a path whose ANCESTOR is a symlink pointing outside the root", () => {
    // <skillsRoot>/workspace/escape-link -> <outsideDir>. The lexical prefix
    // check passes (string is inside skillsRoot) but the real path is
    // <outsideDir>/owner/repo, outside the root — the realpath layer rejects.
    const linkParent = path.join(skillsRoot, "workspace");
    mkdirSync(linkParent, { recursive: true });
    const link = path.join(linkParent, "escape-link");
    try {
      rmSync(link, { force: true });
    } catch {
      /* noop */
    }
    symlinkSync(outsideDir, link, "dir");
    const target = path.join(link, "owner", "repo");
    expect(() => assertWithinSkillsRoot(target, ERR)).toThrow(ERR);
  });

  it("REJECTS the symlinked directory itself when it points outside", () => {
    const link = path.join(skillsRoot, "self-escape-link");
    try {
      rmSync(link, { force: true });
    } catch {
      /* noop */
    }
    symlinkSync(outsideDir, link, "dir");
    expect(() => assertWithinSkillsRoot(link, ERR)).toThrow(ERR);
  });
});
