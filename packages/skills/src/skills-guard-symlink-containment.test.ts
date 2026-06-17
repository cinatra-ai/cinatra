/**
 * Symlink / realpath containment tests for the skills path-containment guards
 * (#300, hardening the lexical-only guards flagged in codex's #299 review).
 *
 * The pre-#300 guards were lexical-only (path.resolve + startsWith). A SYMLINKED
 * ANCESTOR planted under the skills root (e.g. `<root>/workspace -> /tmp/evil`)
 * passes the lexical prefix check, so a downstream fs op follows the link OUT of
 * the intended root. These tests plant a REAL temp symlink as an ancestor and
 * assert each guard now REJECTS, while legitimate non-symlink paths and a
 * not-yet-existing leaf still resolve.
 *
 * The two guards under test here (`assertSkillDirectoryInsideRoot`,
 * `assertSkillFilePathInsideRoot`) live in skills-store.ts and pin their roots
 * from the DB config — mocked to ABSOLUTE temp paths so the guard canonicalizes
 * against a real on-disk root we control. The github.ts guard
 * (`assertWithinSkillsRoot`) is covered separately in
 * github-guard-symlink-containment.test.ts (its module graph needs the full DB
 * chain, so that suite mocks ./skills-store instead of loading it).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// One temp tree shared by every guard: a legacy root, a store root, and an
// "outside" directory the symlink ancestors point at. Created BEFORE the module
// mocks resolve so realpath() of the roots succeeds.
const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-symlink-guard-"));
const legacyRoot = path.join(tmpBase, "data", "skills");
const storeRoot = path.join(tmpBase, "data", "skill-store");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(legacyRoot, { recursive: true });
mkdirSync(storeRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
// Realpath the roots up front — on macOS /tmp is itself a symlink to
// /private/tmp, so the guards' canonicalized root is the realpath. Compare
// expectations against the realpath'd roots.
const realLegacyRoot = realpathSync.native(legacyRoot);
const realStoreRoot = realpathSync.native(storeRoot);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Capture the catalog written by upsertRepositoryBackedSkillPackage so the
// leaf-confinement assertions below can inspect what content actually got
// ingested (a symlinked-out SKILL.md/README must never reach the catalog).
const { replaceSkillCatalogMock } = vi.hoisted(() => ({
  replaceSkillCatalogMock: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({
    dataPath: legacyRoot,
    storePath: storeRoot,
  })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
  replaceSkillCatalogInDatabase: replaceSkillCatalogMock,
  getPostgresConnectionString: vi.fn(() => ""),
  postgresSchema: "public",
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("./skill-packages", () => ({
  installedSkillPackages: [],
}));

vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

import {
  assertSkillDirectoryInsideRoot,
  assertSkillFilePathInsideRoot,
  getSkillsDataRootPath,
  getSkillStoreRootPath,
  upsertRepositoryBackedSkillPackage,
} from "./skills-store";

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("realpath/symlink containment (#300)", () => {
  it("sanity: the mocked roots resolve to our temp tree", () => {
    expect(path.resolve(getSkillsDataRootPath())).toBe(path.resolve(legacyRoot));
    expect(path.resolve(getSkillStoreRootPath())).toBe(path.resolve(storeRoot));
  });

  // -------------------------------------------------------------------------
  // assertSkillDirectoryInsideRoot (skills-store.ts)
  // -------------------------------------------------------------------------
  describe("assertSkillDirectoryInsideRoot", () => {
    it("accepts a legitimate non-symlink directory inside the legacy root", () => {
      const dir = path.join(legacyRoot, "workspace", "octo", "repo");
      mkdirSync(dir, { recursive: true });
      expect(assertSkillDirectoryInsideRoot(dir)).toBe(path.resolve(dir));
    });

    it("accepts a not-yet-existing leaf inside the store root (nearest-ancestor realpath)", () => {
      // The parent exists; the leaf does not. realpath of the missing leaf
      // would throw — the guard must resolve the nearest existing ancestor and
      // still accept.
      const parent = path.join(storeRoot, "workspace");
      mkdirSync(parent, { recursive: true });
      const missingLeaf = path.join(parent, "not-created-yet");
      expect(assertSkillDirectoryInsideRoot(missingLeaf)).toBe(path.resolve(missingLeaf));
    });

    it("REJECTS a path whose ANCESTOR is a symlink pointing outside the root", () => {
      // Plant <legacyRoot>/workspace/escape-link -> <outsideDir>. The lexical
      // check passes (the string is inside legacyRoot) but the real path is
      // <outsideDir>/child, outside the root.
      const linkParent = path.join(legacyRoot, "workspace");
      mkdirSync(linkParent, { recursive: true });
      const link = path.join(linkParent, "escape-link");
      try { rmSync(link, { force: true }); } catch { /* noop */ }
      symlinkSync(outsideDir, link, "dir");
      const target = path.join(link, "child"); // ancestor `link` escapes
      expect(() => assertSkillDirectoryInsideRoot(target)).toThrow(
        /outside the allowed skill roots/i,
      );
    });

    it("REJECTS the symlinked directory itself when it points outside", () => {
      const link = path.join(legacyRoot, "self-escape-link");
      try { rmSync(link, { force: true }); } catch { /* noop */ }
      symlinkSync(outsideDir, link, "dir");
      expect(() => assertSkillDirectoryInsideRoot(link)).toThrow(
        /outside the allowed skill roots/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // assertSkillFilePathInsideRoot (skills-store.ts — the pre-existing #291 guard)
  // -------------------------------------------------------------------------
  describe("assertSkillFilePathInsideRoot", () => {
    it("accepts a legitimate non-symlink file inside the store root", () => {
      const dir = path.join(storeRoot, "personal", "u1", "s1");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      writeFileSync(file, "x");
      expect(() => assertSkillFilePathInsideRoot(file)).not.toThrow();
    });

    it("accepts a not-yet-existing file inside the legacy root", () => {
      const dir = path.join(legacyRoot, "personal", "u2", "s2");
      mkdirSync(dir, { recursive: true });
      const missingFile = path.join(dir, "SKILL.md"); // not written
      expect(() => assertSkillFilePathInsideRoot(missingFile)).not.toThrow();
    });

    it("REJECTS a file whose ANCESTOR is a symlink pointing outside the root", () => {
      // Place a secret outside, then a symlinked ancestor inside legacyRoot.
      const secret = path.join(outsideDir, "secret.txt");
      writeFileSync(secret, "TOP SECRET");
      const link = path.join(legacyRoot, "file-escape-link");
      try { rmSync(link, { force: true }); } catch { /* noop */ }
      symlinkSync(outsideDir, link, "dir");
      const exfilPath = path.join(link, "secret.txt"); // resolves to outsideDir/secret.txt
      expect(() => assertSkillFilePathInsideRoot(exfilPath)).toThrow(
        /outside the allowed skill roots/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // File-LEAF confinement (the next layer beyond #300's directory containment).
  //
  // assertSkillDirectoryInsideRoot confines a repository/scan BASE directory,
  // but a confined directory can still hold a FILE that is a SYMLINK to outside
  // (e.g. `<repo>/README.md -> /outside/secret`, or `<skillDir>/SKILL.md`
  // symlinked out). The dir guards all pass for such a layout — the directory
  // itself is legitimately inside the root — yet `readFileSync` would follow the
  // file-symlink and ingest content from outside the skill roots.
  // upsertRepositoryBackedSkillPackage drives BOTH the README/LICENSE leaf reads
  // and (via collectSkillDirectories) the per-skill SKILL.md reads, so it is the
  // end-to-end harness for the leaf confinement.
  // -------------------------------------------------------------------------
  describe("file-leaf confinement (upsertRepositoryBackedSkillPackage)", () => {
    it("does NOT ingest a SKILL.md / README that is a file symlink to outside, while a real skill still ingests", async () => {
      replaceSkillCatalogMock.mockClear();

      // The outside secrets the symlinks point at.
      const outsideSkillMd = path.join(outsideDir, "leaked-SKILL.md");
      writeFileSync(outsideSkillMd, ["---", "name: leaked", "---", "TOP SECRET BODY"].join("\n"));
      const outsideReadme = path.join(outsideDir, "leaked-README.md");
      writeFileSync(outsideReadme, "TOP SECRET README");

      // A confined repository inside the store root.
      const repoDir = path.join(storeRoot, "workspace", "octo", "leaf-repo");
      mkdirSync(repoDir, { recursive: true });

      // README.md at the repo root is a file-symlink to the outside secret.
      const readmeLink = path.join(repoDir, "README.md");
      try { rmSync(readmeLink, { force: true }); } catch { /* noop */ }
      symlinkSync(outsideReadme, readmeLink, "file");

      // Malicious skill dir: legitimately inside the repo, but its SKILL.md is a
      // file-symlink to the outside secret.
      const evilSkillDir = path.join(repoDir, "evil-skill");
      mkdirSync(evilSkillDir, { recursive: true });
      const evilSkillMd = path.join(evilSkillDir, "SKILL.md");
      try { rmSync(evilSkillMd, { force: true }); } catch { /* noop */ }
      symlinkSync(outsideSkillMd, evilSkillMd, "file");

      // Legitimate skill dir: a real, non-symlink SKILL.md that must still ingest.
      const goodSkillDir = path.join(repoDir, "good-skill");
      mkdirSync(goodSkillDir, { recursive: true });
      writeFileSync(
        path.join(goodSkillDir, "SKILL.md"),
        ["---", "name: good-skill", "description: a real skill", "---", "REAL BODY"].join("\n"),
      );

      await upsertRepositoryBackedSkillPackage({
        packageId: "github:octo/leaf-repo",
        name: "Leaf Repo",
        slug: "leaf-repo",
        description: "leaf-confinement fixture",
        repositoryUrl: "https://github.com/octo/leaf-repo",
        repositoryPath: repoDir,
      });

      expect(replaceSkillCatalogMock).toHaveBeenCalledTimes(1);
      const written = replaceSkillCatalogMock.mock.calls[0][0] as {
        skillPackages: Array<{ readmeContent?: string }>;
        skills: Array<{ slug: string; content: string }>;
      };

      // The legitimate skill is ingested; the symlinked-out one is dropped.
      const ingestedSlugs = written.skills.map((s) => s.slug);
      expect(ingestedSlugs).toContain("good-skill");
      expect(ingestedSlugs).not.toContain("evil-skill");

      // No ingested content carries the outside secrets.
      expect(written.skills.every((s) => !s.content.includes("TOP SECRET"))).toBe(true);
      expect(
        written.skillPackages.every((p) => !(p.readmeContent ?? "").includes("TOP SECRET")),
      ).toBe(true);
    });
  });
});

// Reference the realpath'd roots so an unused-var lint never trips; they also
// document the macOS /tmp -> /private/tmp canonicalization the guards rely on.
void realLegacyRoot;
void realStoreRoot;
