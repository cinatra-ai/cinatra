/**
 * `uninstallSkillPackage`'s integration with the S5 lifecycle-teardown sweep
 * (cinatra#2350, epic #2345).
 *
 * Proves the ORDERING claim in the issue: the `agent_assigned_skills` sweep
 * runs BEFORE the missing-native-package early return — not merely before
 * the catalog rewrite — so a virtual-namespace registration (one of the five
 * chat successor packages, which may have NO native `skillPackages` catalog
 * row at all) still gets its assignment rows swept.
 *
 * Mocks `./agent-assigned-skills-teardown` wholesale (its own logic is
 * covered by agent-assigned-skills-teardown.test.ts and
 * agent-assigned-skills-teardown-default-deps.test.ts) so this file stays
 * focused on ORDERING and the packageId that reaches the sweep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

const { sweepMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(async () => ({ deletedCount: 0 })),
}));
vi.mock("./agent-assigned-skills-teardown", () => ({
  sweepAssignedSkillsForSkillPackageId: sweepMock,
}));

import { uninstallSkillPackage } from "./skills-store";

beforeEach(() => {
  sweepMock.mockClear();
  dbCatalog.skillPackages = [];
  dbCatalog.skills = [];
});

describe("uninstallSkillPackage — agent_assigned_skills sweep ordering (cinatra#2350 S5)", () => {
  it("sweeps BEFORE the missing-native-package early return — a package with NO native catalog row is still swept", async () => {
    // No skillPackages row for this packageId at all — the virtual-namespace
    // shape the issue calls out ("may have no native catalog package at all").
    dbCatalog.skillPackages = [];
    dbCatalog.skills = [];

    const result = await uninstallSkillPackage("verdaccio:@cinatra-ai/company-research-skill");

    expect(sweepMock).toHaveBeenCalledWith("verdaccio:@cinatra-ai/company-research-skill");
    // The early return still fires for the native-catalog half of the function.
    expect(result).toBe(false);
  });

  it("passes the packageId through UNCHANGED — the real npm name is recovered INSIDE the sweep, not here", async () => {
    await uninstallSkillPackage("github:octo/repo");
    expect(sweepMock).toHaveBeenCalledWith("github:octo/repo");
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

    const result = await uninstallSkillPackage("verdaccio:@vendor/pkg");

    expect(sweepMock).toHaveBeenCalledWith("verdaccio:@vendor/pkg");
    expect(result).not.toBe(false);
  });

  it("a sweep failure is FATAL — the whole uninstall aborts rather than silently skipping the sweep (co-owner-cleanup precedent)", async () => {
    sweepMock.mockRejectedValueOnce(new Error("db unreachable"));
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

    await expect(uninstallSkillPackage("verdaccio:@vendor/pkg")).rejects.toThrow(
      "db unreachable",
    );
  });
});
