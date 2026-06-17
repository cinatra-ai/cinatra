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
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipSync, strToU8 } from "fflate";

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

import { assertWithinSkillsRoot, installSkillPackageFromZip } from "./github";

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

// ---------------------------------------------------------------------------
// ZIP install (installSkillPackageFromZip) — base confinement + per-entry
// zip-slip / symlink-escape (#300). The destructive `rm`/`mkdir` + per-entry
// `writeFile` previously ran with NO containment. The base is now confined via
// `assertWithinSkillsRoot` BEFORE any write, and each entry is resolved against
// the confined base and SKIPPED on escape.
// ---------------------------------------------------------------------------
describe("installSkillPackageFromZip zip-slip / base containment (#300)", () => {
  it("extracts legitimate entries and does NOT write a `../escape` zip-slip entry outside the base", async () => {
    // The uploaded slug lands at <skillsRoot>/workspace/uploaded/<slug>/.
    const slug = "zipslip-pkg";
    const installBase = path.join(skillsRoot, "workspace", "uploaded", slug);

    // A normal file (must be extracted) plus a zip-slip entry whose name
    // traverses out of the base into the skills root (and beyond, to outside).
    const zip = zipSync({
      "SKILL.md": strToU8(["---", "name: zip-good", "---", "REAL BODY"].join("\n")),
      // `../../../escape.txt` resolves above the install base. path.join
      // collapses the `..` segments; the lexical layer rejects the escape.
      "../../../escape.txt": strToU8("ZIP SLIP PAYLOAD"),
    });

    const escapeTarget = path.resolve(installBase, "..", "..", "..", "escape.txt");

    await installSkillPackageFromZip(Buffer.from(zip), slug);

    // The legitimate entry was written inside the confined base.
    expect(existsSync(path.join(installBase, "SKILL.md"))).toBe(true);
    expect(readFileSync(path.join(installBase, "SKILL.md"), "utf8")).toContain("REAL BODY");

    // The zip-slip entry was NOT materialized anywhere outside the base.
    expect(existsSync(escapeTarget)).toBe(false);
  });

  it("REJECTS the whole install when the install base resolves through a symlinked ancestor pointing outside the root", async () => {
    // Plant <skillsRoot>/workspace/uploaded as a symlink to outsideDir, so the
    // computed base <skillsRoot>/workspace/uploaded/<slug> passes the lexical
    // prefix check but its REAL path is <outsideDir>/<slug> — outside the root.
    const workspaceDir = path.join(skillsRoot, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    const uploadedLink = path.join(workspaceDir, "uploaded");
    try {
      rmSync(uploadedLink, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    symlinkSync(outsideDir, uploadedLink, "dir");

    const slug = "symlinked-base-pkg";
    const zip = zipSync({ "SKILL.md": strToU8("---\nname: x\n---\nBODY") });

    // The base-confinement barrier throws BEFORE any rm/mkdir/write runs.
    await expect(installSkillPackageFromZip(Buffer.from(zip), slug)).rejects.toThrow(
      /escapes the skills data root/i,
    );
    // And nothing was written under the escaping (outside) location.
    expect(existsSync(path.join(outsideDir, slug, "SKILL.md"))).toBe(false);

    // Restore a real directory so other tests in this file are unaffected.
    rmSync(uploadedLink, { recursive: true, force: true });
    mkdirSync(uploadedLink, { recursive: true });
  });
});

// Reference the leaf-write helpers so an unused-import lint never trips when a
// test path is skipped; they document the fflate-based fixture authoring.
void writeFileSync;
