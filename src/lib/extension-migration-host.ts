import "server-only";

// Host-side ACTIVATION of the declarative extension-migration runner (the
// runtime installer). The runner + DSL + ledger are pure/unit-tested
// (`extension-migration-runner.ts`); THIS module is the production wiring that
// the install pipeline + the boot pass call:
//
//   1. read a materialized package's `cinatra.migrations[]` from the store,
//   2. load + validate the declarative specs (host-owned, constrained DSL),
//   3. apply them via `runExtensionMigrations` inside a single transaction that
//      holds the `cinatra-schema-init` advisory lock — so extension DDL is
//      serialized against `ensurePostgresSchema`'s schema-init DDL
//      (over-serialization is acceptable for DDL correctness).
//
// `ctx.db` stays UNWIRED: the extension never receives a DB handle. Owned-table
// migrations + backfills are declared and run HOST-SIDE here (the host injects
// `org_id`), which is the architecturally-correct reflection of the model-B rule
// (a runtime-loaded extension — even across an isolation boundary — could not
// carry a DB handle). DORMANT until a real consumer: no extension declares
// `cinatra.migrations`, so every call is a clean no-op.

import {
  loadMigrationSpecsFromStore,
  runExtensionMigrations,
  type MigrationQuery,
  type RunMigrationsResult,
} from "@/lib/extension-migration-runner";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

// ---------------------------------------------------------------------------
// Lazy default DB pool (globalThis-cached — never a top-level pool, to keep
// `next build` page-data collection from throwing without a DB URL). Mirrors
// the pattern in `extension-install-ops.ts`.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraExtMigrationPool: import("pg").Pool | undefined;
}

let migrationPoolInstance: import("pg").Pool | undefined;
async function getMigrationPool(): Promise<import("pg").Pool> {
  if (migrationPoolInstance) return migrationPoolInstance;
  if (globalThis.__cinatraExtMigrationPool) {
    return (migrationPoolInstance = globalThis.__cinatraExtMigrationPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-migration-host");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-migration-host] pg pool idle client error:", err.message);
    });
  }
  migrationPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraExtMigrationPool = pool;
  }
  return pool;
}

/**
 * Default locked-transaction runner: a pooled client opens a transaction, takes
 * the SAME `cinatra-schema-init` advisory lock `ensurePostgresSchema` uses (so
 * extension DDL never races schema-init DDL), runs the migration batch, and
 * commits — rolling back (and rethrowing) on any failure so a bad migration
 * leaves no partial DDL. Tests inject their own `runLocked` (no DB, no lock).
 */
async function defaultRunLocked(
  run: (query: MigrationQuery) => Promise<RunMigrationsResult>,
): Promise<RunMigrationsResult> {
  const pool = await getMigrationPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // xact-scoped advisory lock on the same key as ensurePostgresSchema's
    // session-scoped lock — they contend on the same advisory-lock space, so
    // extension DDL is serialized against schema-init DDL. Auto-released on
    // COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["cinatra-schema-init"]);
    const result = await run(async <T = unknown>(text: string, values?: readonly unknown[]) => {
      const r = await client.query(text, values ? [...values] : undefined);
      return r.rows as T[];
    });
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure — surface the original error */
    }
    throw e;
  } finally {
    client.release();
  }
}

export type ApplyMigrationsInput = {
  /** Absolute store dir of the materialized package (`…/<pkg>@<ver>/<digest>/`). */
  storeDir: string;
  /** Resolved package name (defaults to the store manifest's `name`). */
  packageName?: string;
  /** Resolved package version (defaults to the store manifest's `version`). */
  packageVersion?: string;
  /** Host schema the migrations run against (default `cinatra`). */
  schema?: string;
};

export type ApplyMigrationsDeps = {
  /** Read a file as utf8 (default: `node:fs/promises`). */
  readFile?: (absPath: string) => Promise<string>;
  /**
   * Run the migration batch inside a locked transaction (default: pooled client
   * + BEGIN + `pg_advisory_xact_lock('cinatra-schema-init')` + COMMIT/ROLLBACK).
   * Tests inject a fake that just calls `run(fakeQuery)` — no DB, no lock.
   */
  runLocked?: (run: (query: MigrationQuery) => Promise<RunMigrationsResult>) => Promise<RunMigrationsResult>;
};

/**
 * Apply a materialized package's declared `cinatra.migrations[]` (the host-run
 * activation entry point). Resolves the descriptors from the store manifest,
 * loads + validates the specs, and applies them idempotently under the schema
 * advisory lock. A package that declares none is a clean no-op (the dormant
 * common case). An unreadable/invalid manifest is treated as "no migrations"
 * (the loader/installer already validated structure; this is defensive).
 */
export async function applyExtensionMigrationsFromStore(
  input: ApplyMigrationsInput,
  deps: ApplyMigrationsDeps = {},
): Promise<RunMigrationsResult> {
  const schema = input.schema ?? schemaName;
  const readFile =
    deps.readFile ?? (async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8"));
  const path = await import("node:path");

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(input.storeDir, "package.json"));
  } catch {
    return { applied: [], skipped: [] };
  }
  let manifest: { name?: unknown; version?: unknown; cinatra?: { migrations?: unknown } };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    return { applied: [], skipped: [] };
  }

  const rawMigrations = manifest.cinatra?.migrations;
  const migrations = Array.isArray(rawMigrations)
    ? rawMigrations.flatMap((m) =>
        m &&
        typeof m === "object" &&
        typeof (m as { id?: unknown }).id === "string" &&
        typeof (m as { path?: unknown }).path === "string"
          ? [{ id: (m as { id: string }).id, path: (m as { path: string }).path }]
          : [],
      )
    : [];
  if (migrations.length === 0) return { applied: [], skipped: [] };

  const packageName = input.packageName ?? (typeof manifest.name === "string" ? manifest.name : null);
  if (!packageName) {
    throw new Error("[ext-migration] cannot resolve package name from store manifest");
  }
  const packageVersion =
    input.packageVersion ?? (typeof manifest.version === "string" ? manifest.version : "0.0.0");

  const specs = await loadMigrationSpecsFromStore(
    { packageName, storeDir: input.storeDir, migrations },
    { readFile },
  );

  const runLocked = deps.runLocked ?? defaultRunLocked;
  return runLocked((query) => runExtensionMigrations({ packageName, packageVersion, specs }, { query, schema }));
}

export type DiscoveredMigrationResult = {
  packageName: string;
  result: RunMigrationsResult;
};

/** A materialized record the caller has ALREADY established as trusted. */
export type TrustedMigrationRecord = {
  packageName: string;
  storeDir: string;
  migrations?: readonly { id: string; path: string }[];
};

/**
 * Apply declared migrations for a set of records the caller has ALREADY
 * trust-gated (the runtime loader's `trusted[]` set — verified materialized
 * integrity + `classifyExtensionTrust(...).trusted`). This helper deliberately
 * carries NO trust logic of its own: migrations must run under the EXACT same
 * verdict used for in-process import, so the loader passes its trusted records
 * here. A record whose migration FAILS is reported in `refused` (the loader then
 * excludes it from activation — its tables would be missing, so importing it is
 * unsafe). Idempotent via the ledger; a record that declares none is skipped.
 */
export async function applyMigrationsForTrustedRecords(
  records: readonly TrustedMigrationRecord[],
  deps: { applyOne?: typeof applyExtensionMigrationsFromStore } = {},
): Promise<{ applied: DiscoveredMigrationResult[]; refused: { packageName: string; error: string }[] }> {
  const applyOne = deps.applyOne ?? applyExtensionMigrationsFromStore;
  const applied: DiscoveredMigrationResult[] = [];
  const refused: { packageName: string; error: string }[] = [];
  for (const rec of records) {
    if (!rec.migrations || rec.migrations.length === 0) continue;
    try {
      const result = await applyOne({ storeDir: rec.storeDir, packageName: rec.packageName });
      if (result.applied.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ext-migration] ${rec.packageName}: applied ${result.applied.length} migration(s)`);
      }
      applied.push({ packageName: rec.packageName, result });
    } catch (e) {
      refused.push({ packageName: rec.packageName, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, refused };
}
