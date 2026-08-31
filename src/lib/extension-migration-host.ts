import "server-only";

// Host-side application of EXTENSION migrations through the SHARED
// node-pg-migrate runner (#118; engine decision #115).
//
// Contract: a trusted-signed extension declares `cinatra.migrationsDir` — a
// package-relative directory of STANDARD node-pg-migrate ESM modules named
// `ext_<scope>_<pkg>__NNNN_<short-description>.mjs` (the per-source namespace
// for the shared `pgmigrations` ledger). The HOST runs them through
// `runNamespacedMigrations` (`@cinatra-ai/migrations`): dedicated
// short-lived pg client, the database-global `cinatra-schema-init` advisory
// lock, `noLock`, `checkOrder: false` — exactly the core runner's options, so
// core and extension migrations can never drift apart.
//
// TRUST BOUNDARY (#118, on the record): a migration module is arbitrary code
// running raw SQL on the shared multi-tenant app schema. That is a PRIVILEGED
// capability gated on `trusted-signed` — the same signature gate that already
// authorizes dynamically importing the extension's server code in-process.
// Callers enforce the gate (the loader's signed-only pass, the install
// pipeline's `autoGrantPrivileged`); this module enforces the mechanical
// contract: manifest-driven discovery only (never static imports — IoC),
// path containment inside the verified store dir, no symlinked modules, the
// namespace filename contract, and up-only application. The legacy JSON-DSL
// (`cinatra.migrations`, retired in #118) is rejected fail-closed — it must
// never silently activate as "no migrations".
//
// Rollback: the host never migrates extensions down (install/boot/activate
// only need `up`). The shared runner's per-namespace down fence ships, and
// `cinatra db migrate --down --dir <abs> --namespace <ns>` is the operator
// escape hatch for reverting an extension's newest ledger rows.

import {
  extensionMigrationNamespace,
  runExtensionMigrationsUnderRole,
  validateNamespacedMigrationsDir,
} from "@cinatra-ai/migrations";
// TYPE-ONLY (erased) + dynamic value imports. The W7 road pulls the extension
// table/role machinery and the role-switching migration runner; this module is
// reachable from four ROUTE-GRAPH-RATCHETED routes (/chat, /api/mcp, /api/a2a,
// /api/llm-bridge) whose ceilings may only ever shrink, and those routes never
// run a migration. Same posture as the artifact stack's dynamic imports in the
// passthrough route: the machinery is loaded where it is used.
import {
  assertNoDeclaredTablePrefixCollision,
  declaredIndexPhysicalName,
  declaredTablePhysicalName,
  extensionDatabaseRoleName,
  extensionTablePrefix,
  parseDeclaredTables,
  type DeclaredTable,
} from "@cinatra-ai/sdk-extensions/manifest";
import { recordDeclaresHostMigrations } from "@cinatra-ai/sdk-extensions";
import { comparePluginVersions } from "@cinatra-ai/registries";

const DEFAULT_SCHEMA = "cinatra";

export type ExtensionMigrationsResult = {
  /** Ledger names applied by this run (empty when up to date / none declared). */
  applied: string[];
};

export type ExtensionMigrationsPreflight = {
  packageName: string;
  /** Absolute, containment-checked migrations directory. */
  dirAbs: string;
  /** Per-source ledger namespace (`ext_<scope>_<pkg>__`). */
  namespace: string;
  /** The validated migration module filenames, sorted. */
  files: string[];
} | null;

/**
 * Validate-only preflight of a materialized package's declared migrations
 * (NO database, NO module import — safe for install preflights):
 *
 *   1. read the store manifest; no `cinatra.migrationsDir` -> null (the
 *      common case). The RETIRED `cinatra.migrations` JSON-DSL field is a
 *      hard error (fail closed, never "no migrations").
 *   2. containment: the declared dir must stay INSIDE the verified store dir
 *      even after following filesystem links (realpath-bound, the same
 *      defense the loader applies to `serverEntry`).
 *   3. the namespace filename contract (`ext_<scope>_<pkg>__NNNN_<desc>.mjs`,
 *      unique seqs, no symlinked modules) via the shared runner's validator.
 *
 * An unreadable/unparsable store manifest is treated as "no migrations" —
 * the loader/installer already validated manifest structure upstream; this
 * mirrors the pre-#118 defensive behavior.
 */
export async function preflightExtensionMigrationsFromStore(input: {
  storeDir: string;
  packageName?: string;
}): Promise<ExtensionMigrationsPreflight> {
  const { readFile, realpath, stat } = await import("node:fs/promises");
  const path = await import("node:path");

  let manifest: { name?: unknown; cinatra?: { migrations?: unknown; migrationsDir?: unknown } };
  try {
    manifest = JSON.parse(await readFile(path.join(input.storeDir, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }

  const packageName =
    input.packageName ?? (typeof manifest.name === "string" ? manifest.name : null);

  if (manifest.cinatra?.migrations !== undefined) {
    throw new Error(
      `[ext-migration] ${packageName ?? input.storeDir}: the declarative JSON-DSL migration field ` +
        `(cinatra.migrations) is retired (#118) — ship standard node-pg-migrate modules in a directory ` +
        `declared via cinatra.migrationsDir instead`,
    );
  }

  const rawDir = manifest.cinatra?.migrationsDir;
  if (rawDir === undefined) return null;
  if (typeof rawDir !== "string" || rawDir.trim().length === 0) {
    throw new Error(`[ext-migration] ${packageName ?? input.storeDir}: cinatra.migrationsDir must be a non-empty package-relative path`);
  }
  if (!packageName) {
    throw new Error("[ext-migration] cannot resolve package name from store manifest");
  }
  // Identity pinning: the namespace derives from the TRUSTED identity the
  // caller verified (loader record / install-pipeline input). A store
  // manifest whose `name` disagrees with it is refused — mismatched content
  // must never run DDL under another package's namespace.
  if (input.packageName && typeof manifest.name === "string" && manifest.name !== input.packageName) {
    throw new Error(
      `[ext-migration] store manifest name "${manifest.name}" does not match the trusted package name "${input.packageName}" — refusing to apply migrations`,
    );
  }

  const rel = rawDir.replace(/^\.\//, "");
  if (path.isAbsolute(rel) || rel.split("/").some((seg) => seg === "..")) {
    throw new Error(`[ext-migration] ${packageName}: unsafe migrationsDir "${rawDir}"`);
  }

  // Realpath-bound containment: the resolved dir must stay INSIDE the
  // verified store dir even after following filesystem links.
  const [realDir, realStore] = await Promise.all([
    realpath(path.join(input.storeDir, rel)).catch(() => null),
    realpath(input.storeDir),
  ]);
  if (!realDir || (realDir !== realStore && !realDir.startsWith(realStore + path.sep))) {
    throw new Error(
      `[ext-migration] ${packageName}: migrationsDir "${rawDir}" resolves outside the package store dir — refusing`,
    );
  }
  if (!(await stat(realDir)).isDirectory()) {
    throw new Error(`[ext-migration] ${packageName}: migrationsDir "${rawDir}" is not a directory`);
  }

  const namespace = extensionMigrationNamespace(packageName);
  const files = await validateNamespacedMigrationsDir(realDir, {
    namespace,
    allowSymlinks: false,
    missingDirHint: `declared by ${packageName}'s cinatra.migrationsDir`,
  });
  return { packageName, dirAbs: realDir, namespace, files };
}

/**
 * Validate-only preflight of a materialized package's DECLARED TABLES
 * (cinatra#3031, plan (C) 0.23/0.24). NO database: the declaration is parsed,
 * the prefix and role are derived, the 63-byte identifier limit is checked and
 * a prefix that collides with an installed extension's is refused — "a
 * declaration that breaks either is refused at preflight, before anything
 * runs".
 *
 * An unreadable/unparsable store manifest is "declares nothing", exactly as the
 * migrations preflight treats it; a manifest that DOES declare tables and
 * declares them wrongly throws.
 */
export async function preflightExtensionDeclaredTablesFromStore(input: {
  storeDir: string;
  packageName?: string;
  /** Every other installed package, for 0.23's prefix-collision refusal. */
  installedPackageNames?: readonly string[];
}): Promise<ExtensionDeclaredTablesPlan | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let manifest: { name?: unknown; cinatra?: { declaredTables?: unknown } };
  try {
    manifest = JSON.parse(
      await readFile(path.join(input.storeDir, "package.json"), "utf8"),
    ) as typeof manifest;
  } catch {
    return null;
  }
  const declared = manifest.cinatra?.declaredTables;
  if (declared === undefined || declared === null) return null;
  const packageName =
    input.packageName ?? (typeof manifest.name === "string" ? manifest.name : null);
  if (!packageName) {
    throw new Error("[ext-tables] cannot resolve package name from store manifest");
  }
  if (
    input.packageName &&
    typeof manifest.name === "string" &&
    manifest.name !== input.packageName
  ) {
    throw new Error(
      `[ext-tables] store manifest name "${manifest.name}" does not match the trusted package name ` +
        `"${input.packageName}" — refusing to create tables under another package's prefix`,
    );
  }
  return planExtensionDeclaredTables({
    packageName,
    declaredTables: declared,
    ...(input.installedPackageNames ? { installedPackageNames: input.installedPackageNames } : {}),
  });
}

/**
 * Put the extension's database objects in place under the HOST credential: the
 * role first, then the declared tables and their grants. Called BEFORE any
 * extension statement runs.
 *
 * A package that declares a `migrationsDir` and NO tables still gets its role —
 * with schema usage and not one table grant — so every statement its migration
 * issues is refused by the database. That is the enabler's posture, not an
 * oversight: "an extension's own migrations are data migrations on its declared
 * tables".
 */
async function ensureExtensionDatabaseObjectsDefault(input: {
  connectionString: string;
  schemaName: string;
  packageName: string;
  roleName: string;
  plan: ExtensionDeclaredTablesPlan | null;
}): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    const plan: ExtensionDeclaredTablesPlan = input.plan ?? {
      packageName: input.packageName,
      prefix: `${input.roleName}_`,
      roleName: input.roleName,
      tables: [],
      physicalTableNames: [],
    };
    await ensureExtensionDatabaseObjects({
      client: client as unknown as Parameters<typeof ensureExtensionDatabaseObjects>[0]["client"],
      schemaName: input.schemaName,
      plan,
      log: (msg: string) => console.log(msg),
    });
  } finally {
    await client.end().catch(() => {});
  }
}

export type EnsureExtensionDatabaseObjectsFn = typeof ensureExtensionDatabaseObjectsDefault;

export type ApplyMigrationsInput = {
  /** Absolute store dir of the materialized package (`…/<pkg>@<ver>/<digest>/`). */
  storeDir: string;
  /** Resolved package name (defaults to the store manifest's `name`). */
  packageName?: string;
  /** Resolved package version (informational logging only — the ledger is name-keyed). */
  packageVersion?: string;
  /** Host schema the migrations run against (default SUPABASE_SCHEMA / `cinatra`). */
  schema?: string;
  /**
   * Every OTHER installed package, for the prefix-collision refusal of enabler
   * 0.23 ("two names can normalise to one"). Absent = the caller has no
   * inventory to compare against; the derivation and identifier checks still
   * run.
   */
  installedPackageNames?: readonly string[];
};

export type ApplyMigrationsDeps = {
  /**
   * The extension migration runner (injected -> unit-testable without a
   * database). Defaults to the role-switching runner of plan (C) 8.3.
   */
  run?: typeof runExtensionMigrationsUnderRole;
  /**
   * The host-credential step that creates the extension's role and declared
   * tables before any extension statement runs (injected -> unit-testable
   * without a database).
   */
  ensureDatabaseObjects?: EnsureExtensionDatabaseObjectsFn;
};

/**
 * THE host-owned entry point (#118 consolidation): BOTH runner call sites —
 * the trusted boot/hot-activate pass (`runtime-package-loader.ts`) and the
 * install pipeline's pre-finalize step (`extension-install-pipeline.ts`) —
 * apply a package's migrations through this one function. Preflights
 * (validate-only), then runs the chain UP through the shared runner. A
 * package that declares no migrationsDir is a clean no-op; idempotent via
 * the shared ledger (a re-run applies nothing).
 */
export async function applyExtensionMigrationsFromStore(
  input: ApplyMigrationsInput,
  deps: ApplyMigrationsDeps = {},
): Promise<ExtensionMigrationsResult> {
  const preflight = await preflightExtensionMigrationsFromStore({
    storeDir: input.storeDir,
    ...(input.packageName ? { packageName: input.packageName } : {}),
  });
  const tablesPlan = await preflightExtensionDeclaredTablesFromStore({
    storeDir: input.storeDir,
    ...(input.packageName ? { packageName: input.packageName } : {}),
    ...(input.installedPackageNames
      ? { installedPackageNames: input.installedPackageNames }
      : {}),
  });
  // A package that declares neither is a clean no-op, exactly as before.
  if (!preflight && !tablesPlan) return { applied: [] };

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-migration-host");
  }
  // `||` (not `??`): a blank input.schema or SUPABASE_SCHEMA must fall
  // through to the default, never reach the runner as "".
  const schemaName = input.schema?.trim() || process.env.SUPABASE_SCHEMA?.trim() || DEFAULT_SCHEMA;
  const packageName = preflight?.packageName ?? tablesPlan?.packageName;
  if (!packageName) {
    throw new Error("[ext-migration] cannot resolve the package name for the migration road");
  }
  const roleName = extensionDatabaseRoleName(packageName);

  // THE HOST creates the tables and the role — before the extension's own
  // statements exist as a possibility (plan (C) 0.23).
  const ensure = deps.ensureDatabaseObjects ?? ensureExtensionDatabaseObjectsDefault;
  await ensure({ connectionString, schemaName, packageName, roleName, plan: tablesPlan });

  if (!preflight) return { applied: [] };

  const run = deps.run ?? runExtensionMigrationsUnderRole;
  const result = await run({
    connectionString,
    schemaName,
    dirAbs: preflight.dirAbs,
    namespace: preflight.namespace,
    roleName,
    direction: "up",
    log: (msg: string) => console.log(msg),
  } as Parameters<typeof runExtensionMigrationsUnderRole>[0]);
  return { applied: result.ranNames };
}

export type DiscoveredMigrationResult = {
  packageName: string;
  result: ExtensionMigrationsResult;
};

/** A materialized record the caller has ALREADY established as trusted. */
export type TrustedMigrationRecord = {
  packageName: string;
  storeDir: string;
  /**
   * The record's resolved version (cinatra#1040 S5). Present for side-by-side
   * version rows; `undefined`/null for the legacy single-version / unversioned
   * floor. Used only to ORDER a package's migration union (semver asc) — the
   * ledger namespace stays name-keyed.
   */
  version?: string | null;
  migrationsDir?: string;
  legacyMigrationsDeclared?: boolean;
  invalidMigrationsDirDeclared?: boolean;
};

/**
 * Apply declared migrations for a set of records the caller has ALREADY
 * trust-gated (the runtime loader's signed-trusted set — verified materialized
 * integrity + `classifyExtensionTrust(...).trusted` + tier `trusted-signed`).
 * This helper deliberately carries NO trust logic of its own: migrations must
 * run under the EXACT same verdict used for in-process import, so the loader
 * passes its trusted records here. Each record funnels through the single
 * entry point above. A record whose migration FAILS — including one that
 * still declares the retired legacy field — is reported in `refused` (the
 * loader then excludes it from activation: its tables would be missing, so
 * importing it is unsafe). A record that declares nothing is skipped.
 */
export async function applyMigrationsForTrustedRecords(
  records: readonly TrustedMigrationRecord[],
  deps: { applyOne?: typeof applyExtensionMigrationsFromStore } = {},
): Promise<{ applied: DiscoveredMigrationResult[]; refused: { packageName: string; error: string }[] }> {
  const applyOne = deps.applyOne ?? applyExtensionMigrationsFromStore;
  const applied: DiscoveredMigrationResult[] = [];
  const refused: { packageName: string; error: string }[] = [];
  // Every trusted package in this pass — the inventory 0.23's prefix-collision
  // refusal compares a derived prefix against (not only the ones that declare
  // migrations: a table-only package owns a prefix just the same).
  const installedInventory = [...new Set(records.map((r) => r.packageName))];
  for (const rec of records) {
    if (!recordDeclaresHostMigrations(rec)) continue;
    try {
      const result = await applyOne({
        storeDir: rec.storeDir,
        packageName: rec.packageName,
        installedPackageNames: installedInventory,
      });
      if (result.applied.length > 0) {
        console.log(`[ext-migration] ${rec.packageName}: applied ${result.applied.length} migration(s)`);
      }
      applied.push({ packageName: rec.packageName, result });
    } catch (e) {
      refused.push({ packageName: rec.packageName, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, refused };
}

/**
 * Deterministic semver-ASCENDING comparator for a package's side-by-side
 * version rows (cinatra#1040 S5). The unversioned/legacy floor (null/undefined)
 * sorts FIRST. Two versions that are semver-EQUAL but differ only in build
 * metadata (e.g. `1.0.0+a` vs `1.0.0+b`) are ordered by the raw version string
 * so the union order is stable across runs (codex round-0 determinism ruling).
 */
export function compareMigrationUnionVersionAsc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const cmp = comparePluginVersions(a, b); // a=installed, b=latest
  if (cmp === "update-available") return -1; // b > a  → a first
  if (cmp === "installed-newer") return 1; //  a > b  → a later
  // "current" (semver-equal, incl. build-metadata ties) → stable string order.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The CROSS-VERSION migration UNION (cinatra#1040 S5). Lifts S4's default-only
 * restriction: when a package is installed at SEVERAL versions side by side,
 * EVERY signed version's declared `cinatra.migrationsDir` contributes to the
 * package's single append-only ledger namespace, applied as an ORDERED UNION.
 *
 * Ordering: records group by packageName; each group applies in (semver ASC,
 * then the runner's per-dir filename order) — the shared name-keyed ledger is
 * idempotent per filename, so applying versions low→high realizes the ordered
 * union (a higher version that re-ships lower files is a no-op; its genuinely
 * new files append). This is "ordered PENDING migrations", not an absolute
 * historical replay: the append-only per-package namespace + authors owning
 * intra-package cross-version schema compat is the #1040 policy.
 *
 * Fail-closed, WHOLE-PACKAGE:
 *   1. PACKAGE-WIDE PREFLIGHT — every contributing version is validated
 *      (containment / namespace / no legacy JSON-DSL) BEFORE any DDL runs for
 *      that package. A single preflight failure refuses the WHOLE package with
 *      ZERO DDL applied (its schema would be partial / from an unverified dir).
 *   2. ORDERED APPLY — versions apply low→high; the FIRST apply failure STOPS
 *      the group and refuses the whole package (name-keyed): no later version
 *      of it may activate against a half-migrated schema.
 *
 * The caller (the runtime loader) supplies ONLY per-identity `trusted-signed`,
 * non-ambiguous records — an unsigned sibling that declares migrations is
 * refused UPSTREAM (never contributes DDL), exactly as in S4.
 */
export async function applyMigrationUnionForTrustedRecords(
  records: readonly TrustedMigrationRecord[],
  deps: {
    applyOne?: typeof applyExtensionMigrationsFromStore;
    preflightOne?: typeof preflightExtensionMigrationsFromStore;
  } = {},
): Promise<{ applied: DiscoveredMigrationResult[]; refused: { packageName: string; error: string }[] }> {
  const applyOne = deps.applyOne ?? applyExtensionMigrationsFromStore;
  const preflightOne = deps.preflightOne ?? preflightExtensionMigrationsFromStore;

  const byName = new Map<string, TrustedMigrationRecord[]>();
  for (const rec of records) {
    if (!recordDeclaresHostMigrations(rec)) continue;
    const bucket = byName.get(rec.packageName);
    if (bucket) bucket.push(rec);
    else byName.set(rec.packageName, [rec]);
  }

  const applied: DiscoveredMigrationResult[] = [];
  const refused: { packageName: string; error: string }[] = [];
  // See `applyMigrationsForTrustedRecords`: the pass IS the inventory 0.23's
  // prefix-collision refusal compares against.
  const installedInventory = [...new Set(records.map((r) => r.packageName))];

  for (const [packageName, recs] of byName) {
    const ordered = [...recs].sort((a, b) =>
      compareMigrationUnionVersionAsc(a.version, b.version),
    );

    // (1) PACKAGE-WIDE PREFLIGHT — validate every version BEFORE any DDL.
    try {
      for (const rec of ordered) {
        await preflightOne({ storeDir: rec.storeDir, packageName: rec.packageName });
      }
    } catch (e) {
      refused.push({
        packageName,
        error:
          `[migration-union] preflight failed for ${packageName} (no DDL applied for any of its ` +
          `${ordered.length} version(s)): ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    // (2) ORDERED APPLY — low→high; STOP the group on the first failure.
    try {
      const appliedNames: string[] = [];
      for (const rec of ordered) {
        const result = await applyOne({
          storeDir: rec.storeDir,
          packageName: rec.packageName,
          ...(rec.version ? { packageVersion: rec.version } : {}),
          // cinatra#3031 (plan (C) 0.23): the union IS the inventory the
          // prefix-collision refusal compares against — every other package in
          // this pass. Without it `@acme-co/thing` and `@acme_co/thing` both
          // normalise to `ext_acme_co_thing_` and share one role and one set of
          // tables, which is the collision the enabler refuses.
          installedPackageNames: installedInventory,
        });
        appliedNames.push(...result.applied);
      }
      if (appliedNames.length > 0) {
        console.log(
          `[ext-migration] ${packageName}: applied ${appliedNames.length} migration(s) as the ordered ` +
            `union across ${ordered.length} live version(s)`,
        );
      }
      applied.push({ packageName, result: { applied: appliedNames } });
    } catch (e) {
      refused.push({ packageName, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { applied, refused };
}


// The HOST half of extension-owned tables (cinatra#3031, epic #3023 W7; plan
// (C) enablers 0.23/0.24, technical notes 8.2/8.3/8.7).
//
// "The host, not the migration, creates the declared tables and indexes, from
// the declaration, under the prefix of item 0.24 and within the database's
// 63-byte identifier limit." So this module compiles a parsed declaration into
// DDL and executes it under the HOST credential — before any extension
// statement runs — and creates the extension's own database role with
// privileges on those tables and nothing else.
//
// WHAT THE ROLE MAY DO. `USAGE` on the application schema, and
// SELECT/INSERT/UPDATE/DELETE on the extension's OWN prefixed tables. Not
// CREATE, not TRUNCATE, not REFERENCES, and nothing at all on any other table
// — so an extension's data migration that touches another table, another
// extension's table or the migration ledger is refused BY THE DATABASE, which
// is the only place that refusal cannot be argued with.
//
// WHAT SURVIVES AN UNINSTALL. Nothing here drops anything: enabler 0.23 —
// "tables outlive an uninstall as the organisation's data until an
// organisation owner drops them explicitly". `CREATE TABLE IF NOT EXISTS` is
// what makes a reinstall a no-op over data that is already there.
//
// THE CATALOGUE COMPARE IS AN AUDIT, NEVER THE GUARD (§8.7). The guard is the
// role; the before/after catalogue is recorded so an operator can read what an
// install actually added.


/** The privileges an extension's role holds on its OWN tables, and no others. */
export const EXTENSION_TABLE_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE";

const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

export type ExtensionDeclaredTablesPlan = {
  packageName: string;
  /** `ext_<scope>_<slug>_` */
  prefix: string;
  /** The extension's own database role. */
  roleName: string;
  /** The parsed declaration. */
  tables: DeclaredTable[];
  /** Physical table names, prefix included. */
  physicalTableNames: string[];
};

/**
 * Compile a parsed declaration into the exact DDL the host executes. Pure, so
 * the shape of what an extension can make the host run is readable in a test
 * rather than only in a database.
 */
export function buildDeclaredTableQueries(input: {
  schemaName: string;
  packageName: string;
  roleName: string;
  tables: readonly DeclaredTable[];
}): string[] {
  const s = q(input.schemaName);
  const role = q(input.roleName);
  const out: string[] = [];
  for (const table of input.tables) {
    const physical = declaredTablePhysicalName(input.packageName, table.name);
    const cols = table.columns.map((c) => {
      const parts = [q(c.name), c.type];
      if (c.notNull) parts.push("NOT NULL");
      if (c.default !== null) parts.push(`DEFAULT ${c.default}`);
      return parts.join(" ");
    });
    const pk = table.columns.filter((c) => c.primaryKey).map((c) => q(c.name));
    if (pk.length > 0) cols.push(`PRIMARY KEY (${pk.join(", ")})`);
    out.push(`CREATE TABLE IF NOT EXISTS ${s}.${q(physical)} (${cols.join(", ")})`);
    for (const idx of table.indexes) {
      const physicalIdx = declaredIndexPhysicalName(input.packageName, idx.name);
      out.push(
        `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(physicalIdx)} ` +
          `ON ${s}.${q(physical)} (${idx.columns.map(q).join(", ")})`,
      );
    }
    out.push(
      `GRANT ${EXTENSION_TABLE_PRIVILEGES} ON ${s}.${q(physical)} TO ${role}`,
    );
  }
  return out;
}

/** The DDL that puts the extension's role in place, with nothing but schema usage. */
export function buildExtensionRoleQueries(input: {
  schemaName: string;
  roleName: string;
}): string[] {
  const s = q(input.schemaName);
  const role = q(input.roleName);
  return [
    // Start from nothing every time: a re-install must not inherit a grant an
    // earlier declaration handed out and this one no longer names. The TABLE
    // grants are revoked too, not only the schema's: a version that declared
    // `a` and `b` and then declares only `a` keeps `b` (declared tables are
    // retained on uninstall, 0.23), and a table ACL the host never withdrew
    // would leave the role reaching a table its current declaration does not
    // name. PostgreSQL warns rather than errors for a table the role holds
    // nothing on, so this is safe on a first install.
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} FROM ${role}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} FROM ${role}`,
    `REVOKE ALL PRIVILEGES ON SCHEMA ${s} FROM ${role}`,
    `GRANT USAGE ON SCHEMA ${s} TO ${role}`,
  ];
}

/**
 * Resolve the plan for one package: parse its declaration, derive the prefix
 * and role, and refuse a prefix that collides with an installed extension's.
 * Pure — no database.
 */
export function planExtensionDeclaredTables(input: {
  packageName: string;
  declaredTables: unknown;
  /** Every OTHER installed package, for the collision refusal of 0.23. */
  installedPackageNames?: readonly string[];
}): ExtensionDeclaredTablesPlan | null {
  const tables = parseDeclaredTables(input.declaredTables, input.packageName);
  if (tables.length === 0) return null;
  assertNoDeclaredTablePrefixCollision(input.packageName, input.installedPackageNames ?? []);
  return {
    packageName: input.packageName,
    prefix: extensionTablePrefix(input.packageName),
    roleName: extensionDatabaseRoleName(input.packageName),
    tables,
    physicalTableNames: tables.map((t) => declaredTablePhysicalName(input.packageName, t.name)),
  };
}

type MinimalClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/** The application schema's table catalogue — the before/after audit of §8.7. */
export async function readSchemaCatalogue(
  client: MinimalClient,
  schemaName: string,
): Promise<string[]> {
  const res = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [schemaName],
  );
  return (res.rows as { table_name: string }[]).map((r) => r.table_name);
}

/** What an install added or removed from the catalogue, as an audit record. */
export function compareCatalogues(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((t) => !b.has(t)),
    removed: before.filter((t) => !a.has(t)),
  };
}

/**
 * Create the role and the declared tables, under the HOST credential. The
 * caller owns the connection so the install path can do this on the same client
 * it does everything else on.
 */
export async function ensureExtensionDatabaseObjects(input: {
  client: MinimalClient;
  schemaName: string;
  plan: ExtensionDeclaredTablesPlan;
  log?: (msg: string) => void;
}): Promise<{ created: string[]; catalogue: { added: string[]; removed: string[] } }> {
  const { client, schemaName, plan } = input;
  const log = input.log ?? (() => {});
  const before = await readSchemaCatalogue(client, schemaName);

  const roleRow = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [plan.roleName]);
  if ((roleRow.rowCount ?? 0) === 0) {
    // NOLOGIN: this role is only ever assumed with SET ROLE by the host; it is
    // not a credential anybody connects with, and there is nothing to leak.
    await client.query(`CREATE ROLE ${q(plan.roleName)} NOLOGIN NOINHERIT`);
    log(`[ext-tables] created the database role ${plan.roleName} for ${plan.packageName}`);
  }
  for (const sql of buildExtensionRoleQueries({ schemaName, roleName: plan.roleName })) {
    await client.query(sql);
  }
  for (const sql of buildDeclaredTableQueries({
    schemaName,
    packageName: plan.packageName,
    roleName: plan.roleName,
    tables: plan.tables,
  })) {
    await client.query(sql);
  }

  const after = await readSchemaCatalogue(client, schemaName);
  const catalogue = compareCatalogues(before, after);
  if (catalogue.added.length > 0 || catalogue.removed.length > 0) {
    log(
      `[ext-tables] ${plan.packageName}: catalogue audit — added [${catalogue.added.join(", ")}] ` +
        `removed [${catalogue.removed.join(", ")}]`,
    );
  }
  return { created: plan.physicalTableNames, catalogue };
}
