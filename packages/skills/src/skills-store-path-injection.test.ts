/**
 * Path-injection containment tests for the skill-store read/scan sinks
 * (js/path-injection, code-scanning).
 *
 * These exercise the fail-closed directory barrier added alongside the #291
 * write-side guard: `assertSkillDirectoryInsideRoot` confines any externally-
 * supplied repository/scan BASE directory to the canonical skill-store root or
 * the legacy `data/skills` root before any `existsSync`/`readdirSync`/
 * `readFileSync` walks it. Both `upsertRepositoryBackedSkillPackage` and
 * `collectSkillDirectories` route their base through this guard.
 *
 * The full skills-store import chain (DB/LLM/postgres/git) is mocked so the
 * test process loads the module without real infrastructure. The DB config
 * mock pins the two roots so containment can be asserted deterministically.
 */
import { describe, it, expect, vi } from "vitest";
import path from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Pin the configured skill roots: dataPath (legacy) + storePath (canonical).
// getSkillsDataRootPath()/getSkillStoreRootPath() join these against cwd when
// relative, so the resolved roots are <cwd>/data/skills and <cwd>/data/skill-store.
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({
    dataPath: "data/skills",
    storePath: "data/skill-store",
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

vi.mock("./skill-packages", () => ({
  installedSkillPackages: [],
}));

vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

import {
  assertSkillDirectoryInsideRoot,
  getSkillsDataRootPath,
  getSkillStoreRootPath,
} from "./skills-store";

describe("assertSkillDirectoryInsideRoot (js/path-injection containment)", () => {
  it("accepts the canonical store root itself", () => {
    const storeRoot = getSkillStoreRootPath();
    expect(assertSkillDirectoryInsideRoot(storeRoot)).toBe(path.resolve(storeRoot));
  });

  it("accepts the legacy data root itself", () => {
    const legacyRoot = getSkillsDataRootPath();
    expect(assertSkillDirectoryInsideRoot(legacyRoot)).toBe(path.resolve(legacyRoot));
  });

  it("accepts a legitimate workspace/<owner>/<repo> directory inside the legacy root", () => {
    const legacyRoot = getSkillsDataRootPath();
    const dir = path.join(legacyRoot, "workspace", "octo-org", "my.repo_name-2");
    expect(assertSkillDirectoryInsideRoot(dir)).toBe(path.resolve(dir));
  });

  it("accepts a verdaccio installDir leaf with a dotted version segment", () => {
    // persistInstallDir keeps `.` in the version segment; a legitimate
    // `1.0.0` version is NOT a traversal and must still resolve.
    const legacyRoot = getSkillsDataRootPath();
    const dir = path.join(legacyRoot, "_verdaccio-installs", "anthropics_skills", "1.0.0");
    expect(assertSkillDirectoryInsideRoot(dir)).toBe(path.resolve(dir));
  });

  it("rejects a raw '..' traversal segment in the supplied directory string", () => {
    // The input arrives as a raw (un-normalized) string — the dot-segment
    // layer rejects it BEFORE path.resolve could collapse it. Use string
    // concatenation (not path.join, which would normalize away the `..`).
    const legacyRoot = getSkillsDataRootPath();
    expect(() =>
      assertSkillDirectoryInsideRoot(`${legacyRoot}/workspace/../../evil`),
    ).toThrow(/traversal segment/i);
  });

  it("rejects a raw single-dot segment in the supplied directory string", () => {
    // A raw "/./" segment is a traversal-class marker we fail closed on.
    const legacyRoot = getSkillsDataRootPath();
    expect(() =>
      assertSkillDirectoryInsideRoot(`${legacyRoot}/./escape`),
    ).toThrow(/traversal segment/i);
  });

  it("rejects a backslash (Windows-style) '..' traversal segment", () => {
    const legacyRoot = getSkillsDataRootPath();
    expect(() =>
      assertSkillDirectoryInsideRoot(`${legacyRoot}\\..\\evil`),
    ).toThrow(/traversal segment/i);
  });

  it("rejects a normalized escape that resolves outside both roots", () => {
    // When the `..` is already collapsed by path.join, the dot-segment layer
    // does not see it — the resolve+containment layer is the backstop and
    // still rejects (fail-closed). This proves the second layer independently.
    const legacyRoot = getSkillsDataRootPath();
    expect(() =>
      assertSkillDirectoryInsideRoot(path.join(legacyRoot, "workspace", "..", "..", "..", "etc")),
    ).toThrow(/outside the allowed skill roots/i);
  });

  it("rejects an absolute path entirely outside both skill roots", () => {
    expect(() => assertSkillDirectoryInsideRoot("/etc")).toThrow(
      /outside the allowed skill roots/i,
    );
  });

  it("rejects a sibling directory that shares the root prefix but is not inside it", () => {
    // `<storeRoot>-evil` shares the string prefix but is a sibling, not a
    // child — the `+ path.sep` containment check must reject it.
    const storeRoot = getSkillStoreRootPath();
    expect(() => assertSkillDirectoryInsideRoot(`${storeRoot}-evil`)).toThrow(
      /outside the allowed skill roots/i,
    );
  });
});
