// Bootstrap Better Auth schema migration runner.
//
// Replaces `better-auth migrate --config src/lib/auth.ts`. That CLI loads the
// runtime auth module through jiti, but src/lib/auth.ts barrel-imports the
// whole Next.js app (server-only, React, app aliases, a top-level DB read) and
// cannot be loaded outside the bundler. This runner rebuilds an equivalent
// Better Auth config from published packages only and applies the migration
// programmatically via better-auth's own `getMigrations()`.
//
// Runs in plain Node — no jiti, no tsx, no `better-auth` CLI. Node executes
// this `.mts` (and the imported `.ts`) directly via native type-stripping,
// which is on by default in Node >= 22.18 / >= 23.6; `scripts/setup.sh`
// requires Node >= 24. Keep this file's syntax fully erasable (no enum /
// namespace / decorators) and import the shared module with its `.ts`
// extension so the strip-types loader resolves it.
//
// SINGLE SOURCE OF TRUTH: the plugin TUPLE (and the schema-bearing data
// it carries) flows from `src/lib/better-auth-plugins.ts` — shared with the
// runtime `src/lib/auth.ts`. The MCP auth pair is built here with placeholder
// behavioral inputs (audiences / page paths / scopes / TTLs are all
// schema-irrelevant for the migration; only plugin presence matters). The
// drift-guard test (`src/lib/__tests__/better-auth-schema.test.ts`) deep-
// equals the schema this runner produces against a runtime-equivalent shape
// built from the SAME factory. A new top-level CI job
// (`auth-schema-drift`) gates PRs on both that test and `pnpm typecheck`
// (which catches a stray push outside the factory via the precise tuple
// annotation in `src/lib/auth.ts`).
import { pathToFileURL } from "node:url";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import {
  buildCinatraBetterAuthPlugins,
  buildMcpAuthPlugins,
  cinatraAuthAdditionalUserFields,
  DEFAULT_MCP_SCOPES,
} from "../src/lib/better-auth-plugins.ts";

export interface BetterAuthMigrationConfig {
  /** Postgres connection string. */
  connectionString: string;
  /** BETTER_AUTH_SECRET. */
  secret: string;
  /** Better Auth base URL (optional; only behavioral). */
  baseURL?: string;
}

/**
 * Build the Better Auth options for the bootstrap migration — schema-bearing
 * config only, no `database` / `secret` (so it is reusable by the drift test
 * via `getSchema()`).
 *
 * The plugin tuple flows from the shared `buildCinatraBetterAuthPlugins`
 * factory. The MCP auth pair is built locally with placeholder behavioral
 * inputs — audiences / page paths / scopes / TTLs are option-independent for
 * the migration's purposes (their schema contribution is identical
 * regardless), so the placeholders are schema-equivalent to whatever the
 * runtime resolves at request time.
 */
export function buildMigrationAuthOptions() {
  return {
    appName: "Cinatra",
    user: { additionalFields: cinatraAuthAdditionalUserFields },
    emailAndPassword: { enabled: true },
    plugins: buildCinatraBetterAuthPlugins({
      mcpAuthPlugins: buildMcpAuthPlugins({
        // Schema-irrelevant placeholder — oauth-provider's schema does not
        // depend on the audience set; the runtime computes the real set via
        // getPublicMcpServerUrl(). A non-empty list is required because the
        // option is required in the pure builder (self-documenting).
        validAudiences: ["http://localhost:3000/api/mcp"],
        scopes: DEFAULT_MCP_SCOPES,
        loginPage: "/api/mcp/auth/sign-in",
        consentPage: "/api/mcp/consent",
        signupPage: "/api/mcp/auth/sign-up",
      }),
    }),
  };
}

/**
 * Apply the Better Auth schema migration against the given database.
 * Importing this module has no side effects — callers invoke this explicitly.
 */
export async function runBetterAuthMigration(
  config: BetterAuthMigrationConfig,
): Promise<{ created: string[]; columnSetsAdded: number }> {
  if (!config.connectionString) {
    throw new Error("runBetterAuthMigration: `connectionString` is required.");
  }
  if (!config.secret) {
    throw new Error("runBetterAuthMigration: `secret` is required.");
  }

  const pool = new pg.Pool({ connectionString: config.connectionString });
  try {
    const auth = betterAuth({
      ...buildMigrationAuthOptions(),
      baseURL: config.baseURL ?? "http://localhost:3000",
      secret: config.secret,
      database: pool,
    });

    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
      auth.options,
    );
    if (toBeCreated.length > 0 || toBeAdded.length > 0) {
      await runMigrations();
    }
    return {
      created: toBeCreated.map((entry) => entry.table),
      columnSetsAdded: toBeAdded.length,
    };
  } finally {
    await pool.end();
  }
}

// Direct invocation: `node --env-file-if-exists=.env.local scripts/better-auth-migrate.mts`
// (this is what the `auth:migrate` package.json script runs). The
// `-if-exists` variant is load-bearing for CI, where `.env.local` does
// not exist and the runner's env vars come straight from the workflow's
// `env:` block — Node would otherwise abort with "ENOENT .env.local"
// before reaching this code.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runBetterAuthMigration({
    connectionString: process.env.SUPABASE_DB_URL ?? "",
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    baseURL: process.env.BETTER_AUTH_URL,
  });
  console.log(
    `Better Auth migration: created [${
      result.created.join(", ") || "none"
    }], column-sets added ${result.columnSetsAdded}.`,
  );
}
