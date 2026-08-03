/**
 * ORDERING PIN (cinatra#2350 S5, epic #2345): `uninstallSkillPackage` sweeps
 * direct skill assignments BEFORE its missing-native-package early return.
 *
 * This is the whole point of the issue's scope item 1. `uninstallSkillPackage`
 * returns `false` when no NATIVE `skill_packages` catalog row carries the
 * persisted package id — and a VIRTUAL-namespace registration is exactly the
 * shape that can have no such row. A sweep ordered after that return (or merely
 * "before the catalog rewrite") would skip precisely the packages whose
 * assignment rows carry ids nothing else can derive.
 *
 * The suite drives the REAL `uninstallSkillPackage` and the REAL teardown; only
 * the leaf reads/writes are doubled (the extension scan, the assignment store,
 * the lifecycle lock, the catalog DB). A revert of the ordering — moving the
 * teardown below `if (!existingPackage) return false` — turns the first two
 * tests red.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { scanned, deletedBatches, lockKeys, removedRows } = vi.hoisted(() => ({
  scanned: [] as Array<Record<string, unknown>>,
  deletedBatches: [] as string[][],
  lockKeys: [] as string[],
  removedRows: [] as Array<{ agentPackageName: string; skillId: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The catalog the SUT reads. Deliberately EMPTY in the early-return arms.
const dbCatalog: { skillPackages: unknown[]; skills: unknown[] } = {
  skillPackages: [],
  skills: [],
};

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return {
    ...actual,
    readConnectorConfigFromDatabase: vi.fn(() => ({ dataPath: "", storePath: "" })),
    writeConnectorConfigToDatabase: vi.fn(),
    readSkillCatalogFromDatabase: vi.fn(() => dbCatalog),
    replaceSkillCatalogInDatabase: vi.fn(),
    getPostgresConnectionString: vi.fn(() => ""),
    postgresSchema: "public",
    deleteCustomSkillAssignment: vi.fn(),
  };
});
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("./github", () => ({
  ensureConfiguredRepositorySynced: vi.fn(async () => undefined),
}));
vi.mock("./skill-packages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-packages")>();
  return { ...actual, installedSkillPackages: [] };
});
vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

// The ONE I/O seam the teardown's derivation reads.
vi.mock("./agent-skill-assignment-sources", () => ({
  readCatalogSource: async () => ({ skills: [] }),
  readCatalogSnapshotSource: async () => ({ skills: [] }),
  scanExtensionsSource: async () => scanned,
  readInstallStatusSource: async () => new Map(),
  readAgentPopulationSource: async () => [],
  readPackageKindSource: async () => null,
  isAssistantPackageSource: async () => false,
}));

vi.mock("@/lib/agent-assigned-skills-store", () => ({
  deleteAssignedSkillsForSkillIds: vi.fn(async (ids: string[]) => {
    deletedBatches.push([...ids]);
    return { removed: removedRows.filter((r) => ids.includes(r.skillId)) };
  }),
  deleteAssignedSkillsForAgentPackage: vi.fn(async () => ({ removed: [] })),
}));

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: vi.fn(async (packageName: string, fn: () => Promise<unknown>) => {
    lockKeys.push(packageName);
    try {
      return await fn();
    } finally {
      lockKeys.push(`unlock:${packageName}`);
    }
  }),
}));

const { permissionsStorePath } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    permissionsStorePath: nodePath.resolve(__dirname, "../../extensions/src/permissions-store.ts"),
  };
});
vi.mock(permissionsStorePath, () => ({
  deleteExtensionPermissions: vi.fn(async () => undefined),
}));

import { uninstallSkillPackage } from "./skills-store";

const NATIVE_PKG = "@cinatra-ai/list-curation-skill";
const SUCCESSOR_PKG = "@cinatra-ai/company-research-skill";

beforeEach(() => {
  vi.clearAllMocks();
  scanned.length = 0;
  deletedBatches.length = 0;
  lockKeys.length = 0;
  removedRows.length = 0;
  dbCatalog.skillPackages = [];
  dbCatalog.skills = [];
});

describe("uninstallSkillPackage — assignment teardown ordering (cinatra#2350)", () => {
  it("sweeps assignments even when NO native catalog package matches (the early return)", async () => {
    scanned.push({
      pkgDir: "/x",
      pkgName: SUCCESSOR_PKG,
      pkgDirName: "company-research-skill",
      kind: "skill",
      dependencies: [],
      capabilities: {},
      slugs: ["company-research"],
    });
    removedRows.push({
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      skillId: "@cinatra-ai/chat:company-research",
    });

    // No `skill_packages` row for this id at all — the uninstall's own early
    // return fires…
    const returned = await uninstallSkillPackage(`verdaccio:${SUCCESSOR_PKG}`);
    expect(returned).toBe(false);

    // …and the sweep STILL ran, on the VIRTUAL derived id, under the owning
    // package's lifecycle lock.
    expect(deletedBatches).toEqual([["@cinatra-ai/chat:company-research"]]);
    // …and the lock spans the WHOLE uninstall, not just the delete: the release
    // marker is the LAST thing that happens.
    expect(lockKeys).toEqual([SUCCESSOR_PKG, `unlock:${SUCCESSOR_PKG}`]);
  });

  it("sweeps a NATIVE package's derived ids on a normal uninstall too", async () => {
    scanned.push({
      pkgDir: "/x",
      pkgName: NATIVE_PKG,
      pkgDirName: "list-curation-skill",
      kind: "skill",
      dependencies: [],
      capabilities: {},
      slugs: ["list-curation", "list-scoring"],
    });
    dbCatalog.skillPackages = [
      {
        id: `verdaccio:${NATIVE_PKG}`,
        packageId: `verdaccio:${NATIVE_PKG}`,
        name: "List Curation",
        slug: "list-curation-skill",
        description: "",
        isCustom: true,
      },
    ];

    const returned = await uninstallSkillPackage(`verdaccio:${NATIVE_PKG}`);
    expect(returned).toBe(true);
    expect(deletedBatches).toHaveLength(1);
    expect([...(deletedBatches[0] ?? [])].sort()).toEqual([
      `${NATIVE_PKG}:list-curation`,
      `${NATIVE_PKG}:list-scoring`,
    ]);
    expect(lockKeys).toEqual([NATIVE_PKG, `unlock:${NATIVE_PKG}`]);
  });

  it("ABORTS the uninstall when the sweep fails — nothing destructive has run yet", async () => {
    scanned.push({
      pkgDir: "/x",
      pkgName: NATIVE_PKG,
      pkgDirName: "list-curation-skill",
      kind: "skill",
      dependencies: [],
      capabilities: {},
      slugs: ["list-curation"],
    });
    dbCatalog.skillPackages = [
      {
        id: `verdaccio:${NATIVE_PKG}`,
        packageId: `verdaccio:${NATIVE_PKG}`,
        name: "n",
        slug: "s",
        description: "",
        isCustom: true,
      },
    ];
    const store = await import("@/lib/agent-assigned-skills-store");
    vi.mocked(store.deleteAssignedSkillsForSkillIds).mockRejectedValueOnce(new Error("db down"));

    await expect(uninstallSkillPackage(`verdaccio:${NATIVE_PKG}`)).rejects.toThrow(/db down/);

    // The uninstall never even READ the catalog, let alone rewrote it or
    // touched the disk: a half-uninstalled package with live assignment rows is
    // exactly the orphan-reapply state the sweep exists to prevent, and the
    // sweep is ordered ahead of every step that could produce it.
    const db = await import("@/lib/database");
    expect(vi.mocked(db.readSkillCatalogFromDatabase)).not.toHaveBeenCalled();
    expect(vi.mocked(db.replaceSkillCatalogInDatabase)).not.toHaveBeenCalled();
  });

  it("issues NO delete for a package that owns no scanned skills", async () => {
    scanned.push({
      pkgDir: "/x",
      pkgName: "@other/unrelated-skill",
      pkgDirName: "unrelated-skill",
      kind: "skill",
      dependencies: [],
      capabilities: {},
      slugs: ["nope"],
    });
    await uninstallSkillPackage(`verdaccio:${NATIVE_PKG}`);
    expect(deletedBatches).toEqual([]);
    // The lock is still taken — scan and derivation live INSIDE it (codex round
    // 2), so "owns nothing" is a conclusion reached under serialization rather
    // than a reason to skip it.
    expect(lockKeys).toEqual([NATIVE_PKG, `unlock:${NATIVE_PKG}`]);
  });
});

describe("REINSTALL-NO-RESURRECTION — skill side (cinatra#2350 scope item 3)", () => {
  it("a reinstall of the same package does NOT bring the swept assignments back", async () => {
    const descriptor = {
      pkgDir: "/x",
      pkgName: NATIVE_PKG,
      pkgDirName: "list-curation-skill",
      kind: "skill",
      dependencies: [],
      capabilities: {},
      slugs: ["list-curation"],
    };
    scanned.push(descriptor);
    dbCatalog.skillPackages = [
      {
        id: `verdaccio:${NATIVE_PKG}`,
        packageId: `verdaccio:${NATIVE_PKG}`,
        name: "n",
        slug: "s",
        description: "",
        isCustom: true,
      },
    ];
    removedRows.push({
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      skillId: `${NATIVE_PKG}:list-curation`,
    });

    // 1. Uninstall sweeps the row.
    await uninstallSkillPackage(`verdaccio:${NATIVE_PKG}`);
    expect(deletedBatches).toEqual([[`${NATIVE_PKG}:list-curation`]]);

    // 2. REINSTALL: the package is back on disk with the SAME derived ids and a
    //    fresh catalog row. Nothing on the install path writes assignment rows —
    //    the store's only writer is the admin's assign action — so the second
    //    uninstall finds nothing to sweep. That is the property: the row is gone
    //    for good, not resurrected by re-deriving the same id.
    removedRows.length = 0;
    deletedBatches.length = 0;
    dbCatalog.skillPackages = [
      {
        id: `verdaccio:${NATIVE_PKG}`,
        packageId: `verdaccio:${NATIVE_PKG}`,
        name: "n",
        slug: "s",
        description: "",
        isCustom: true,
      },
    ];

    await uninstallSkillPackage(`verdaccio:${NATIVE_PKG}`);
    expect(deletedBatches).toEqual([[`${NATIVE_PKG}:list-curation`]]);
    // The second sweep removed NOTHING — the store reported no rows.
    const store = await import("@/lib/agent-assigned-skills-store");
    const results = vi.mocked(store.deleteAssignedSkillsForSkillIds).mock.results;
    const last = results[results.length - 1];
    await expect(last?.value).resolves.toEqual({ removed: [] });
  });
});
