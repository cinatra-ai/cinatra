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
import type { Pool, PoolClient } from "pg";
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
 * Result of the app-owned `public."teamMember"."role"` provisioning step.
 */
export interface TeamMemberRoleProvisionResult {
  /** true when THIS run added the column (and ran the one-shot backfill). */
  provisioned: boolean;
  /** Rows promoted to 'admin' by the one-shot backfill (0 unless provisioned). */
  backfilledAdmins: number;
  /** Set when nothing could be done: the teamMember table does not exist. */
  skipped?: "table-missing";
  /**
   * Set when the column pre-existed and the shape-repair pass (NULL cleanup,
   * DEFAULT, NOT NULL, CHECK) could not be applied — e.g. out-of-vocabulary
   * role values. Non-fatal: the migration continues and the app degrades to
   * whatever the column supports.
   */
  repairFailed?: boolean;
}

/** Guarded ADD CONSTRAINT — `ADD CONSTRAINT` has no `IF NOT EXISTS`, so probe
 *  `pg_constraint` scoped to the table (`conrelid`), not by name alone. */
async function addRoleCheckConstraintIfMissing(client: PoolClient) {
  const existing = await client.query(
    `SELECT 1 FROM pg_constraint
      WHERE conname = 'teamMember_role_check'
        AND conrelid = 'public."teamMember"'::regclass`,
  );
  if ((existing.rowCount ?? 0) === 0) {
    await client.query(
      `ALTER TABLE public."teamMember"
         ADD CONSTRAINT "teamMember_role_check" CHECK ("role" IN ('member', 'admin'))`,
    );
  }
}

/**
 * Provision the per-team-member role column: app-owned, guarded, idempotent.
 *
 * WHY HERE and not via Better Auth config or a core migration (cinatra#1566):
 *  - better-auth 1.6.19's organization plugin has NO per-team-member role, and
 *    its `teamMember` schema branch ignores `additionalFields` — a config-only
 *    attempt typechecks but provisions nothing (upstream better-auth#5234).
 *    `getMigrations()` therefore never creates this column.
 *  - A `core__NNNN` migration cannot provision it either: the core chain is
 *    ledger-faked on fresh schemas (packages/migrations/src/core-migrations.mjs)
 *    on the assumption bootstrap DDL already produced the current shape — but
 *    `public."teamMember"` is created by `getMigrations()` WITHOUT the column,
 *    so fresh installs would never get it.
 *  - This runner executes on fresh installs AND on every `make setup` /
 *    `pnpm auth:migrate` / `cinatra setup prod` (the prod image bakes it as the
 *    auth-migrate bundle), so one guarded post-step covers both worlds.
 *
 * Vocabulary: `'member' | 'admin'` (library-consistent with org `member.role`);
 * the app maps `'admin'` to the authz kernel's `team_admin` at the read
 * boundary (`src/lib/auth-session.ts`).
 *
 * Backfill: ONLY when the column was created by this run, promote exactly one
 * row per team to 'admin' — the earliest member with a stable tie-break
 * (`DISTINCT ON ("teamId") … ORDER BY "teamId", "createdAt" ASC, id ASC`),
 * which is the creator for app-created teams (`src/app/teams/new/actions.ts`
 * inserts the creator's membership first).
 *
 * When the column PRE-exists (hand-provisioned or a re-run after a partial
 * failure), the backfill is skipped and a shape-repair pass runs instead:
 * NULL roles are coerced to 'member', then DEFAULT / NOT NULL / CHECK are
 * (re)applied. A repair failure (e.g. out-of-vocabulary values) is reported
 * but non-fatal.
 */
export async function ensureTeamMemberRoleColumn(
  pool: Pool,
): Promise<TeamMemberRoleProvisionResult> {
  const tableExists = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'teamMember'
     ) AS "exists"`,
  );
  if (!tableExists.rows[0]?.exists) {
    return { provisioned: false, backfilledAdmins: 0, skipped: "table-missing" };
  }

  const columnExists = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'teamMember'
         AND column_name = 'role'
     ) AS "exists"`,
  );
  const preExisting = Boolean(columnExists.rows[0]?.exists);

  // One checked-out client for the whole DDL+backfill unit — pool.query()
  // may hop connections between statements, which would break BEGIN/COMMIT.
  const client = await pool.connect();
  try {
    if (!preExisting) {
      // Fresh provisioning: column + CHECK + one-shot backfill, atomically.
      // A failure here MUST propagate — this is the provisioning path.
      try {
        await client.query("BEGIN");
        await client.query(
          `ALTER TABLE public."teamMember"
             ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member'`,
        );
        await addRoleCheckConstraintIfMissing(client);
        const backfilled = await client.query(
          `UPDATE public."teamMember" tm
              SET "role" = 'admin'
             FROM (
               SELECT DISTINCT ON ("teamId") id
                 FROM public."teamMember"
                ORDER BY "teamId", "createdAt" ASC, id ASC
             ) first
            WHERE tm.id = first.id`,
        );
        await client.query("COMMIT");
        return {
          provisioned: true,
          backfilledAdmins: backfilled.rowCount ?? 0,
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }

    // Column pre-exists: no backfill (it is one-shot by design), but make the
    // shape trustworthy — the app's roleless membership inserts rely on
    // DEFAULT 'member' + NOT NULL.
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE public."teamMember" SET "role" = 'member' WHERE "role" IS NULL`,
      );
      await client.query(
        `ALTER TABLE public."teamMember" ALTER COLUMN "role" SET DEFAULT 'member'`,
      );
      await client.query(
        `ALTER TABLE public."teamMember" ALTER COLUMN "role" SET NOT NULL`,
      );
      await addRoleCheckConstraintIfMissing(client);
      await client.query("COMMIT");
      return { provisioned: false, backfilledAdmins: 0 };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.warn(
        `better-auth-migrate: public."teamMember"."role" exists but its shape ` +
          `could not be repaired (DEFAULT/NOT NULL/CHECK): ${
            err instanceof Error ? err.message : String(err)
          }. Pre-existing malformed role columns are unsupported — fix the ` +
          `column manually, then re-run \`pnpm auth:migrate\`.`,
      );
      return { provisioned: false, backfilledAdmins: 0, repairFailed: true };
    }
  } finally {
    client.release();
  }
}

/**
 * Apply the Better Auth schema migration against the given database.
 * Importing this module has no side effects — callers invoke this explicitly.
 */
export async function runBetterAuthMigration(
  config: BetterAuthMigrationConfig,
): Promise<{
  created: string[];
  columnSetsAdded: number;
  teamMemberRole: TeamMemberRoleProvisionResult;
}> {
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
    // App-owned post-step (see ensureTeamMemberRoleColumn) — runs on every
    // invocation, AFTER getMigrations() has had its chance to create the
    // teamMember table on fresh installs.
    const teamMemberRole = await ensureTeamMemberRoleColumn(pool);
    return {
      created: toBeCreated.map((entry) => entry.table),
      columnSetsAdded: toBeAdded.length,
      teamMemberRole,
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
  const roleNote = result.teamMemberRole.skipped
    ? `skipped (${result.teamMemberRole.skipped})`
    : result.teamMemberRole.provisioned
      ? `provisioned (${result.teamMemberRole.backfilledAdmins} team admin(s) backfilled)`
      : result.teamMemberRole.repairFailed
        ? "present (shape repair FAILED — see warning above)"
        : "present";
  console.log(
    `Better Auth migration: created [${
      result.created.join(", ") || "none"
    }], column-sets added ${result.columnSetsAdded}, teamMember.role ${roleNote}.`,
  );
}
