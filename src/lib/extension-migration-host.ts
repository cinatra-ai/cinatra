import "server-only";

// Host-side application of EXTENSION migrations through the SHARED
// node-pg-migrate runner (#118; engine decision #115).
//
// Contract: a trusted-signed extension declares `cinatra.migrationsDir` — a
// package-relative directory of STANDARD node-pg-migrate ESM modules named
// `ext_<scope>_<pkg>__NNNN_<short-description>.mjs` (the per-source namespace
// for the shared `pgmigrations` ledger). The HOST runs them through
// `runNamespacedMigrations` (`@cinatra-ai/cli/core-migrations`): dedicated
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
  runNamespacedMigrations,
  validateNamespacedMigrationsDir,
} from "@cinatra-ai/cli/core-migrations";
import { recordDeclaresHostMigrations } from "@cinatra-ai/sdk-extensions";

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

export type ApplyMigrationsInput = {
  /** Absolute store dir of the materialized package (`…/<pkg>@<ver>/<digest>/`). */
  storeDir: string;
  /** Resolved package name (defaults to the store manifest's `name`). */
  packageName?: string;
  /** Resolved package version (informational logging only — the ledger is name-keyed). */
  packageVersion?: string;
  /** Host schema the migrations run against (default SUPABASE_SCHEMA / `cinatra`). */
  schema?: string;
};

export type ApplyMigrationsDeps = {
  /** The shared runner (injected -> unit-testable without a database). */
  run?: typeof runNamespacedMigrations;
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
  if (!preflight) return { applied: [] };

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-migration-host");
  }
  // `||` (not `??`): a blank input.schema or SUPABASE_SCHEMA must fall
  // through to the default, never reach the runner as "".
  const schemaName = input.schema?.trim() || process.env.SUPABASE_SCHEMA?.trim() || DEFAULT_SCHEMA;

  const run = deps.run ?? runNamespacedMigrations;
  const result = await run({
    connectionString,
    schemaName,
    dirAbs: preflight.dirAbs,
    namespace: preflight.namespace,
    direction: "up",
    log: (msg: string) => console.log(msg),
  });
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
  for (const rec of records) {
    if (!recordDeclaresHostMigrations(rec)) continue;
    try {
      const result = await applyOne({ storeDir: rec.storeDir, packageName: rec.packageName });
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
