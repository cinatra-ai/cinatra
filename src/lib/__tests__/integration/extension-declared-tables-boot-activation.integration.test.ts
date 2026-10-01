/**
 * cinatra#3462 — THE DEVELOPMENT BOOT'S IMPORT ROAD PUTS THE DECLARED TABLES IN
 * PLACE, ON A REAL POSTGRES, ON A DATABASE CREATED FROM NOTHING.
 *
 * THE MEASURED STATE (twice, 2026-09-13, on a lane database created from
 * nothing by the sanctioned bring-up): after the development boot's import
 *
 *   SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ext%';   -- 0, for all 94
 *   -- and no declared table of any installed package in the app schema
 *
 * while the importer logged `<package> v<x> skipped — already up to date`. The
 * role and the declared tables are created by the host's declared-tables
 * activation, which the marketplace install pipeline reaches and the boot's
 * git-file import road did not. Every run of a table-declaring package then
 * died at its first passthrough call with `role "ext_<scope>_<pkg>" does not
 * exist`.
 *
 * WHY THIS TIER EXISTS. Both claims are claims about the DATABASE: that a role
 * exists in `pg_roles` and that a table exists in the schema. A stub would
 * agree with whatever this code said. So the leaves here are real: a real
 * Postgres, a real package manifest on disk declaring a table, the real
 * importer (`ensureAgentPackageFromGitFile`) taking its real "already up to
 * date" skip branch, and the real host activation road it now reaches
 * (`ensureExtensionDeclaredTablesFromPackageDir` -> `ensureExtensionDatabaseObjects`).
 *
 * WHAT IS DOUBLED, AND WHY. Only the two collaborators this slice does not
 * touch and that would drag a whole template-import ceremony into a database
 * claim: the template row read (so the loader takes the SKIP branch — the exact
 * branch of the defect) and the template importer itself (which must not be
 * called on that branch, and the test asserts it is not). Nothing about the
 * role or the tables is doubled.
 *
 * Run: CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage \
 *   src/lib/__tests__/integration/extension-declared-tables-boot-activation.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// The full app bootstrap references tables absent on a plain verify Postgres;
// no-op it (same pattern as the neighbouring install-record integration test).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

// The template row read and the template importer — the two collaborators this
// slice does not touch. The read puts the loader on its "already up to date"
// SKIP branch (the branch of the defect); the importer must never be called
// there, which the first case asserts.
const { readAgentTemplateByPackageNameMock, importAgentTemplateCoreMock } = vi.hoisted(() => ({
  readAgentTemplateByPackageNameMock: vi.fn(),
  importAgentTemplateCoreMock: vi.fn(async () => ({ templateId: "tpl-x3462", upserted: true })),
}));
vi.mock("../../../../packages/agents/src/store", () => ({
  readAgentTemplateByPackageName: readAgentTemplateByPackageNameMock,
  setAgentTemplatePackageName: vi.fn(async () => {}),
}));
vi.mock("../../../../packages/agents/src/import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

const DB_URL = process.env.SUPABASE_DB_URL;
const HAS_DB =
  typeof DB_URL === "string" &&
  DB_URL.length > 0 &&
  !isPlaceholderDbUrl(DB_URL) &&
  !DB_URL.includes("build:build@127.0.0.1:5432/build");
const describeDb = HAS_DB ? describe : describe.skip;

const SUFFIX = randomUUID().replace(/-/g, "").slice(0, 8);
const TEST_SCHEMA = `cinatra_x3462_${SUFFIX}`;
const PACKAGE = `@cinatra-ai/x3462-fixture-${SUFFIX}`;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

const DECLARED_TABLES = [
  {
    name: "idea_drafts",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "text", notNull: true, primaryKey: true },
      { name: "org_id", type: "text", notNull: true },
      { name: "run_id", type: "text", notNull: true },
      { name: "state", type: "text", notNull: true },
    ],
    indexes: [{ name: "idea_drafts_by_run", columns: ["org_id", "run_id"] }],
  },
];

let admin: Client;
let packageDir: string;
let oasPath: string;
let roleName: string;
let physicalTable: string;
let loader: typeof import("../../../../packages/agents/src/ensure-agent-package");

/** The on-disk layout the dev-boot scan hands the loader: the manifest beside a
 *  `cinatra/oas.json`. Nothing about it is synthesized at read time. */
async function writeFixturePackage(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "x3462-pkg-"));
  packageDir = join(root, "x3462-fixture");
  await mkdir(join(packageDir, "cinatra"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: PACKAGE,
        version: "0.2.2",
        license: "Apache-2.0",
        cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", type: "flow", declaredTables: DECLARED_TABLES },
      },
      null,
      2,
    ),
  );
  oasPath = join(packageDir, "cinatra", "oas.json");
  await writeFile(
    oasPath,
    JSON.stringify(
      {
        agentspec_version: "26.1.0",
        component_type: "Flow",
        name: "x3462 fixture",
        metadata: { cinatra: { packageName: PACKAGE } },
      },
      null,
      2,
    ),
  );
}

async function roleExists(): Promise<boolean> {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
  return (rowCount ?? 0) > 0;
}

async function tableExists(name: string = physicalTable): Promise<boolean> {
  const { rowCount } = await admin.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
    [TEST_SCHEMA, name],
  );
  return (rowCount ?? 0) > 0;
}

/** The privileges the extension's role actually holds on one physical table. */
async function grantsOn(name: string): Promise<string[]> {
  const { rows } = await admin.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_schema = $2 AND table_name = $3
      ORDER BY privilege_type`,
    [roleName, TEST_SCHEMA, name],
  );
  return rows.map((r: { privilege_type: string }) => r.privilege_type);
}

/** Rewrite the fixture's manifest with a CHANGED declaration. */
async function rewriteDeclaration(tables: unknown[]): Promise<void> {
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: PACKAGE,
        version: "0.2.2",
        license: "Apache-2.0",
        cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", type: "flow", declaredTables: tables },
      },
      null,
      2,
    ),
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // Bind the schema before the host road reads it.
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${q(TEST_SCHEMA)} CASCADE`);
  await admin.query(`CREATE SCHEMA ${q(TEST_SCHEMA)}`);

  await writeFixturePackage();

  const { extensionDatabaseRoleName, declaredTablePhysicalName } = await import(
    "@cinatra-ai/sdk-extensions/manifest"
  );
  roleName = extensionDatabaseRoleName(PACKAGE);
  physicalTable = declaredTablePhysicalName(PACKAGE, "idea_drafts");
  await admin.query(`DROP ROLE IF EXISTS ${q(roleName)}`);

  readAgentTemplateByPackageNameMock.mockResolvedValue({
    id: "tpl-x3462",
    packageVersion: "0.2.2",
    lifecycleConfig: null,
  });

  loader = await import("../../../../packages/agents/src/ensure-agent-package");
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin?.query(`DROP SCHEMA IF EXISTS ${q(TEST_SCHEMA)} CASCADE`).catch(() => {});
  if (roleName) {
    await admin?.query(`DROP OWNED BY ${q(roleName)} CASCADE`).catch(() => {});
    await admin?.query(`DROP ROLE IF EXISTS ${q(roleName)}`).catch(() => {});
  }
  await admin?.end().catch(() => {});
  vi.restoreAllMocks();
});

describeDb("cinatra#3462 — the boot import road activates declared tables on a fresh database", () => {
  it("RED REPRO: on a database created from nothing the import leaves the role and the declared table in place", async () => {
    // The measured state before the import: no role, no table — exactly the
    // reading taken on the lane database.
    expect(await roleExists()).toBe(false);
    expect(await tableExists()).toBe(false);

    const result = await loader.ensureAgentPackageFromGitFile({
      oasSourcePath: oasPath,
      // A live install record: the loader takes its "already up to date" skip,
      // the branch on which the defect was measured.
      healInstallRecord: async () => ({ outcome: "already-live" }),
    });

    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();

    // The two claims of the issue, read back from the database itself.
    expect(await roleExists()).toBe(true);
    expect(await tableExists()).toBe(true);
  }, 120_000);

  it("the role holds the declared table's privileges and nothing beyond its prefix", async () => {
    const { rows } = await admin.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = $2 AND table_name = $3
        ORDER BY privilege_type`,
      [roleName, TEST_SCHEMA, physicalTable],
    );
    const granted = rows.map((r: { privilege_type: string }) => r.privilege_type);
    expect(granted).toContain("SELECT");
    expect(granted).toContain("INSERT");

    const { rowCount } = await admin.query(
      `SELECT 1 FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = $2 AND table_name NOT LIKE $3`,
      [roleName, TEST_SCHEMA, `${roleName}\\_%`],
    );
    expect(rowCount ?? 0).toBe(0);
  }, 60_000);

  it("a SECOND import is idempotent — the role, the table and the grants are unchanged", async () => {
    const grantsBefore = await grantsOn(physicalTable);

    const result = await loader.ensureAgentPackageFromGitFile({
      oasSourcePath: oasPath,
      healInstallRecord: async () => ({ outcome: "already-live" }),
    });

    expect(result.skipped).toBe(true);
    expect(await roleExists()).toBe(true);
    expect(await tableExists()).toBe(true);
    expect(await grantsOn(physicalTable)).toEqual(grantsBefore);
  }, 120_000);

  it("a WITHDRAWN grant is healed by the next import (the current-state check never wedges)", async () => {
    // Codex convergence round 1: the activation is skipped while it is already
    // current, so the check must not be able to report "current" for a state
    // that is broken. Take the grant away behind its back and import again.
    await admin.query(
      `REVOKE ALL PRIVILEGES ON ${q(TEST_SCHEMA)}.${q(physicalTable)} FROM ${q(roleName)}`,
    );
    expect(await grantsOn(physicalTable)).toEqual([]);

    await loader.ensureAgentPackageFromGitFile({
      oasSourcePath: oasPath,
      healInstallRecord: async () => ({ outcome: "already-live" }),
    });

    const healed = await grantsOn(physicalTable);
    expect(healed).toContain("SELECT");
    expect(healed).toContain("INSERT");
  }, 120_000);

  it("a CHANGED declaration is activated on the next import — and the first table keeps its grant", async () => {
    const { declaredTablePhysicalName } = await import("@cinatra-ai/sdk-extensions/manifest");
    const secondTable = declaredTablePhysicalName(PACKAGE, "run_notes");
    expect(await tableExists(secondTable)).toBe(false);

    await rewriteDeclaration([
      ...DECLARED_TABLES,
      {
        name: "run_notes",
        organizationColumn: "org_id",
        columns: [
          { name: "id", type: "text", notNull: true, primaryKey: true },
          { name: "org_id", type: "text", notNull: true },
          { name: "note", type: "text", notNull: true },
        ],
      },
    ]);

    await loader.ensureAgentPackageFromGitFile({
      oasSourcePath: oasPath,
      healInstallRecord: async () => ({ outcome: "already-live" }),
    });

    expect(await tableExists(secondTable)).toBe(true);
    expect(await grantsOn(secondTable)).toContain("SELECT");
    // The revoke-then-regrant of the activation must not cost the FIRST table
    // its grant: the current declaration still names it.
    expect(await grantsOn(physicalTable)).toContain("SELECT");
  }, 120_000);
});
