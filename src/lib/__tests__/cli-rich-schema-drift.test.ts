import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

// Runtime-installer schema drift guard.
//
// The runtime installer adds three tables (the host-port grant store, the
// snapshot-lease store, the install-op journal). The grant store + lease store
// + install-op journal all REQUIRE
// these to exist in EVERY database — prod, light worktree (`cinatra_<slug>`),
// and heavy clone (`cinatra_clone_<slug>`). This guard locks the contract that
// delivers that:
//
//   1. all three tables are created by `buildCreateStoreSchemaQueries()` — the
//      SINGLE source of truth run at every dev-server boot via
//      `ensurePostgresSchema()`. Because the CLI's worktree/clone setup boots a
//      dev server, the SSOT creates them everywhere → dev parity. (If a table is
//      dropped from the SSOT, this fails.)
//   2. the three tables are NOT duplicated into the CLI's hand-maintained
//      `RICH_TABLES` / `STORE_TABLES`. Their DDL carries CHECK constraints,
//      partial-unique indexes, and non-unique indexes that the CLI's
//      constraint-light `ensureRichSchemas` shape can't express faithfully — a
//      duplicate copy would be exactly the drift this guard prevents. The boot
//      SSOT is the one owner.
//
// NOTE: a broader "buildCreateStoreSchemaQueries ⊇ all CLI RICH_TABLES" is NOT
// asserted — pre-existing package-owned / legacy tables (e.g.
// object_connector_configs owned by packages/objects, and the obsolete
// planned_actions / review_tasks) are created/tolerated outside the core SSOT
// and are out of the runtime installer's scope.

// `extension_migrations` (the retired JSON-DSL migration ledger) was dropped in
// #118 — extension migrations now record into the shared node-pg-migrate
// `pgmigrations` ledger, which the runner itself creates.
const INSTALLER_TABLES = [
  "extension_host_port_grant",
  "extension_snapshot_lease",
  "extension_install_ops",
];

function ssotTableNames(): Set<string> {
  const queries = buildCreateStoreSchemaQueries("drift_test");
  const names = new Set<string>();
  for (const q of queries) {
    for (const m of String(q.text).matchAll(/CREATE TABLE IF NOT EXISTS "drift_test"\."([a-z0-9_]+)"/gi)) {
      names.add(m[1]);
    }
  }
  return names;
}

function cliSource(): string {
  // The `cinatra` CLI now ships as the published @cinatra-ai/cinatra package
  // (cinatra#402 P2), installed as a pinned root devDependency. Read its
  // hand-maintained RICH_TABLES / STORE_TABLES lists from node_modules — the
  // same source this guard tracked when the CLI lived at packages/cli/src.
  return readFileSync(
    join(process.cwd(), "node_modules/@cinatra-ai/cinatra/src/index.mjs"),
    "utf8",
  );
}

describe("runtime-installer schema drift guard", () => {
  const ssot = ssotTableNames();

  it("parses the SSOT (sanity)", () => {
    expect(ssot.size).toBeGreaterThan(20);
  });

  it("creates all three runtime-installer tables in the boot SSOT (dev parity in every DB)", () => {
    const missing = INSTALLER_TABLES.filter((t) => !ssot.has(t));
    expect(missing, `installer tables missing from buildCreateStoreSchemaQueries: ${missing.join(", ")}`).toEqual([]);
  });

  it("does NOT duplicate the installer tables into the CLI's hand-maintained lists (single owner = the SSOT)", () => {
    const cli = cliSource();
    const richStart = cli.indexOf("const RICH_TABLES = [");
    const richEnd = cli.indexOf("\nasync function ensureRichSchemas");
    const storeStart = cli.indexOf("const STORE_TABLES = [");
    const storeEnd = cli.indexOf("];", storeStart);
    expect(richStart).toBeGreaterThan(-1);
    expect(storeStart).toBeGreaterThan(-1);
    const cliListsBlob = cli.slice(storeStart, storeEnd) + "\n" + cli.slice(richStart, richEnd);
    const duplicated = INSTALLER_TABLES.filter((t) => cliListsBlob.includes(`"${t}"`));
    expect(
      duplicated,
      `installer tables divergently duplicated in the CLI lists (let the boot SSOT own them): ${duplicated.join(", ")}`,
    ).toEqual([]);
  });
});
