/**
 * Verdaccio install-dir version-segment traversal containment (#300).
 *
 * `persistInstallDir(packageName, version)` composes
 * `<dataRoot>/_verdaccio-installs/<name-slug>/<version>`. The `version` segment
 * flowed in VERBATIM: `path.join` collapses a `../../escape` version into a
 * path that still resolves UNDER the skills data root but OUTSIDE the verdaccio
 * install subroot — so the destructive `rmSync`/`renameSync` downstream could
 * clobber an arbitrary `data/skills` descendant (e.g. another package's
 * install). The fix slugifies the version with the name's charset, collapses a
 * dots-only segment, and asserts the resolved dir is STRICTLY inside the
 * `_verdaccio-installs` subroot.
 *
 * `persistInstallDir` is a pure path fn (no fs/network); we mock the registry
 * + DB import chain so the module loads, then exercise it directly. Legitimate
 * semver (dotted) must still be accepted; a traversing version must throw OR be
 * neutralized to stay strictly inside the subroot.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

// Absolute temp roots so the guard canonicalizes against an on-disk tree we
// control (lets us plant a symlinked ancestor under _verdaccio-installs).
const tmpBase = mkdtempSync(path.join(os.tmpdir(), "cinatra-verdaccio-guard-"));
const dataRoot = path.join(tmpBase, "data", "skills");
const storeRoot = path.join(tmpBase, "data", "skill-store");
const outsideDir = path.join(tmpBase, "outside");
mkdirSync(dataRoot, { recursive: true });
mkdirSync(storeRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@cinatra-ai/registries", () => ({
  extractExtensionPackage: vi.fn(),
  loadVerdaccioConfig: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({
    dataPath: dataRoot,
    storePath: storeRoot,
  })),
  writeConnectorConfigToDatabase: vi.fn(),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skillPackages: [], skills: [] })),
  replaceSkillCatalogInDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => ""),
  postgresSchema: "public",
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(),
}));

vi.mock("./skill-packages", () => ({ installedSkillPackages: [] }));
vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

import { persistInstallDir } from "./verdaccio";
import { getSkillsDataRootPath } from "./skills-store";

const subroot = () => path.resolve(getSkillsDataRootPath(), "_verdaccio-installs");

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

describe("persistInstallDir version-segment containment (#300)", () => {
  it("sanity: the mocked data root resolves to our temp tree", () => {
    expect(path.resolve(getSkillsDataRootPath())).toBe(path.resolve(dataRoot));
  });

  it("keeps a legitimate dotted semver version strictly inside the install subroot", () => {
    const dir = persistInstallDir("@anthropics/skills", "1.0.0");
    expect(path.resolve(dir)).toBe(path.join(subroot(), "anthropics_skills", "1.0.0"));
    expect(path.resolve(dir).startsWith(subroot() + path.sep)).toBe(true);
  });

  it("neutralizes a `../../escape` version so the dir stays STRICTLY inside the subroot (no intra-root traversal)", () => {
    // Pre-fix: path.join collapses the `..` and the dir escapes the subroot
    // into an arbitrary data/skills descendant. Post-fix: the version is
    // slugified into a SINGLE segment (separators -> `_`) so no traversal
    // survives, and the strict-subroot assertion would throw otherwise.
    const dir = persistInstallDir("@anthropics/skills", "../../escape");
    const resolved = path.resolve(dir);
    // Stays strictly inside the verdaccio subroot.
    expect(resolved.startsWith(subroot() + path.sep)).toBe(true);
    // The collapsed escape target (a sibling under data/skills) is NOT the result.
    const escapeTarget = path.resolve(subroot(), "anthropics_skills", "..", "..", "escape");
    expect(resolved).not.toBe(escapeTarget);
    // The version is a SINGLE path segment under <subroot>/<name>/ — the
    // security property is "no separator survives", not "no literal `..`
    // substring" (a `..` inside one segment is a harmless directory name).
    const relFromSubroot = path.relative(subroot(), resolved);
    expect(relFromSubroot.split(path.sep).length).toBe(2); // <name>/<version>
  });

  it("neutralizes a dots-only version segment (never the subroot itself or its parent)", () => {
    // `..` alone would be a pure traversal; the slugify collapses it to `_`.
    const dir = persistInstallDir("@anthropics/skills", "..");
    const resolved = path.resolve(dir);
    expect(resolved.startsWith(subroot() + path.sep)).toBe(true);
    expect(resolved).not.toBe(path.resolve(subroot()));
    expect(path.basename(resolved)).not.toBe("..");
  });

  it("neutralizes a version carrying a path separator into one confined segment", () => {
    const dir = persistInstallDir("@anthropics/skills", "1.0.0/../../etc");
    const resolved = path.resolve(dir);
    expect(resolved.startsWith(subroot() + path.sep)).toBe(true);
    // No separator survives in the version segment → cannot traverse.
    const relFromSubroot = path.relative(subroot(), resolved);
    expect(relFromSubroot.split(path.sep).length).toBe(2);
  });

  it("REJECTS when the package-name dir under the subroot is a SYMLINK resolving into another data/skills subtree", () => {
    // Plant <subroot>/anthropics_skills -> <outsideDir> (an out-of-subroot
    // target). The composed dir <subroot>/anthropics_skills/1.0.0 passes the
    // lexical strict-subroot prefix check, but its REAL path is
    // <outsideDir>/1.0.0 — the realpath layer must reject so the destructive
    // rmSync/renameSync can't clobber the symlink target.
    mkdirSync(subroot(), { recursive: true });
    const nameLink = path.join(subroot(), "anthropics_skills");
    try { rmSync(nameLink, { recursive: true, force: true }); } catch { /* noop */ }
    symlinkSync(outsideDir, nameLink, "dir");

    expect(() => persistInstallDir("@anthropics/skills", "1.0.0")).toThrow(
      /escapes the verdaccio install subroot/i,
    );

    // Restore a real dir so other tests are unaffected.
    rmSync(nameLink, { recursive: true, force: true });
    mkdirSync(nameLink, { recursive: true });
  });
});

// Reference realpath so an unused-import lint never trips.
void realpathSync;
