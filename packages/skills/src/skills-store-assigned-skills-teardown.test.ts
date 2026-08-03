/**
 * `agent_assigned_skills` lifecycle teardown (cinatra#2350 S5, epic #2345),
 * folded into `skills-store.ts` (route-graph ratchet — see the module-level
 * comment above `sweepAssignedSkillsForSkillPackageId` in that file for why).
 *
 * Three concerns, one file (shares the mock scaffold `skills-store.ts`
 * requires to load at all — mirrors
 * `skills-store-delete-uninstall-containment.test.ts`):
 *
 *   1. Pure logic (`deriveOwnedAssignedSkillIds` / `sweepAssignedSkillsFor-
 *      SkillPackageId`), driven entirely through injected `deps` — no real
 *      filesystem scan, no real DB.
 *   2. DEFAULT dependency wiring — that calling with NO `deps` reaches the
 *      REAL `./extension-skill-resolver` scan/derive and the REAL
 *      `@/lib/agent-assigned-skills-store` deletes.
 *   3. `uninstallSkillPackage`'s ORDERING integration: the sweep runs BEFORE
 *      the missing-native-package early return, not merely before the
 *      catalog rewrite.
 *
 * The DB-integration proof (real Postgres, the store's bulk deletes actually
 * emptying the table) lives in
 * `src/lib/__tests__/agent-assigned-skills-teardown.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mutable catalog the mocked DB read returns. Only the ordering suite (§3)
// touches this.
const dbCatalog: { skillPackages: unknown[]; skills: unknown[] } = {
  skillPackages: [],
  skills: [],
};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => ({ dataPath: "/tmp/none", storePath: "/tmp/none2" })),
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

vi.mock("./skill-packages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill-packages")>();
  return { ...actual, installedSkillPackages: [] };
});

vi.mock("./storage/git-commit", () => ({
  commitSkillChange: vi.fn(async () => undefined),
}));

vi.mock("./github", () => ({
  ensureConfiguredRepositorySynced: vi.fn(async () => undefined),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rm: vi.fn(async () => undefined) };
});

// The package vitest config aliases `@cinatra-ai/extensions` to its index.ts,
// which mangles the `/permissions-store` subpath the SUT dynamic-imports.
// Mock the real source file by absolute path (mirrors
// skills-store-delete-uninstall-containment.test.ts).
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

// `./extension-skill-resolver` — real for NOTHING in this file: §1's tests
// pass explicit deps (never reach the dynamic import), §2 pins the default
// binding against it, and §3 uses it to control whether the sweep finds any
// owned ids (never a real filesystem walk / real `@cinatra-ai/agents` module
// graph in a unit test).
const mocks = vi.hoisted(() => ({
  scanSkillExtensions: vi.fn(),
  deriveSkillRegistration: vi.fn(),
  deleteAssignedSkillsForSkillIds: vi.fn(),
  deleteAssignedSkillsForAgentPackage: vi.fn(),
}));
vi.mock("./extension-skill-resolver", () => ({
  scanSkillExtensions: mocks.scanSkillExtensions,
  deriveSkillRegistration: mocks.deriveSkillRegistration,
}));
vi.mock("@/lib/agent-assigned-skills-store", () => ({
  deleteAssignedSkillsForSkillIds: mocks.deleteAssignedSkillsForSkillIds,
  deleteAssignedSkillsForAgentPackage: mocks.deleteAssignedSkillsForAgentPackage,
}));

import {
  deriveOwnedAssignedSkillIds,
  sweepAssignedSkillsForSkillPackageId,
  deleteAssignedSkillsForAgentPackage,
  uninstallSkillPackage,
  type SkillPackageTeardownDeps,
} from "./skills-store";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";

beforeEach(() => {
  mocks.scanSkillExtensions.mockReset();
  mocks.deriveSkillRegistration.mockReset();
  mocks.deleteAssignedSkillsForSkillIds.mockReset();
  mocks.deleteAssignedSkillsForAgentPackage.mockReset();
  dbCatalog.skillPackages = [];
  dbCatalog.skills = [];
});

function descriptor(over: Partial<SkillExtensionDescriptor> = {}): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: "@vendor/pkg",
    pkgDirName: "pkg",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["s1", "s2"],
    ...over,
  };
}

const identityDerive = (pkgName: string, _dir: string, slug: string) => ({
  packageName: pkgName,
  skillId: `${pkgName}:${slug}`,
});

// =============================================================================
// §1 — pure logic, injected deps
// =============================================================================

describe("deriveOwnedAssignedSkillIds", () => {
  function deps(over: Partial<SkillPackageTeardownDeps> = {}): SkillPackageTeardownDeps {
    return {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
      ...over,
    };
  }

  it("derives the exact catalog id for every slug this package owns", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", deps());
    expect(ids).toEqual(["@vendor/pkg:s1", "@vendor/pkg:s2"]);
  });

  it("derives VIRTUAL chat-namespace ids for a chat successor package (a case a native catalog row cannot represent)", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@cinatra-ai/company-research-skill",
      deps({
        scanExtensions: vi.fn(async () => [
          descriptor({
            pkgName: "@cinatra-ai/company-research-skill",
            pkgDirName: "company-research-skill",
            slugs: ["company-research"],
          }),
        ]),
        deriveSkillRegistration: vi.fn(() => ({
          packageName: "@cinatra-ai/chat",
          skillId: "@cinatra-ai/chat:company-research",
        })),
      }),
    );
    expect(ids).toEqual(["@cinatra-ai/chat:company-research"]);
  });

  it("returns [] when the scan carries no kind:'skill' descriptor for this package name — a normal outcome, not a failure", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/absent", deps());
    expect(ids).toEqual([]);
  });

  it("ignores a non-skill-kind descriptor sharing the same package name", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@vendor/pkg",
      deps({ scanExtensions: vi.fn(async () => [descriptor({ kind: "agent" })]) }),
    );
    expect(ids).toEqual([]);
  });

  it("a per-slug derivation throw (reserved-namespace impersonation) degrades ONLY that slug, mirroring buildSkillIdOwnership's fail-soft posture", async () => {
    const derive = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("deriveSkillRegistration: reserved namespace");
      })
      .mockImplementationOnce(identityDerive);
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", deps({ deriveSkillRegistration: derive }));
    expect(ids).toEqual(["@vendor/pkg:s2"]);
  });

  it("returns [] for an empty package name WITHOUT even calling the scan", async () => {
    const scanExtensions = vi.fn(async () => [descriptor()]);
    const ids = await deriveOwnedAssignedSkillIds("", deps({ scanExtensions }));
    expect(ids).toEqual([]);
    expect(scanExtensions).not.toHaveBeenCalled();
  });

  it("a package with a skill descriptor but zero slugs derives zero ids (not an error)", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@vendor/pkg",
      deps({ scanExtensions: vi.fn(async () => [descriptor({ slugs: [] })]) }),
    );
    expect(ids).toEqual([]);
  });
});

describe("sweepAssignedSkillsForSkillPackageId", () => {
  it("recovers the real npm name from a `verdaccio:` packageId and deletes every derived id", async () => {
    const deleteBySkillIds = vi.fn(async (ids: string[]) => ({ deletedCount: ids.length }));
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).toHaveBeenCalledWith(["@vendor/pkg:s1", "@vendor/pkg:s2"]);
    expect(result).toEqual({ deletedCount: 2 });
  });

  it("recovers the real npm name from a `github:` packageId", async () => {
    const scanExtensions = vi.fn(async () => [descriptor({ pkgName: "octo/repo", pkgDirName: "repo" })]);
    const deleteBySkillIds = vi.fn(async () => ({ deletedCount: 2 }));
    await sweepAssignedSkillsForSkillPackageId("github:octo/repo", {
      scanExtensions,
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).toHaveBeenCalledWith(["octo/repo:s1", "octo/repo:s2"]);
  });

  it("no-ops (NEVER calls delete) when the package owns no derivable ids — covers a virtual-namespace registration with no native skillPackages row at all", async () => {
    const deleteBySkillIds = vi.fn();
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/nothing", {
      scanExtensions: vi.fn(async () => []),
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });

  it("a scan failure propagates (fatal — mirrors the co-owner cleanup precedent: the whole uninstall must roll back rather than silently skip teardown)", async () => {
    await expect(
      sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
        scanExtensions: vi.fn(async () => {
          throw new Error("disk unreadable");
        }),
        deriveSkillRegistration: identityDerive,
        deleteBySkillIds: vi.fn(),
      }),
    ).rejects.toThrow("disk unreadable");
  });

  it("a delete failure propagates too", async () => {
    await expect(
      sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
        scanExtensions: vi.fn(async () => [descriptor()]),
        deriveSkillRegistration: identityDerive,
        deleteBySkillIds: vi.fn(async () => {
          throw new Error("db unreachable");
        }),
      }),
    ).rejects.toThrow("db unreachable");
  });
});

// =============================================================================
// §2 — DEFAULT dependency wiring (reaches the REAL extension-skill-resolver +
// the REAL @/lib/agent-assigned-skills-store, mocked at the module level).
// =============================================================================

describe("skill-side sweep — default wiring reaches the REAL extension-skill-resolver + store", () => {
  it("with no deps: scans via scanSkillExtensions, derives via deriveSkillRegistration, deletes via the store", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([descriptor({ slugs: ["s1"] })]);
    mocks.deriveSkillRegistration.mockReturnValueOnce({
      packageName: "@vendor/pkg",
      skillId: "@vendor/pkg:s1",
    });
    mocks.deleteAssignedSkillsForSkillIds.mockResolvedValueOnce({ deletedCount: 1 });

    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg");

    expect(mocks.scanSkillExtensions).toHaveBeenCalledTimes(1);
    expect(mocks.deriveSkillRegistration).toHaveBeenCalledWith("@vendor/pkg", "pkg", "s1");
    expect(mocks.deleteAssignedSkillsForSkillIds).toHaveBeenCalledWith(["@vendor/pkg:s1"]);
    expect(result).toEqual({ deletedCount: 1 });
  });

  it("with no deps and no owned ids: never reaches the store delete", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([]);
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/nothing");
    expect(mocks.deleteAssignedSkillsForSkillIds).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });
});

describe("agent-side delete — default wiring reaches the REAL @/lib/agent-assigned-skills-store", () => {
  it("delegates the agent package name to the real store primitive", async () => {
    mocks.deleteAssignedSkillsForAgentPackage.mockResolvedValueOnce({ deletedCount: 3 });
    const result = await deleteAssignedSkillsForAgentPackage("@vendor/agent-pkg");
    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith("@vendor/agent-pkg");
    expect(result).toEqual({ deletedCount: 3 });
  });
});

// =============================================================================
// §3 — `uninstallSkillPackage` ORDERING (cinatra#2350 S5 acceptance
// criterion): the sweep runs BEFORE the missing-native-package early return,
// not merely before the catalog rewrite.
// =============================================================================

describe("uninstallSkillPackage — agent_assigned_skills sweep ordering", () => {
  it("sweeps BEFORE the missing-native-package early return — a package with NO native catalog row is still swept", async () => {
    // No skillPackages row for this packageId at all — the virtual-namespace
    // shape the issue calls out ("may have no native catalog package at all").
    dbCatalog.skillPackages = [];
    dbCatalog.skills = [];
    mocks.scanSkillExtensions.mockResolvedValue([]); // owns nothing — no real delete reached

    const result = await uninstallSkillPackage("verdaccio:@cinatra-ai/company-research-skill");

    expect(mocks.scanSkillExtensions).toHaveBeenCalled();
    // The early return still fires for the native-catalog half of the function.
    expect(result).toBe(false);
  });

  it("recovers the real npm name from the packageId — never the (absent) native catalog row", async () => {
    mocks.scanSkillExtensions.mockResolvedValue([
      descriptor({ pkgName: "octo/repo", pkgDirName: "repo", slugs: ["s1"] }),
    ]);
    mocks.deriveSkillRegistration.mockReturnValue({ packageName: "octo/repo", skillId: "octo/repo:s1" });
    mocks.deleteAssignedSkillsForSkillIds.mockResolvedValue({ deletedCount: 1 });

    await uninstallSkillPackage("github:octo/repo");

    expect(mocks.deleteAssignedSkillsForSkillIds).toHaveBeenCalledWith(["octo/repo:s1"]);
  });

  it("still sweeps when a native catalog row DOES exist (the ordinary case)", async () => {
    dbCatalog.skillPackages = [
      {
        id: "verdaccio:@vendor/pkg",
        packageId: "verdaccio:@vendor/pkg",
        name: "Pkg",
        slug: "pkg",
        description: "d",
        isCustom: true,
      },
    ];
    dbCatalog.skills = [];
    mocks.scanSkillExtensions.mockResolvedValue([]);

    const result = await uninstallSkillPackage("verdaccio:@vendor/pkg");

    expect(mocks.scanSkillExtensions).toHaveBeenCalled();
    expect(result).not.toBe(false);
  });

  it("ORDER: the sweep's scan runs BEFORE the catalog read that decides the early return", async () => {
    const order: string[] = [];
    mocks.scanSkillExtensions.mockImplementation(async () => {
      order.push("sweep-scan");
      return [];
    });
    // dbCatalog is read via readSkillCatalogFromDatabase — wrap it to observe order.
    const { readSkillCatalogFromDatabase } = await import("@/lib/database");
    vi.mocked(readSkillCatalogFromDatabase).mockImplementation(() => {
      order.push("catalog-read");
      return dbCatalog as never;
    });

    await uninstallSkillPackage("verdaccio:@vendor/pkg");

    expect(order).toEqual(["sweep-scan", "catalog-read"]);
  });

  it("a sweep failure is FATAL — the whole uninstall aborts rather than silently skipping the sweep (co-owner-cleanup precedent)", async () => {
    mocks.scanSkillExtensions.mockRejectedValueOnce(new Error("db unreachable"));
    dbCatalog.skillPackages = [
      {
        id: "verdaccio:@vendor/pkg",
        packageId: "verdaccio:@vendor/pkg",
        name: "Pkg",
        slug: "pkg",
        description: "d",
        isCustom: true,
      },
    ];

    await expect(uninstallSkillPackage("verdaccio:@vendor/pkg")).rejects.toThrow("db unreachable");
  });
});
