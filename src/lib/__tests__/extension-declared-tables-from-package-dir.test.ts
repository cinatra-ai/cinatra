/**
 * cinatra#3462 — the host road the development boot's import now takes:
 * `ensureExtensionDeclaredTablesFromPackageDir`.
 *
 * The DB-tier sibling of this file proves the activation on a real Postgres.
 * What is proven HERE is the contract around it, at its injected seams —
 * the three things the boot road must get right and a database run would only
 * prove indirectly:
 *
 *   1. it does NOT repeat the privilege sequence while the activation is
 *      already current (that sequence starts with REVOKE ALL PRIVILEGES ON ALL
 *      TABLES, so repeating it per boot on a serving installation withdraws the
 *      extension's own privileges for the length of the run);
 *   2. it FEEDS the prefix-collision refusal a real installed inventory — an
 *      unfed refusal refuses nothing (codex convergence round 1);
 *   3. a package that declares no tables is a clean no-op.
 *
 * Run: pnpm exec vitest run --config vitest.config.ts --no-coverage \
 *   src/lib/__tests__/extension-declared-tables-from-package-dir.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureExtensionDeclaredTablesFromPackageDir } from "@/lib/extension-migration-host";

const PACKAGE = "@cinatra-ai/x3462-seam-fixture";
const DECLARED_TABLES = [
  {
    name: "idea_drafts",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "text", notNull: true, primaryKey: true },
      { name: "org_id", type: "text", notNull: true },
    ],
  },
];

let withTables: string;
let withoutTables: string;

async function writePackage(cinatra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x3462-seam-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: PACKAGE, version: "0.2.2", license: "Apache-2.0", cinatra }, null, 2),
  );
  return dir;
}

beforeAll(async () => {
  process.env.SUPABASE_DB_URL ??= "postgres://seam:seam@127.0.0.1:5432/seam";
  withTables = await writePackage({ type: "flow", declaredTables: DECLARED_TABLES });
  withoutTables = await writePackage({ type: "flow" });
});

let ensureDatabaseObjects: ReturnType<typeof vi.fn>;
let readInstalledPackageNames: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ensureDatabaseObjects = vi.fn(async () => {});
  readInstalledPackageNames = vi.fn(async () => [PACKAGE, "@cinatra-ai/some-other-agent"]);
});

describe("cinatra#3462 — ensureExtensionDeclaredTablesFromPackageDir", () => {
  it("does NO privilege work while the activation is already current", async () => {
    const isActivationCurrent = vi.fn(async () => true);

    const result = await ensureExtensionDeclaredTablesFromPackageDir(
      { packageDir: withTables, packageName: PACKAGE, schema: "cinatra" },
      {
        ensureDatabaseObjects: ensureDatabaseObjects as never,
        readInstalledPackageNames: readInstalledPackageNames as never,
        isActivationCurrent: isActivationCurrent as never,
      },
    );

    expect(result.activated).toBe(true);
    expect(result.alreadyCurrent).toBe(true);
    expect(result.roleName).toBe("ext_cinatra_ai_x3462_seam_fixture");
    expect(ensureDatabaseObjects).not.toHaveBeenCalled();
  });

  it("activates when the state is NOT current, on the same road the install pipeline takes", async () => {
    const isActivationCurrent = vi.fn(async () => false);

    const result = await ensureExtensionDeclaredTablesFromPackageDir(
      { packageDir: withTables, packageName: PACKAGE, schema: "cinatra" },
      {
        ensureDatabaseObjects: ensureDatabaseObjects as never,
        readInstalledPackageNames: readInstalledPackageNames as never,
        isActivationCurrent: isActivationCurrent as never,
      },
    );

    expect(result.activated).toBe(true);
    expect(result.alreadyCurrent).toBe(false);
    expect(ensureDatabaseObjects).toHaveBeenCalledTimes(1);
    const call = ensureDatabaseObjects.mock.calls[0][0] as {
      schemaName: string;
      packageName: string;
      roleName: string;
      plan: { physicalTableNames: string[] };
    };
    expect(call.schemaName).toBe("cinatra");
    expect(call.packageName).toBe(PACKAGE);
    expect(call.roleName).toBe("ext_cinatra_ai_x3462_seam_fixture");
    expect(call.plan.physicalTableNames).toEqual(["ext_cinatra_ai_x3462_seam_fixture_idea_drafts"]);
  });

  it("FEEDS the prefix-collision refusal the installed inventory — it is never left empty", async () => {
    // "@cinatra-ai/x3462.seam.fixture" normalises to the same prefix. With the
    // inventory unfed (the state codex found), nothing refuses this and two
    // packages share one role and one set of tables.
    readInstalledPackageNames = vi.fn(async () => ["@cinatra-ai/x3462.seam.fixture"]);
    const isActivationCurrent = vi.fn(async () => false);

    await expect(
      ensureExtensionDeclaredTablesFromPackageDir(
        { packageDir: withTables, packageName: PACKAGE, schema: "cinatra" },
        {
          ensureDatabaseObjects: ensureDatabaseObjects as never,
          readInstalledPackageNames: readInstalledPackageNames as never,
          isActivationCurrent: isActivationCurrent as never,
        },
      ),
    ).rejects.toThrow(/collides with the installed extension/);

    expect(readInstalledPackageNames).toHaveBeenCalledTimes(1);
    expect(ensureDatabaseObjects).not.toHaveBeenCalled();
  });

  it("a package that declares NO tables is a clean no-op", async () => {
    const isActivationCurrent = vi.fn(async () => false);

    const result = await ensureExtensionDeclaredTablesFromPackageDir(
      { packageDir: withoutTables, packageName: PACKAGE },
      {
        ensureDatabaseObjects: ensureDatabaseObjects as never,
        readInstalledPackageNames: readInstalledPackageNames as never,
        isActivationCurrent: isActivationCurrent as never,
      },
    );

    expect(result).toEqual({ activated: false });
    expect(isActivationCurrent).not.toHaveBeenCalled();
    expect(ensureDatabaseObjects).not.toHaveBeenCalled();
  });
});
