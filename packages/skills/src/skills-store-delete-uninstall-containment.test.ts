/**
 * Realpath/symlink + root-equality containment for the DESTRUCTIVE delete and
 * uninstall paths (#300, round-4 hardening of the sinks codex flagged FIX-FIRST):
 *
 *   - deleteAgentSkillsForSlugs: rm'd `dirname(<stored sourcePath>)` after a
 *     LEXICAL-ONLY containment check, AND treated `resolvedSourcePath ===
 *     skillsRoot` as in-bounds — so `dirname(root)` (the root's PARENT) became
 *     the rm target. Both are now confined: STRICTLY-inside + realpath.
 *   - uninstallSkillPackage: readdir'd `<repositoryPath>/agents` and rm'd
 *     `repositoryPath` (both STORED, unconfined). Both now require the stored
 *     repo path STRICTLY inside the installed-packages root + realpath-confined.
 *
 * These tests SPY on `fs/promises.rm` so we can assert exactly which paths the
 * code attempted to remove. Each malicious fixture plants a real on-disk
 * symlink (or sets `sourcePath === root`) and asserts the escaping path is
 * NEVER handed to `rm`, while a legitimate inside-root path still IS — proving
 * revert-sensitivity (the pre-fix code would `rm` the escaping/parent path).
 *
 * The DB chain is mocked exactly like skills-guard-symlink-containment.test.ts;
 * the catalog read is fed crafted "agent" rows via readSkillCatalogFromDatabase
 * (they survive `syncInstalledSkillsToDatabase` because they are `isCustom`).
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-del-uninstall-guard-"));
const legacyRoot = path.join(tmpBase, "data", "skills");
const storeRoot = path.join(tmpBase, "data", "skill-store");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(legacyRoot, { recursive: true });
mkdirSync(storeRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
const realLegacyRoot = realpathSync.native(legacyRoot);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mutable catalog the mocked DB read returns. Tests set it per-case.
const dbCatalog: { skillPackages: unknown[]; skills: unknown[] } = {
  skillPackages: [],
  skills: [],
};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({
    dataPath: legacyRoot,
    storePath: storeRoot,
  })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => dbCatalog),
  replaceSkillCatalogInDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => ""),
  postgresSchema: "public",
  deleteCustomSkillAssignment: vi.fn(),
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

// The package vitest config aliases bare `@cinatra-ai/extensions` to its
// index.ts, which mangles the `/permissions-store` SUBPATH the SUT
// dynamic-imports (-> `index.ts/permissions-store`, ENOTDIR). Mock the real
// source file by absolute path so the dynamic import resolves to our stub
// regardless of the alias. The path is built in a hoisted block because the
// `vi.mock` ARGUMENT is evaluated at hoist time (before the `import path` runs).
// The config now aliases this subpath to the real source file (mirroring the
// app/tsgo tsconfig path). Mock it so `uninstallSkillPackage`'s dynamic
// `import("@cinatra-ai/extensions/permissions-store")` resolves to a no-op stub
// (no DB). Mock the real resolved file by absolute path so the dynamic import
// hits the stub regardless of how the specifier is rewritten.
const { permissionsStorePath } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    permissionsStorePath: nodePath.resolve(
      __dirname,
      "../../extensions/src/permissions-store.ts",
    ),
  };
});
vi.mock(permissionsStorePath, () => ({
  deleteExtensionPermissions: vi.fn(async () => undefined),
}));

// Spy on rm while keeping the real fs/promises surface. The `rm` spy is a
// no-op so the suite never actually deletes anything — we assert on its calls.
// Hoisted so the `vi.mock` factory (itself hoisted to file top) can reference it.
const { rmSpy } = vi.hoisted(() => ({
  // Typed to accept the `rm(path, options)` arg shape so `.mock.calls[i][0]`
  // (the removed path) is statically indexable under tsgo.
  rmSpy: vi.fn(async (_target: unknown, _options?: unknown) => undefined),
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rm: rmSpy };
});

// Disable the one-time GitHub auto-sync so syncInstalledSkillsToDatabase stays
// purely local (no network) for these tests.
vi.mock("./github", () => ({
  ensureConfiguredRepositorySynced: vi.fn(async () => undefined),
}));

import {
  deleteAgentSkillsForSlugs,
  uninstallSkillPackage,
  getSkillsDataRootPath,
} from "./skills-store";

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

beforeEach(() => {
  rmSpy.mockClear();
  dbCatalog.skillPackages = [];
  dbCatalog.skills = [];
});

// Helper to build a minimal valid stored "agent" skill row.
function agentSkillRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "custom:evil-pkg:s1",
    slug: "s1",
    name: "S1",
    description: "d",
    content: "c",
    packageId: "custom:evil-pkg",
    packageName: "Evil Pkg",
    packageSlug: "evil-pkg",
    level: "agent",
    isCustom: true,
    ...over,
  };
}

describe("deleteAgentSkillsForSlugs disk-cleanup containment (#300)", () => {
  it("sanity: roots resolve to the temp tree", () => {
    expect(path.resolve(getSkillsDataRootPath())).toBe(path.resolve(legacyRoot));
  });

  it("rm's a legitimate per-skill dir STRICTLY inside the root", async () => {
    // <legacyRoot>/~agent/evil-pkg/s1/SKILL.md -> dir to rm is the s1 dir.
    const skillDir = path.join(legacyRoot, "~agent", "evil-pkg", "s1");
    mkdirSync(skillDir, { recursive: true });
    const sourcePath = path.join(skillDir, "SKILL.md");
    writeFileSync(sourcePath, "x");
    dbCatalog.skills = [agentSkillRow({ sourcePath })];

    const result = await deleteAgentSkillsForSlugs(["evil-pkg"]);
    expect(result.deletedIds).toContain("custom:evil-pkg:s1");

    // The s1 dir was the rm target; no rm touched anything outside the root.
    const rmTargets = rmSpy.mock.calls.map((c) => path.resolve(String(c[0])));
    expect(rmTargets).toContain(path.resolve(skillDir));
    for (const target of rmTargets) {
      expect(
        target.startsWith(realLegacyRoot + path.sep) ||
          path.resolve(target).startsWith(path.resolve(legacyRoot) + path.sep),
      ).toBe(true);
    }
  });

  it("REJECTS the root-equality case — never rm's the root's PARENT", async () => {
    // sourcePath === skillsRoot. Pre-fix: dirname(root) === parent(root) was
    // rm'd. The fix requires STRICTLY-inside, so this skill contributes NO rm.
    dbCatalog.skills = [agentSkillRow({ sourcePath: legacyRoot })];

    await deleteAgentSkillsForSlugs(["evil-pkg"]);

    const parentOfRoot = path.dirname(path.resolve(legacyRoot));
    const rmTargets = rmSpy.mock.calls.map((c) => path.resolve(String(c[0])));
    // The parent-of-root (the catastrophic pre-fix target) is NEVER rm'd.
    expect(rmTargets).not.toContain(parentOfRoot);
    // Nor is the root itself.
    expect(rmTargets).not.toContain(path.resolve(legacyRoot));
  });

  it("REJECTS a sourcePath that resolves OUT of the root via a symlinked ancestor", async () => {
    // <legacyRoot>/~agent/escape -> <outsideDir>. sourcePath lexically inside
    // the root but real path is <outsideDir>/s2/SKILL.md (outside).
    const linkParent = path.join(legacyRoot, "~agent");
    mkdirSync(linkParent, { recursive: true });
    const link = path.join(linkParent, "escape");
    try { rmSync(link, { force: true }); } catch { /* noop */ }
    symlinkSync(outsideDir, link, "dir");
    // Materialize the outside target so dirname/rm would have a real victim.
    const outsideSkillDir = path.join(outsideDir, "s2");
    mkdirSync(outsideSkillDir, { recursive: true });
    const sourcePath = path.join(link, "s2", "SKILL.md"); // resolves outside

    dbCatalog.skills = [agentSkillRow({ sourcePath })];

    await deleteAgentSkillsForSlugs(["evil-pkg"]);

    // The escaping (outside) skill dir is NEVER handed to rm.
    const rmTargets = rmSpy.mock.calls.map((c) => realpathSync.native(path.resolve(String(c[0]))));
    expect(rmTargets).not.toContain(realpathSync.native(outsideSkillDir));
    // And nothing under outsideDir is rm'd.
    const realOutside = realpathSync.native(outsideDir);
    for (const target of rmTargets) {
      expect(target.startsWith(realOutside + path.sep) || target === realOutside).toBe(false);
    }
  });
});

describe("uninstallSkillPackage disk-cleanup containment (#300)", () => {
  it("rm's a legitimate repositoryPath STRICTLY inside the installed root", async () => {
    const repoDir = path.join(legacyRoot, "workspace", "octo", "good-repo");
    mkdirSync(repoDir, { recursive: true });
    dbCatalog.skillPackages = [
      { id: "github:octo/good-repo", packageId: "github:octo/good-repo", name: "Good", slug: "good-repo", description: "d", isCustom: true, repositoryPath: repoDir },
    ];

    const ok = await uninstallSkillPackage("github:octo/good-repo");
    expect(ok).not.toBe(false);

    const rmTargets = rmSpy.mock.calls.map((c) => path.resolve(String(c[0])));
    expect(rmTargets).toContain(path.resolve(repoDir));
  });

  it("REJECTS a repositoryPath resolving OUT of the root via a symlinked ancestor — no rm/read outside", async () => {
    // <legacyRoot>/workspace/uninstall-escape -> <outsideDir>; repositoryPath
    // lexically inside but real path <outsideDir>/evil-repo (outside).
    const wsDir = path.join(legacyRoot, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const link = path.join(wsDir, "uninstall-escape");
    try { rmSync(link, { recursive: true, force: true }); } catch { /* noop */ }
    symlinkSync(outsideDir, link, "dir");

    const outsideRepo = path.join(outsideDir, "evil-repo");
    mkdirSync(path.join(outsideRepo, "agents", "victim-agent"), { recursive: true });
    const repoDir = path.join(link, "evil-repo"); // resolves to outsideRepo

    dbCatalog.skillPackages = [
      { id: "github:octo/evil-repo", packageId: "github:octo/evil-repo", name: "Evil", slug: "evil-repo", description: "d", isCustom: true, repositoryPath: repoDir },
    ];

    const ok = await uninstallSkillPackage("github:octo/evil-repo");
    // The DB rows are still removed (catalog rewrite always runs); only the
    // disk rm/read is skipped on escape.
    expect(ok).not.toBe(false);

    // The escaping repo is NEVER rm'd.
    const realOutsideRepo = realpathSync.native(outsideRepo);
    const rmTargets = rmSpy.mock.calls.map((c) => realpathSync.native(path.resolve(String(c[0]))));
    expect(rmTargets).not.toContain(realOutsideRepo);
    // And nothing under outsideDir is rm'd at all.
    const realOutside = realpathSync.native(outsideDir);
    for (const target of rmTargets) {
      expect(target.startsWith(realOutside + path.sep) || target === realOutside).toBe(false);
    }
    // The outside agents/ directory still exists (was never enumerated-then-rm'd).
    expect(existsSync(path.join(outsideRepo, "agents", "victim-agent"))).toBe(true);
  });
});

// Reference realpath'd root so an unused-var lint never trips.
void realLegacyRoot;
