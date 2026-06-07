import "server-only";

// Host-run declarative-migration runner for extension-owned storage
// (the installer). Applies an extension's validated, constrained
// migration specs (see `extension-migration-dsl.ts`) over the SHARED `cinatra`
// schema — the host owns ALL DDL; the extension never runs arbitrary SQL.
//
// Idempotent via the `extension_migrations(package_name, migration_id,
// migration_hash, package_version, applied_at)` ledger (created with the schema
// in `buildCreateStoreSchemaQueries`). A migration is applied once; re-running
// with the SAME content hash is a no-op; re-declaring the SAME id with a
// DIFFERENT hash is a HARD ERROR (migrations are immutable — a change needs a
// new id). Callers run this under the schema advisory lock.
//
// DORMANT until a real consumer: no extension declares `cinatra.migrations`
// (config/secrets/objects suffice), so the boot/install pass is a clean no-op.
// The `ctx.db` write path stays UNWIRED — owned-table backfills are expressed
// declaratively and run host-side here, never smuggled through `ctx.db.query()`.

import {
  compileMigrationSpec,
  migrationSpecHash,
  validateMigrationSpec,
  type ExtensionMigrationSpec,
  type MigrationOp,
} from "@/lib/extension-migration-dsl";
import type { PackageStoreRecord } from "@cinatra-ai/sdk-extensions";

/** Minimal async query surface the runner needs (injected → testable). */
export type MigrationQuery = <T = unknown>(text: string, values?: readonly unknown[]) => Promise<T[]>;

export type RunMigrationsInput = {
  packageName: string;
  packageVersion: string;
  specs: readonly ExtensionMigrationSpec[];
};

export type RunMigrationsDeps = {
  query: MigrationQuery;
  /** The host schema migrations run against (default `cinatra`). */
  schema?: string;
};

export type RunMigrationsResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Apply each migration spec for a package, idempotently + immutably. All specs
 * are validated BEFORE any DDL runs (one bad spec aborts the whole batch — no
 * partial application of an invalid set).
 */
export async function runExtensionMigrations(
  input: RunMigrationsInput,
  deps: RunMigrationsDeps,
): Promise<RunMigrationsResult> {
  const schema = deps.schema ?? "cinatra";
  // The schema is interpolated into the ledger queries below — guard it (the
  // compiler guards its own DDL, but the ledger SQL is built here).
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
    throw new Error(`[ext-migration] invalid schema name "${schema}"`);
  }
  // Validate the WHOLE batch first (fail closed before mutating anything).
  for (const spec of input.specs) {
    const v = validateMigrationSpec(spec, input.packageName);
    if (!v.ok) {
      throw new Error(
        `[ext-migration] ${input.packageName} migration "${spec.id}" is invalid: ${v.errors.join("; ")}`,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const spec of input.specs) {
    const hash = migrationSpecHash(spec);
    const existing = await deps.query<{ migration_hash: string }>(
      `SELECT migration_hash FROM "${schema}".extension_migrations WHERE package_name = $1 AND migration_id = $2`,
      [input.packageName, spec.id],
    );
    if (existing.length > 0) {
      if (existing[0].migration_hash !== hash) {
        throw new Error(
          `[ext-migration] ${input.packageName} migration "${spec.id}" was already applied with a DIFFERENT spec ` +
            `(migrations are immutable — declare a new id for a change)`,
        );
      }
      skipped.push(spec.id);
      continue;
    }
    for (const stmt of compileMigrationSpec(spec, input.packageName, schema)) {
      await deps.query(stmt.text);
    }
    await deps.query(
      `INSERT INTO "${schema}".extension_migrations (package_name, migration_id, migration_hash, package_version) ` +
        `VALUES ($1, $2, $3, $4) ON CONFLICT (package_name, migration_id) DO NOTHING`,
      [input.packageName, spec.id, hash, input.packageVersion],
    );
    applied.push(spec.id);
  }
  return { applied, skipped };
}

/**
 * Load a materialized package's declarative migration specs from the store. The
 * manifest's `cinatra.migrations[]` carries `{id, path}`; each `path` is a
 * within-package JSON file of the shape `{ ops: MigrationOp[] }`. Path is
 * containment-checked (no `..`/absolute) before read. Returns `[]` when the
 * record declares none (the dormant common case). Injected `readFile` →
 * testable.
 */
export async function loadExtensionMigrationSpecs(
  record: PackageStoreRecord,
  deps: { readFile: (absPath: string) => Promise<string> },
): Promise<ExtensionMigrationSpec[]> {
  return loadMigrationSpecsFromStore(
    { packageName: record.packageName, storeDir: record.storeDir, migrations: record.migrations ?? [] },
    deps,
  );
}

/**
 * Lower-level variant of {@link loadExtensionMigrationSpecs} that takes the raw
 * `{ packageName, storeDir, migrations }` triple instead of a full
 * `PackageStoreRecord`. The install-pipeline call-site has only a `storeDir`
 * (not a discovered record), so it resolves the migration descriptors from the
 * materialized `package.json` and feeds them here. Same path-containment safety
 * (no `..`/absolute escape out of `storeDir`).
 */
export async function loadMigrationSpecsFromStore(
  input: {
    packageName: string;
    storeDir: string;
    migrations: readonly { id: string; path: string }[];
  },
  deps: { readFile: (absPath: string) => Promise<string> },
): Promise<ExtensionMigrationSpec[]> {
  const specs: ExtensionMigrationSpec[] = [];
  for (const m of input.migrations) {
    const rel = m.path.replace(/^\.\//, "");
    if (rel.startsWith("/") || rel.split("/").some((seg) => seg === "..")) {
      throw new Error(`[ext-migration] ${input.packageName}: unsafe migration path "${m.path}"`);
    }
    const abs = `${input.storeDir.replace(/\/+$/, "")}/${rel}`;
    const raw = await deps.readFile(abs);
    let parsed: { ops?: unknown };
    try {
      parsed = JSON.parse(raw) as { ops?: unknown };
    } catch {
      throw new Error(`[ext-migration] ${input.packageName}: migration "${m.id}" is not valid JSON`);
    }
    if (!Array.isArray(parsed.ops)) {
      throw new Error(`[ext-migration] ${input.packageName}: migration "${m.id}" has no ops[]`);
    }
    specs.push({ id: m.id, ops: parsed.ops as MigrationOp[] });
  }
  return specs;
}
