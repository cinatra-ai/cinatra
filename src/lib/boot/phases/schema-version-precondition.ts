// Schema-version precondition boot phase (cinatra#789 item 4).
//
// Wraps the pure verdict in `@/lib/boot/schema-version-precondition` with the boot
// policy + the actual DB/disk reads. Runs AFTER the core-migrations phase and BEFORE
// extension activation, so in the normal prod path the chain has already been applied
// (applied_max == shipped_max -> pass). It CATCHES the case where migrations were
// SKIPPED (DB reachable now but the boot migrate step could not run) yet the schema
// is behind — turning a cryptic downstream error into a clear, actionable abort.
//
// Policy: `fatal` — prod throws on "behind"; the dev/prod split is inside the body
// (dev logs + returns, so the phase is `ok` in dev). Skips cleanly when the DB is not
// configured (fresh install) or the ledger table does not exist yet (a schema that has
// never been bootstrapped — nothing to compare against; core-migrations owns that).
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import { readdirSync } from "node:fs";
import path from "node:path";

import type { BootPhase } from "@/lib/boot/boot-phase";
import { evaluateSchemaVersion } from "@/lib/boot/schema-version-precondition";
import { getAppRuntimeMode } from "@/lib/runtime-mode";

function inProdMode(): boolean {
  // getAppRuntimeMode() honors BOTH CINATRA_RUNTIME_MODE and APP_RUNTIME_MODE and
  // defaults unset -> development, matching the required-env preflight's predicate.
  return getAppRuntimeMode() === "production";
}

// Where the image ships the core migrations (Dockerfile COPYs migrations/ to /app;
// the runner resolves migrations/core relative to process.cwd() = /app).
const CORE_MIGRATIONS_DIR_REL = path.join("migrations", "core");

export function schemaVersionPreconditionPhases(): BootPhase[] {
  return [
    {
      name: "schema-version-precondition",
      policy: "fatal",
      run: async () => {
        if (process.env.CINATRA_DISABLE_SCHEMA_VERSION_PRECONDITION === "true") {
          return { skipped: "disabled via CINATRA_DISABLE_SCHEMA_VERSION_PRECONDITION" };
        }

        const prod = inProdMode();

        // Resolve the DB connection; a missing URL is a fresh install (pre-setup) —
        // skip. In prod the required-env preflight already guaranteed the URL, so this
        // skip branch is effectively dev-only there.
        const { getPostgresConnectionString, postgresSchema } = await import(
          "@/lib/postgres-config"
        );
        let connectionString: string;
        try {
          connectionString = getPostgresConnectionString();
        } catch {
          return { skipped: "SUPABASE_DB_URL not configured (fresh install)" };
        }

        // Enumerate the shipped core migration files.
        let shippedFileNames: string[];
        try {
          shippedFileNames = readdirSync(path.join(process.cwd(), CORE_MIGRATIONS_DIR_REL));
        } catch {
          // No migrations dir shipped (unexpected in prod, but nothing to assert).
          return { skipped: "no core migrations directory on disk" };
        }

        const { CORE_MIGRATIONS_TABLE } = await import(
          "@/lib/boot/schema-version-precondition"
        );
        const { runPostgresQueriesSync, quotePostgresIdentifier } = await import(
          "@/lib/postgres-sync"
        );

        const schemaIdent = quotePostgresIdentifier(postgresSchema);
        const tableIdent = quotePostgresIdentifier(CORE_MIGRATIONS_TABLE);

        // If the ledger table does not exist yet, the schema was never bootstrapped —
        // there is nothing to compare against (core-migrations/setup owns first-boot).
        let ledgerNames: string[];
        try {
          const [existsRes] = runPostgresQueriesSync({
            connectionString,
            queries: [
              {
                text: `SELECT to_regclass('${postgresSchema.replaceAll("'", "''")}.${CORE_MIGRATIONS_TABLE}') AS t`,
                values: [],
              },
            ],
          });
          const regclass = existsRes?.rows?.[0]?.t;
          if (!regclass) {
            return { skipped: "migration ledger table not present (fresh/unbootstrapped schema)" };
          }
          const [ledgerRes] = runPostgresQueriesSync({
            connectionString,
            queries: [
              { text: `SELECT name FROM ${schemaIdent}.${tableIdent}`, values: [] },
            ],
          });
          ledgerNames = ((ledgerRes?.rows ?? []) as Array<{ name?: unknown }>)
            .map((r) => (typeof r.name === "string" ? r.name : ""))
            .filter(Boolean);
        } catch (err) {
          // DB unreachable / query error: parity with core-migrations' skip-on-connect
          // tolerance — do not abort boot on a transient DB blip; the app cannot serve
          // DB reads anyway and the next boot re-checks.
          console.warn(
            "[schema-version-precondition] could not read the migration ledger — skipping this boot " +
              "(retries next boot):",
            err instanceof Error ? err.message : err,
          );
          return { skipped: "migration ledger unreadable this boot" };
        }

        const verdict = evaluateSchemaVersion(ledgerNames, shippedFileNames);
        if (verdict.kind === "behind") {
          console.error(verdict.message);
          if (prod) throw new Error(verdict.message);
          console.warn(
            "[schema-version-precondition] schema behind — continuing in development mode " +
              "(run `pnpm db:migrate`).",
          );
          return;
        }
        if (verdict.kind === "ok") {
          console.info(
            `[schema-version-precondition] DB core schema current (applied core__` +
              `${String(verdict.appliedMax).padStart(4, "0")} >= shipped core__` +
              `${String(verdict.shippedMax).padStart(4, "0")}).`,
          );
        }
      },
    },
  ];
}
