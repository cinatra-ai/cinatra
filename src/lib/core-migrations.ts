// Boot-side policy wrapper around the core migration runner (cinatra#116).
//
// The runner implementation lives in `@cinatra-ai/cli/core-migrations`
// (packages/cli/src/core-migrations.mjs) — ONE source of truth shared with
// `cinatra setup` and `cinatra db migrate`, so the runner options can never
// drift between boot and ops. This module only adds the boot policy:
//
//   - missing SUPABASE_DB_URL          -> skip (fresh install pre-setup-wizard)
//   - bootstrap DDL fails / DB down    -> warn + skip (parity with today's
//     lazy-tolerant boot; the app cannot serve DB reads anyway, and the lazy
//     ensure path retries per-request)
//   - a MIGRATION fails                -> dev: loud error, keep booting;
//     prod: rethrow and abort boot. Serving current code against a
//     half-migrated schema is worse than not serving.
//
// Ordering: instrumentation calls this BEFORE cache warm / extension
// activation / queue workers, and `ensurePostgresSchema()` runs first here —
// the idempotent bootstrap DDL is the baseline the versioned chain assumes.
//
// Deliberately NOT importing "server-only": vitest unit tests import this
// module directly.

import { runCoreMigrations } from "@cinatra-ai/cli/core-migrations";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";

type CoreMigrationsResult = Awaited<ReturnType<typeof runCoreMigrations>>;

export type BootMigrationsDeps = {
  run?: typeof runCoreMigrations;
  ensureSchema?: typeof ensurePostgresSchema;
  getConnectionString?: typeof getPostgresConnectionString;
  isDevMode?: typeof isAppDevelopmentMode;
  log?: (msg: string) => void;
  logError?: (msg: string, err?: unknown) => void;
};

export type BootMigrationsOutcome =
  | { status: "applied"; ranNames: string[] }
  | { status: "noop" }
  | { status: "skipped"; reason: "no-database-url" | "bootstrap-unavailable" }
  | { status: "failed-dev" };

/**
 * Run the core migration chain at boot under the policy above.
 * Throws ONLY in production mode, and only for a real migration failure.
 */
export async function runCoreMigrationsAtBoot(
  deps: BootMigrationsDeps = {},
): Promise<BootMigrationsOutcome> {
  const {
    run = runCoreMigrations,
    ensureSchema = ensurePostgresSchema,
    getConnectionString = getPostgresConnectionString,
    isDevMode = isAppDevelopmentMode,
    log = (msg) => console.log(msg),
    logError = (msg, err) => console.error(msg, err ?? ""),
  } = deps;

  let connectionString: string;
  try {
    connectionString = getConnectionString();
  } catch {
    log("[core-migrations] SUPABASE_DB_URL not configured — skipping migrations (fresh install)");
    return { status: "skipped", reason: "no-database-url" };
  }

  try {
    // Bootstrap DDL first: idempotent, advisory-locked, and the baseline the
    // versioned chain assumes (wrappers no-op against a bootstrapped schema).
    ensureSchema();
  } catch (err) {
    logError(
      "[core-migrations] bootstrap DDL unavailable — skipping migrations this boot (they re-run on the next boot / `cinatra db migrate`):",
      err,
    );
    return { status: "skipped", reason: "bootstrap-unavailable" };
  }

  let result: CoreMigrationsResult;
  try {
    result = await run({
      connectionString,
      schemaName: postgresSchema,
      rootDir: process.cwd(),
      direction: "up",
      log,
    });
  } catch (err) {
    if ((err as { phase?: string })?.phase === "connect") {
      logError(
        "[core-migrations] database unreachable — skipping migrations this boot (they re-run on the next boot / `cinatra db migrate`):",
        err,
      );
      return { status: "skipped", reason: "bootstrap-unavailable" };
    }
    if (isDevMode()) {
      logError(
        "[core-migrations] MIGRATION FAILED — continuing in development mode. The schema may be behind the code; fix the migration and re-run `pnpm db:migrate` (or reboot):",
        err,
      );
      return { status: "failed-dev" };
    }
    logError(
      "[core-migrations] MIGRATION FAILED — aborting production boot (serving this code against a half-migrated schema is unsafe). Fix the migration, or roll back the image:",
      err,
    );
    throw err;
  }

  if (result.ranNames.length > 0) {
    log(`[core-migrations] applied ${result.ranNames.length} migration(s): ${result.ranNames.join(", ")}`);
    return { status: "applied", ranNames: result.ranNames };
  }
  return { status: "noop" };
}
