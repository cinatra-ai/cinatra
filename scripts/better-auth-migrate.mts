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
}

/**
 * Result of the app-owned session activation-guard trigger provisioning step
 * (cinatra#1937, archive program S1).
 */
export interface SessionActivationGuardResult {
  /** true when the function + trigger were (re)defined this run. */
  provisioned: boolean;
  /** Set when nothing could be done: a referenced table does not exist. */
  skipped?: "table-missing";
}

/**
 * Result of the app-owned `public."organization"."name"` non-blank guard
 * provisioning step (cinatra#1942, archive program S6 — the empty-name rider).
 */
export interface OrganizationNameNotBlankResult {
  /** true when THIS run added (or replaced) the non-blank CHECK constraint. */
  provisioned: boolean;
  /** Rows whose blank name (empty or space-only per btrim) was backfilled. */
  backfilledNames: number;
  /** Set when nothing could be done: the organization table does not exist. */
  skipped?: "table-missing";
}

/**
 * The session activation-guard function + trigger DDL (cinatra#1937).
 *
 * WHY a trigger and not app code: Better Auth's own transactions (set-active,
 * session create) cannot be wrapped externally — per the #1510 archive
 * program spec, its managed `session` table gets a table-level guard so NO
 * writer (HTTP route, auth.api.*, future code path) can point a session at an
 * archived organization, directly or via a team.
 *
 * Semantics (independently per field, codex-converged):
 *  - Fires BEFORE INSERT, and BEFORE UPDATE OF "activeOrganizationId" /
 *    "activeTeamId" (the OF list restricts UPDATE only; INSERT always fires
 *    and validates whatever non-null values it carries).
 *  - For EACH of the two fields that is non-null and (on UPDATE) changed:
 *    resolve its organization — "activeOrganizationId" directly,
 *    "activeTeamId" via public.team."organizationId" — lock that org row
 *    `FOR SHARE ... NOWAIT`, and refuse when the row is missing (dangling id,
 *    fail closed) or `"archivedAt" IS NOT NULL`.
 *  - Clearing a field to NULL never blocks, and never suppresses the OTHER
 *    field's validation. Lock contention (55P03) propagates as a refusal per
 *    the program spec.
 *  - DARK: until an organization row actually carries a non-null
 *    "archivedAt" (S6 flips the production gate), the refusal paths are
 *    unreachable in production — the guard is provisioned but inert.
 *
 * Identifiers are the exact quoted camelCase column names Better Auth
 * provisions; the SQL-shape test pins them.
 */
export const SESSION_ACTIVATION_GUARD_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION public.cinatra_session_activation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $cinatra_guard$
DECLARE
  org_archived_at timestamptz;
BEGIN
  IF NEW."activeOrganizationId" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW."activeOrganizationId" IS DISTINCT FROM OLD."activeOrganizationId") THEN
    SELECT o."archivedAt" INTO org_archived_at
      FROM public.organization o
     WHERE o.id = NEW."activeOrganizationId"
       FOR SHARE OF o NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cinatra-session-activation-guard: activation-target-missing (organization %)',
        NEW."activeOrganizationId";
    END IF;
    IF org_archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'cinatra-session-activation-guard: organization-archived (%)',
        NEW."activeOrganizationId";
    END IF;
  END IF;

  IF NEW."activeTeamId" IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW."activeTeamId" IS DISTINCT FROM OLD."activeTeamId") THEN
    SELECT o."archivedAt" INTO org_archived_at
      FROM public.team t
      JOIN public.organization o ON o.id = t."organizationId"
     WHERE t.id = NEW."activeTeamId"
       FOR SHARE OF o NOWAIT;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cinatra-session-activation-guard: activation-target-missing (team %)',
        NEW."activeTeamId";
    END IF;
    IF org_archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'cinatra-session-activation-guard: team-organization-archived (%)',
        NEW."activeTeamId";
    END IF;
  END IF;

  RETURN NEW;
END;
$cinatra_guard$;
`.trim();

export const SESSION_ACTIVATION_GUARD_TRIGGER_SQL = `
CREATE OR REPLACE TRIGGER cinatra_session_activation_guard
BEFORE INSERT OR UPDATE OF "activeOrganizationId", "activeTeamId" ON public.session
FOR EACH ROW EXECUTE FUNCTION public.cinatra_session_activation_guard()
`.trim();

/**
 * Provision (or repair) the session activation-guard trigger. Idempotent by
 * construction: `CREATE OR REPLACE FUNCTION` + `CREATE OR REPLACE TRIGGER`
 * (PG floor is 18; OR-REPLACE-TRIGGER needs 14+) redefine in place, and BOTH
 * run inside ONE transaction serialized by a constant-key advisory xact-lock —
 * a live repair run never leaves a window without the guard, and concurrent
 * runners cannot interleave definitions. Any failure rolls back and rethrows
 * (a session table without the guard must not be silently enabled once
 * archive activates — same fail-loud contract as ensureTeamMemberRoleColumn).
 */
export async function ensureSessionActivationGuardTrigger(
  pool: Pool,
): Promise<SessionActivationGuardResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('cinatra-migrations'), hashtext('session.activationGuard'))`,
    );

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('session', 'organization', 'team')`,
    );
    const present = new Set(tables.rows.map((r) => r.table_name));
    if (!present.has("session") || !present.has("organization") || !present.has("team")) {
      await client.query("ROLLBACK");
      return { provisioned: false, skipped: "table-missing" };
    }

    await client.query(SESSION_ACTIVATION_GUARD_FUNCTION_SQL);
    await client.query(SESSION_ACTIVATION_GUARD_TRIGGER_SQL);
    await client.query("COMMIT");
    return { provisioned: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `better-auth-migrate: provisioning public.session activation guard failed: ${
        err instanceof Error ? err.message : String(err)
      }. Fix the session/organization/team tables, then re-run \`pnpm auth:migrate\`.`,
      { cause: err },
    );
  } finally {
    client.release();
  }
}

/**
 * Canonical spellings of the expected CHECK expression. Postgres rewrites
 * `CHECK ("role" IN ('member', 'admin'))` into the `= ANY (ARRAY[...])` form
 * on modern servers; the raw IN-list spelling is kept as a defensive
 * equivalent. Compared whitespace-normalized.
 */
const EXPECTED_ROLE_CHECK_DEFS = new Set([
  `CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))`,
  `CHECK (("role" IN ('member', 'admin')))`,
  `CHECK ("role" IN ('member', 'admin'))`,
]);

/**
 * Ensure the role CHECK constraint exists WITH the expected definition —
 * `ADD CONSTRAINT` has no `IF NOT EXISTS`, and a name-only probe would accept
 * a same-named constraint with the WRONG definition (or a NOT VALID one).
 * Probe `pg_constraint` scoped to the table (`conrelid`) and validate
 * `contype` / `convalidated` / `pg_get_constraintdef()`; a mismatched
 * constraint is dropped and replaced (the re-add validates every row, so bad
 * data fails the migration loudly instead of leaking past the check).
 */
async function ensureRoleCheckConstraint(client: PoolClient) {
  const existing = await client.query<{
    contype: string;
    convalidated: boolean;
    def: string;
  }>(
    `SELECT contype, convalidated, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'teamMember_role_check'
        AND conrelid = 'public."teamMember"'::regclass`,
  );
  const row = existing.rows[0];
  if (row) {
    const normalizedDef = row.def.replace(/\s+/g, " ").trim();
    if (
      row.contype === "c" &&
      row.convalidated &&
      EXPECTED_ROLE_CHECK_DEFS.has(normalizedDef)
    ) {
      return;
    }
    await client.query(
      `ALTER TABLE public."teamMember" DROP CONSTRAINT "teamMember_role_check"`,
    );
  }
  await client.query(
    `ALTER TABLE public."teamMember"
       ADD CONSTRAINT "teamMember_role_check" CHECK ("role" IN ('member', 'admin'))`,
  );
}

/**
 * Provision the per-team-member role column: app-owned, guarded, idempotent.
 *
 * WHY HERE and not via Better Auth config or a core migration (cinatra#1566):
 *  - better-auth 1.6.19's organization plugin has NO per-team-member role, and
 *    its schema builder spreads `additionalFields` for every org sub-entity
 *    EXCEPT `teamMember` (still true at 1.6.23 and 1.7.0-rc.1) — a config-only
 *    attempt typechecks but provisions nothing. Maintainer guidance is to
 *    modify the DB schema yourself (better-auth discussion#2130); native
 *    `teamMember.additionalFields` is pending in the org-plugin rewrite
 *    (better-auth#7628 → #7886, unreleased). `getMigrations()` therefore
 *    never creates this column.
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
 * inserts the creator's membership first). ACCEPTED LIMITATION: on legacy or
 * imported data, or where the creator's membership row was since deleted, the
 * earliest SURVIVING member is promoted instead — the schema records no
 * creator provenance anywhere to prefer, and each team needs exactly one
 * deterministic admin for the role model to be administrable at all. A wrong
 * grant is visible and correctable in the members-card role UI.
 *
 * When the column PRE-exists (hand-provisioned or a re-run after a partial
 * failure), the backfill is skipped and a shape-repair pass runs instead:
 * NULL roles are coerced to 'member', then DEFAULT / NOT NULL / CHECK are
 * (re)applied. Any failure — provisioning OR repair — ABORTS the migration:
 * continuing would let the app's capability probe see a role column whose
 * shape cannot be trusted (nullable, wrong default, unvalidated CHECK) and
 * enable role semantics on top of it. Fix the column manually, then re-run
 * `pnpm auth:migrate`.
 *
 * Concurrency: the whole probe→branch→DDL unit runs inside ONE transaction
 * that FIRST takes a transaction-scoped advisory lock on a constant key —
 * two concurrent runners (e.g. parallel `setup` invocations) serialize, and
 * the loser re-probes AFTER the winner committed, sees the column, and takes
 * the repair path instead of re-running the one-shot backfill (which would
 * overwrite role changes made since the winner's run).
 */
export async function ensureTeamMemberRoleColumn(
  pool: Pool,
): Promise<TeamMemberRoleProvisionResult> {
  // One checked-out client for the whole unit — pool.query() may hop
  // connections between statements, which would break BEGIN/COMMIT and
  // detach the advisory lock from the transaction that needs it.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent runners BEFORE probing (see the docblock).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('cinatra-migrations'), hashtext('teamMember.role'))`,
    );

    const tableExists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'teamMember'
       ) AS "exists"`,
    );
    if (!tableExists.rows[0]?.exists) {
      await client.query("ROLLBACK");
      return { provisioned: false, backfilledAdmins: 0, skipped: "table-missing" };
    }

    const columnExists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'teamMember'
           AND column_name = 'role'
       ) AS "exists"`,
    );
    const preExisting = Boolean(columnExists.rows[0]?.exists);

    if (!preExisting) {
      // Fresh provisioning: column + CHECK + one-shot backfill, atomically.
      await client.query(
        `ALTER TABLE public."teamMember"
           ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'member'`,
      );
      await ensureRoleCheckConstraint(client);
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
    }

    // Column pre-exists: no backfill (it is one-shot by design), but make the
    // shape trustworthy — the app's roleless membership inserts rely on
    // DEFAULT 'member' + NOT NULL, and the CHECK definition is validated (a
    // same-named constraint with the wrong definition is replaced).
    await client.query(
      `UPDATE public."teamMember" SET "role" = 'member' WHERE "role" IS NULL`,
    );
    await client.query(
      `ALTER TABLE public."teamMember" ALTER COLUMN "role" SET DEFAULT 'member'`,
    );
    await client.query(
      `ALTER TABLE public."teamMember" ALTER COLUMN "role" SET NOT NULL`,
    );
    await ensureRoleCheckConstraint(client);
    await client.query("COMMIT");
    return { provisioned: false, backfilledAdmins: 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Fail LOUDLY (stop the deployment): a role column that cannot be
    // brought to the expected shape must never be silently enabled.
    throw new Error(
      `better-auth-migrate: provisioning/repairing public."teamMember"."role" failed: ${
        err instanceof Error ? err.message : String(err)
      }. Pre-existing malformed role columns are unsupported — fix the column ` +
        `manually, then re-run \`pnpm auth:migrate\`.`,
      { cause: err },
    );
  } finally {
    client.release();
  }
}

/**
 * Canonical spellings of the expected non-blank-name CHECK expression.
 * Postgres types the empty-string literal (`''::text`) and wraps the predicate
 * in an extra paren pair when it stores `CHECK (btrim(name) <> '')`; the raw
 * spellings are kept as defensive equivalents. Compared whitespace-normalized
 * (mirrors EXPECTED_ROLE_CHECK_DEFS / ensureRoleCheckConstraint).
 */
const EXPECTED_NAME_NOT_BLANK_CHECK_DEFS = new Set([
  `CHECK ((btrim(name) <> ''::text))`,
  `CHECK ((btrim(name) <> ''))`,
  `CHECK (btrim(name) <> '')`,
]);

/**
 * Ensure the organization non-blank-name CHECK exists WITH the expected
 * definition — same rationale as ensureRoleCheckConstraint: `ADD CONSTRAINT`
 * has no `IF NOT EXISTS`, and a name-only probe would accept a same-named
 * constraint with the WRONG definition (or a NOT VALID one). Probe
 * `pg_constraint` scoped to the table (`conrelid`) and validate
 * `contype` / `convalidated` / `pg_get_constraintdef()`; a mismatched
 * constraint is dropped and replaced (the re-add validates every row, so a
 * blank name that slipped in fails the migration loudly instead of leaking
 * past the check). Returns true when this run added or replaced it.
 */
async function ensureOrganizationNameCheckConstraint(
  client: PoolClient,
): Promise<boolean> {
  const existing = await client.query<{
    contype: string;
    convalidated: boolean;
    def: string;
  }>(
    `SELECT contype, convalidated, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conname = 'organization_name_not_blank'
        AND conrelid = 'public."organization"'::regclass`,
  );
  const row = existing.rows[0];
  if (row) {
    const normalizedDef = row.def.replace(/\s+/g, " ").trim();
    if (
      row.contype === "c" &&
      row.convalidated &&
      EXPECTED_NAME_NOT_BLANK_CHECK_DEFS.has(normalizedDef)
    ) {
      return false;
    }
    await client.query(
      `ALTER TABLE public."organization" DROP CONSTRAINT "organization_name_not_blank"`,
    );
  }
  await client.query(
    `ALTER TABLE public."organization"
       ADD CONSTRAINT "organization_name_not_blank" CHECK (btrim(name) <> '')`,
  );
  return true;
}

/**
 * Provision the organization non-blank-name guard: backfill legacy
 * blank/whitespace-only names, then arm a CHECK — app-owned, guarded,
 * idempotent (cinatra#1942, the empty-name rider).
 *
 * WHY HERE (not a `core__NNNN` migration or Better Auth config): `organization`
 * is a Better-Auth-managed table (`getMigrations()` owns its DDL), and this
 * runner already co-locates the other org-table guards (the teamMember role
 * column, the session activation trigger). Better Auth's `name.required`
 * rejects null/empty but NOT a whitespace-only string, and the third-party
 * create-organization dialog (@daveyplate/better-auth-ui) bypasses the
 * first-party trim in src/app/organizations/new/actions.ts — so legacy
 * whitespace-only names can exist and new ones could be planted. core__0053
 * converged NULL names to the ratified "Organization (…)" default but never
 * touched whitespace-only names; this rider is the blank-name analogue.
 *
 * ARMING GUARD (backfill-then-constrain, fail-loud): the whole
 * probe -> LOCK -> backfill -> ADD CONSTRAINT unit runs inside ONE transaction
 * that FIRST takes a constant-key advisory xact-lock (serializes concurrent
 * runners, like ensureTeamMemberRoleColumn) and THEN
 * `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE` (blocks app writers for the
 * backfill->arm window during a rolling deploy, like core__0053) so no
 * blank-name INSERT can race between the backfill and the constraint add and
 * abort the DDL. The backfill assigns a deterministic, id-derived placeholder
 * `Organization (<short-id>)` (the design's placeholder option, consistent
 * with core__0053's "Organization (…)" idiom) to every row whose name trims to
 * empty; the ADD CONSTRAINT then validates every row. Refuse to arm when the
 * organization table is absent (the ensureSessionActivationGuardTrigger
 * "table-missing" precedent), and ROLLBACK+rethrow on any failure (a table
 * whose blank-name guard cannot be armed must stop the deployment, never be
 * silently skipped — the same fail-loud contract as the sibling post-steps).
 *
 * Idempotent: once armed the CHECK prevents new blank names, so re-runs find
 * zero rows to backfill and the constraint probe confirms the expected
 * definition (no DROP/ADD). A same-named constraint with a wrong / NOT-VALID
 * definition is replaced so the re-add re-validates every row. NULL names (if
 * any) are neither matched by the backfill (`btrim(NULL)` is NULL, never `''`)
 * nor rejected by the CHECK (a CHECK passes on NULL) — core__0053 owns NULL.
 */
export async function ensureOrganizationNameNotBlank(
  pool: Pool,
): Promise<OrganizationNameNotBlankResult> {
  // One checked-out client for the whole unit — pool.query() may hop
  // connections between statements, which would detach the advisory lock and
  // the LOCK TABLE from the transaction that needs them.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent runners BEFORE probing (see ensureTeamMemberRoleColumn).
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('cinatra-migrations'), hashtext('organization.nameNotBlank'))`,
    );

    const tableExists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'organization'
       ) AS "exists"`,
    );
    if (!tableExists.rows[0]?.exists) {
      await client.query("ROLLBACK");
      return { provisioned: false, backfilledNames: 0, skipped: "table-missing" };
    }

    // Block concurrent app writers for the backfill->arm window (rolling-deploy
    // safety, mirrors core__0053) — AFTER the existence probe so we never LOCK
    // a table that isn't there.
    await client.query(
      `LOCK TABLE public."organization" IN SHARE ROW EXCLUSIVE MODE`,
    );

    // Backfill every blank name to a deterministic, id-derived placeholder
    // BEFORE arming the CHECK so the ADD CONSTRAINT validates cleanly.
    // `btrim(name) = ''` matches empty and space-padded names — btrim's
    // default trim charset is the SPACE character (the design-ratified
    // predicate; the CHECK below uses the SAME expression, so backfill and
    // constraint can never disagree — a name padded with exotic whitespace
    // (tab/newline) is neither backfilled nor rejected, by design). NULL is
    // excluded (btrim(NULL) is NULL) and owned by core__0053.
    const backfilled = await client.query(
      `UPDATE public."organization"
          SET name = 'Organization (' || left(id, 8) || ')'
        WHERE btrim(name) = ''`,
    );

    const provisioned = await ensureOrganizationNameCheckConstraint(client);
    await client.query("COMMIT");
    return { provisioned, backfilledNames: backfilled.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Fail LOUDLY (stop the deployment): an organization table whose blank-name
    // guard cannot be armed must never be silently enabled.
    throw new Error(
      `better-auth-migrate: provisioning the public."organization".name ` +
        `non-blank guard failed: ${
          err instanceof Error ? err.message : String(err)
        }. Fix the organization table, then re-run \`pnpm auth:migrate\`.`,
      { cause: err },
    );
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
  sessionActivationGuard: SessionActivationGuardResult;
  organizationNameNotBlank: OrganizationNameNotBlankResult;
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
    // cinatra#1937: the session activation guard is definition-repaired on
    // every invocation (single tx, OR-REPLACE) — fresh installs, upgrades,
    // and drifted definitions all converge on the canonical guard.
    const sessionActivationGuard = await ensureSessionActivationGuardTrigger(pool);
    // cinatra#1942 (empty-name rider): backfill legacy blank/whitespace-only
    // organization names, then arm the non-blank CHECK — runs AFTER
    // getMigrations() has had its chance to create the organization table on
    // fresh installs. Inert in production until it finds a blank name to fix.
    const organizationNameNotBlank = await ensureOrganizationNameNotBlank(pool);
    return {
      created: toBeCreated.map((entry) => entry.table),
      columnSetsAdded: toBeAdded.length,
      teamMemberRole,
      sessionActivationGuard,
      organizationNameNotBlank,
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
      : "present";
  const guardNote = result.sessionActivationGuard.skipped
    ? `skipped (${result.sessionActivationGuard.skipped})`
    : "provisioned";
  const nameNote = result.organizationNameNotBlank.skipped
    ? `skipped (${result.organizationNameNotBlank.skipped})`
    : result.organizationNameNotBlank.provisioned
      ? `armed (${result.organizationNameNotBlank.backfilledNames} blank name(s) backfilled)`
      : "present";
  console.log(
    `Better Auth migration: created [${
      result.created.join(", ") || "none"
    }], column-sets added ${result.columnSetsAdded}, teamMember.role ${roleNote}, session activation guard ${guardNote}, organization name guard ${nameNote}.`,
  );
}
