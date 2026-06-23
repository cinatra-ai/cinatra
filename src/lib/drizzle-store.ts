import { eq, notInArray } from "drizzle-orm";
// SQL-TEXT-ONLY driver (cinatra#104): the pg-proxy driver builds queries
// without importing `pg`. Turbopack externalizes `pg` via dynamic `import()`
// (esm_import), which would make this module — and every static importer up
// to database.ts — an ASYNC module, breaking the codebase's synchronous
// `require()` composition (see src/lib/postgres-config.ts). Code that needs
// a REAL pg connection lives in src/lib/extension-destinations-store.ts.
// Enforced by src/lib/__tests__/postgres-sync-leaf-imports.test.ts.
import { drizzle } from "drizzle-orm/pg-proxy";
import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import type { BindingScope, OwnerScope, SourceKind } from "@cinatra-ai/skills";

type QueryInput = {
  text: string;
  values?: unknown[];
};

type TableName =
  | "metadata"
  | "startups"
  | "startup_overrides"
  | "campaign_types"
  | "campaigns"
  | "drafts"
  | "agent_campaign_overrides"
  | "extension_lifecycle_audit"
  | "extension_destinations"
  | "skill_packages"
  | "skills"
  | "notifications"
  | "record_activities"
  | "chat_threads";

// Exported ONLY for src/lib/extension-destinations-store.ts (the table
// definitions are shared with the real-connection credential store). Treat
// as internal everywhere else — use the build*Query helpers below.
export function createStoreTables(schemaName: string) {
  const schema = pgSchema(schemaName);

  return {
    schemaName,
    metadata: schema.table("metadata", {
      key: text("key").primaryKey(),
      value: text("value").notNull(),
    }),
    startups: schema.table("startups", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    startup_overrides: schema.table("startup_overrides", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    campaign_types: schema.table("campaign_types", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    campaigns: schema.table("campaigns", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    drafts: schema.table("drafts", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    agent_campaign_overrides: schema.table("agent_campaign_overrides", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    // Destination credential store for private registry tokens.
    // AAD binding: "destination.<id>.publish-token" / "destination.<id>.read-token".
    extension_destinations: schema.table("extension_destinations", {
      id: text("id").primaryKey(),
      label: text("label").notNull(),
      registryUrl: text("registry_url").notNull(),
      tokenCiphertext: text("token_ciphertext").notNull(),
      tokenIv: text("token_iv").notNull(),
      tokenAlgo: text("token_algo").notNull().default("aes-256-gcm"),
      readTokenCiphertext: text("read_token_ciphertext"),
      readTokenIv: text("read_token_iv"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    }),
    // Extension lifecycle audit log for force-delete operations.
    extension_lifecycle_audit: schema.table("extension_lifecycle_audit", {
      id: text("id").primaryKey(),
      actorId: text("actor_id").notNull(),
      actorType: text("actor_type").notNull(),
      orgId: text("org_id"),
      operation: text("operation").notNull(),
      packageName: text("package_name").notNull(),
      packageVersion: text("package_version"),
      destroyedRowSnapshot: jsonb("destroyed_row_snapshot"),
      danglingReferences: jsonb("dangling_references"),
      reason: text("reason"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    }),
    skill_packages: schema.table("skill_packages", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    skills: schema.table("skills", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    notifications: schema.table("notifications", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    record_activities: schema.table("record_activities", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    chat_threads: schema.table("chat_threads", {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
    }),
    // Short-lived widget-stream tokens (cinatra#220). Hash-at-rest: token_hash
    // is SHA-256(rawToken); the raw token is NEVER persisted. Runtime
    // mint/consume go through src/lib/widget-token-broker.ts (raw SQL keyed by
    // token_hash); this declaration keeps the column-table in the createStoreTables
    // catalog so its shape is visible to the schema-drift guard.
    widget_stream_tokens: schema.table("widget_stream_tokens", {
      tokenHash: text("token_hash").primaryKey(),
      jti: text("jti").notNull(),
      agentSlug: text("agent_slug").notNull(),
      aud: text("aud").notNull(),
      iss: text("iss").notNull(),
      origin: text("origin").notNull(),
      scope: text("scope").notNull(),
      sub: text("sub"),
      tokenConfigKey: text("token_config_key").notNull(),
      tokenKeyFingerprint: text("token_key_fingerprint").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    }),
  };
}

type StoreTables = ReturnType<typeof createStoreTables>;

const storeCache = new Map<string, { db: ReturnType<typeof drizzle>; tables: StoreTables }>();

function getStore(schemaName: string) {
  const cached = storeCache.get(schemaName);
  if (cached) {
    return cached;
  }

  const tables = createStoreTables(schemaName);
  // pg-proxy remote callback. Queries built here are only ever `.toSQL()`'d
  // (see toQueryInput) and executed via runPostgresQueriesSync; nothing may
  // execute through the driver itself.
  const db = drizzle(async () => {
    throw new Error(
      "drizzle-store is a SQL-text builder; execute queries via runPostgresQueriesSync",
    );
  });
  const store = { db, tables };
  storeCache.set(schemaName, store);
  return store;
}

function toQueryInput(query: { toSQL: () => { sql: string; params: unknown[] } }): QueryInput {
  const { sql, params } = query.toSQL();
  return { text: sql, values: params };
}

function getPayloadTable(store: StoreTables, tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">) {
  return store[tableName];
}

// ---------------------------------------------------------------------------
// public."member" dedup ranking
// ---------------------------------------------------------------------------
// JS mirror of the window-CTE ORDER BY in buildCreateStoreSchemaQueries'
// member dedup block. Source of truth is the SQL; this mirror exists so the
// ranking strategy can be unit-tested on synthetic rows (the SQL byte-shape
// is independently guarded by member-dedup-migration-shape.test.ts). Keep
// the two in lockstep when either changes.

export type MemberDedupRow = {
  id: string;
  role: string | null;
  createdAt: Date | string | null;
};

// owner > admin > member > unknown/NULL, taken as the MAX across comma-split
// role tokens. Better Auth stores multi-role membership as comma-joined text
// ('owner,admin') and splits member.role on commas in its permission checks,
// so 'owner,admin' is owner-capable and must rank as owner (3) — never 0,
// which would let a plain 'member' row survive the dedup and the owner-capable
// row be deleted. Unknown/custom tokens contribute 0. Mirrors the SQL
// role_rank = MAX(CASE trim(tok) ...) over unnest(string_to_array(role, ',')).
export function memberDedupRoleRank(role: string | null | undefined): number {
  if (!role) return 0;
  return role.split(",").reduce((max, raw) => {
    const tok = raw.trim();
    const rank = tok === "owner" ? 3 : tok === "admin" ? 2 : tok === "member" ? 1 : 0;
    return rank > max ? rank : max;
  }, 0);
}

// Mirrors `"createdAt" ASC NULLS LAST`: NULL/invalid createdAt sorts last.
function memberDedupCreatedAtKey(createdAt: Date | string | null): number {
  if (createdAt == null) return Number.POSITIVE_INFINITY;
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// Negative => a survives over b. Order: role rank DESC, createdAt ASC (NULLS
// LAST), id ASC — identical to the SQL window ORDER BY.
export function compareMemberDedup(a: MemberDedupRow, b: MemberDedupRow): number {
  const rankDelta = memberDedupRoleRank(b.role) - memberDedupRoleRank(a.role);
  if (rankDelta !== 0) return rankDelta;
  // Compare keys directly (not by subtraction) so two NULLS-LAST rows
  // (both Infinity) fall through to the id tie-break instead of producing
  // NaN from Infinity - Infinity.
  const ka = memberDedupCreatedAtKey(a.createdAt);
  const kb = memberDedupCreatedAtKey(b.createdAt);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Returns the row that survives dedup for a single (organizationId, userId)
// partition — i.e. the SQL window's rn = 1 row.
export function pickSurvivingMemberRow<T extends MemberDedupRow>(rows: T[]): T {
  if (rows.length === 0) {
    throw new Error("pickSurvivingMemberRow: empty partition");
  }
  return [...rows].sort(compareMemberDedup)[0];
}

export function buildCreateStoreSchemaQueries(schemaName: string): QueryInput[] {
  const queries: QueryInput[] = [
    { text: `CREATE SCHEMA IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."metadata" (key text PRIMARY KEY, value text NOT NULL)` },
    // Pre-structured-column schema detection and cleanup.
    // Worktree schemas created before the payload→structured-column migration have
    // agent_templates(id, payload) instead of the full typed schema. If detected, all
    // structured tables are dropped so the CREATE TABLE IF NOT EXISTS statements below
    // recreate them with the correct schema. Idempotent — no-op on current schemas.
    // The subsequent setup-branch seeding step repopulates data from the source schema.
    { text: `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'agent_templates' AND column_name = 'payload'
  ) THEN
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_templates" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_runs" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_messages" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_template_versions" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_forks" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_registry_entries" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_versions" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."agent_share_bindings" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."legacy_costs" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."objects" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."planned_actions" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."review_tasks" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."traces" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."audit_events" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."usage_events" CASCADE;
    DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."model_pricing" CASCADE;
  END IF;
END $$` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."startups" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."startup_overrides" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."campaign_types" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."campaigns" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."drafts" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_campaign_overrides" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_packages" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skills" (id text PRIMARY KEY, payload text NOT NULL)` },
    // skill_package_co_owners: per-skill-package sharing join
    // table. Mirrors run_co_owners exactly: composite PK on (package_id,
    // user_id), granted_by + granted_at for audit, FKs to skill_packages.id
    // and Better Auth public.user (CASCADE on user delete). Generic
    // PermissionsForm reads/writes through this table the same way it
    // reads/writes run_co_owners for agent runs.

    // package_id FK uses ON DELETE RESTRICT. The
    // earlier CASCADE was unsafe because `replaceSkillCatalogInDatabase()`
    // implements catalog edits as DELETE+INSERT on `skill_packages`, which
    // would cascade-wipe co-owners on every routine edit (including
    // `writeSkillPackageAccessPolicy()` itself). RESTRICT forces the DB to
    // reject a delete that would orphan co-owner rows. `uninstallSkillPackage()`
    // explicitly removes co-owner rows before the package row.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners" (
      package_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."skill_packages"(id) ON DELETE RESTRICT,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (package_id, user_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_package_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners" (user_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
        -- Replace CASCADE with RESTRICT on the
        -- package_id FK if a pre-existing schema was bootstrapped while the
        -- CASCADE was still in CREATE TABLE. Idempotent: only fires when the
        -- current constraint delete_rule is still CASCADE.
        IF EXISTS (
          SELECT 1 FROM information_schema.referential_constraints rc
          WHERE rc.constraint_schema = '${schemaName.replaceAll("'", "''")}'
            AND rc.constraint_name = 'skill_package_co_owners_package_id_fkey'
            AND rc.delete_rule = 'CASCADE'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            DROP CONSTRAINT skill_package_co_owners_package_id_fkey;
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_package_id_fkey
            FOREIGN KEY (package_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skill_packages"(id) ON DELETE RESTRICT;
        END IF;
        -- Heal a schema where the package_id FK is
        -- missing entirely after table
        -- creation, or any state where the constraint got dropped manually).
        -- CREATE TABLE IF NOT EXISTS won't re-add the FK, so we add it here.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_package_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_package_id_fkey
            FOREIGN KEY (package_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skill_packages"(id) ON DELETE RESTRICT;
        END IF;
      END $$;` },
    // skill_co_owners: per-skill (not per-package)
    // sharing join. Lets operators override the parent package's access
    // policy on individual skills. Mirrors skill_package_co_owners
    // (composite PK on (skill_id, user_id), granted_by + granted_at audit,
    // cross-schema FK to public.user).

    // skill_id FK uses ON DELETE RESTRICT against
    // cinatra.skills(id). Earlier design left it as a soft reference
    // ("application layer guarantees referential integrity by writing a
    // co-owner row only after the skill exists"), but skill rows DO get
    // deleted on package uninstall — without an FK those deletes would
    // leave orphan grants that could re-apply when a future install reuses
    // the same skill id. RESTRICT forces explicit cleanup before the
    // parent skill row goes away (`removeAllSkillCoOwnersForPackage`
    // does this in `uninstallSkillPackage`).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_co_owners" (
      skill_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."skills"(id) ON DELETE RESTRICT,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (skill_id, user_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."skill_co_owners" (user_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
        -- Heal a schema where skill_id FK was
        -- never added (table was originally created without it).
        --
        -- review follow-up: BEFORE adding the FK, clean up any orphan
        -- skill_co_owners rows whose skill_id no longer points at a real
        -- skill row. The legacy no-FK design allowed package-uninstall
        -- paths to drop skill rows while leaving co-owner grants in place;
        -- those orphans would block ALTER TABLE ADD CONSTRAINT now.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_skill_id_fkey'
        ) THEN
          DELETE FROM "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
          WHERE skill_id NOT IN (
            SELECT id FROM "${schemaName.replaceAll('"', '""')}"."skills"
          );
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_skill_id_fkey
            FOREIGN KEY (skill_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skills"(id) ON DELETE RESTRICT;
        END IF;
      END $$;` },

    // -----------------------------------------------------------------------
    // Generic extension permissions consolidation.

    // Replaces the parallel tables (run_co_owners,
    // skill_package_co_owners, skill_co_owners) and the four scattered
    // policy storage locations with two polymorphic tables keyed on
    // (resource_kind, resource_id). Any future extension kind (connector,
    // mcp_server, …) lands as a CHECK enum value plus a kind-hook entry —
    // no new tables / actions / loaders / client wrappers required.

    // resource_kind values intentionally enumerated as TEXT + CHECK (not
    // Postgres `CREATE TYPE … AS ENUM`) so adding a kind doesn't require
    // an ALTER TYPE migration. The check clause is rebuilt idempotently
    // via the DO block below.

    // The DO block ADDs the constraint
    // only when missing; it does NOT auto-rebuild the IN-list when the
    // allowed set changes. To add a new kind on an already-migrated DB,
    // bump the constraint NAME (e.g. `extension_co_owners_kind_check_v2`)
    // and drop the old one in a follow-up migration step. Renaming
    // forces the DO block to fall through and ADD the v2 constraint.

    // No FK on resource_id — it's polymorphic, so app-layer + per-kind
    // DELETE hooks clean up. Orphan reads return empty co-owner sets
    // (auth gate fails closed for the now-deleted resource).
    // -----------------------------------------------------------------------
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_co_owners" (
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (resource_kind, resource_id, user_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."extension_co_owners" (user_id)` },
    { text: `CREATE INDEX IF NOT EXISTS extension_co_owners_resource_idx ON "${schemaName.replaceAll('"', '""')}"."extension_co_owners" (resource_kind, resource_id)` },
    { text: `DO $$
      BEGIN
        -- Broaden resource_kind to cover connector/artifact/workflow.
        -- The DO block does NOT auto-rebuild an existing IN-list, so the
        -- constraint NAME is bumped to _v2 and the old check is dropped. Both
        -- statements are idempotent: DROP IF EXISTS is a no-op once gone, and
        -- the v2 ADD is gated on its own absence.
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
          DROP CONSTRAINT IF EXISTS extension_co_owners_kind_check;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_co_owners'
            AND constraint_name = 'extension_co_owners_kind_check_v2'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
            ADD CONSTRAINT extension_co_owners_kind_check_v2
            CHECK (resource_kind IN ('agent_run', 'agent_template', 'skill_package', 'skill', 'connector', 'artifact', 'workflow'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_co_owners'
            AND constraint_name = 'extension_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
            ADD CONSTRAINT extension_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_co_owners'
            AND constraint_name = 'extension_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
            ADD CONSTRAINT extension_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
      END $$;` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_access_policy" (
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      policy jsonb NOT NULL,
      installed_by_user_id text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (resource_kind, resource_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_access_policy_installed_by_idx ON "${schemaName.replaceAll('"', '""')}"."extension_access_policy" (installed_by_user_id)` },
    { text: `DO $$
      BEGIN
        -- Broaden resource_kind to cover connector/artifact/workflow.
        -- Constraint NAME bumped to _v2 + old check dropped (the DO block does
        -- not rebuild an existing IN-list). Both statements idempotent.
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
          DROP CONSTRAINT IF EXISTS extension_access_policy_kind_check;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_access_policy'
            AND constraint_name = 'extension_access_policy_kind_check_v2'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
            ADD CONSTRAINT extension_access_policy_kind_check_v2
            CHECK (resource_kind IN ('agent_run', 'agent_template', 'skill_package', 'skill', 'connector', 'artifact', 'workflow'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_access_policy'
            AND constraint_name = 'extension_access_policy_installed_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
            ADD CONSTRAINT extension_access_policy_installed_by_fkey
            FOREIGN KEY (installed_by_user_id) REFERENCES public."user"(id) ON DELETE SET NULL;
        END IF;
      END $$;` },

    // -----------------------------------------------------------------------
    // Per-connector access policy.

    // One row per (organization, connector package) tuple. `visibility="admin"`
    // means only org_admin/org_owner actors can read/use the connector;
    // `visibility="workspace"` opens it to every workspace member. Manage
    // (configure/save) ALWAYS requires admin regardless of the visibility
    // setting — enforced in `enforceConnectorPolicy(..., "manage")`.

    // Distinct from the existing `external_mcp_servers` ACL (which is keyed
    // by per-server row id); this table keys on `package_id` so it covers
    // host-managed `connector_config` connectors (OpenAI, Anthropic, etc.)
    // that don't have per-row ACL targets.

    // `source_tag` distinguishes manual edits from the dev fixture seed
    // Only rows tagged `dev-fixture-v1` are touched by the
    // idempotent re-seed; manual edits are preserved.
    // -----------------------------------------------------------------------
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."connector_access_policy" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      org_id text NOT NULL,
      package_id text NOT NULL,
      owner_user_id text NOT NULL,
      visibility text NOT NULL,
      source_tag text NOT NULL DEFAULT 'manual',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (org_id, package_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS connector_access_policy_org_idx ON "${schemaName.replaceAll('"', '""')}"."connector_access_policy" (org_id)` },
    { text: `CREATE INDEX IF NOT EXISTS connector_access_policy_package_idx ON "${schemaName.replaceAll('"', '""')}"."connector_access_policy" (package_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'connector_access_policy'
            AND constraint_name = 'connector_access_policy_visibility_check'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."connector_access_policy"
            ADD CONSTRAINT connector_access_policy_visibility_check
            CHECK (visibility IN ('admin', 'workspace'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'connector_access_policy'
            AND constraint_name = 'connector_access_policy_org_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."connector_access_policy"
            ADD CONSTRAINT connector_access_policy_org_fkey
            FOREIGN KEY (org_id) REFERENCES public."organization"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'connector_access_policy'
            AND constraint_name = 'connector_access_policy_owner_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."connector_access_policy"
            ADD CONSTRAINT connector_access_policy_owner_fkey
            FOREIGN KEY (owner_user_id) REFERENCES public."user"(id);
        END IF;
      END $$;` },

    // Runtime installer — admin-approved host-port grants. The runtime
    // loader/host-context consumes the APPROVED port set from here (NOT the raw
    // manifest's requestedHostPorts). requested_ports_hash detects a manifest
    // change on update (which must re-trigger approval); status gates activation.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_host_port_grant" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_name text NOT NULL,
      org_id text,
      approved_ports jsonb NOT NULL DEFAULT '[]'::jsonb,
      requested_ports_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      approved_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (package_name, org_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_host_port_grant_pkg_idx ON "${schemaName.replaceAll('"', '""')}"."extension_host_port_grant" (package_name)` },
    // The table UNIQUE(package_name, org_id) does NOT dedupe GLOBAL grants
    // (Postgres treats NULLs as distinct), so a concurrent insert could create
    // two (package, NULL) rows. A partial unique index enforces one global grant
    // per package.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_host_port_grant_pkg_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_host_port_grant" (package_name) WHERE org_id IS NULL` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_host_port_grant'
            AND constraint_name = 'extension_host_port_grant_status_check'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_host_port_grant"
            ADD CONSTRAINT extension_host_port_grant_status_check
            CHECK (status IN ('pending', 'approved', 'revoked'));
        END IF;
      END $$;` },

    // Runtime installer — snapshot leases. An in-flight run that imports
    // a digest-pinned package dir holds a lease so the GC reaper never deletes
    // the <digest> dir out from under it. A lease past expires_at no longer
    // protects the dir (a crashed holder cannot strand a dir forever).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_snapshot_lease" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_name text NOT NULL,
      digest text NOT NULL,
      lease_holder text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_snapshot_lease_pkg_digest_idx ON "${schemaName.replaceAll('"', '""')}"."extension_snapshot_lease" (package_name, digest)` },

    // Runtime installer — install-op JOURNAL. One row per in-flight (or
    // completed) install drives the saga (idempotent finalize + inverse-order
    // compensating rollback + boot-orphan cleanup) AND is the PRIMARY trust gate
    // in resolveInstallAnchor: a row only resolves to a trusted anchor once its
    // phase is 'finalized'. A crash mid-install leaves a non-finalized row, so a
    // half-install never resolves as trusted.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_install_ops" (
      install_op_id text PRIMARY KEY,
      package_name text NOT NULL,
      org_id text,
      phase text NOT NULL,
      digest text,
      started_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_install_ops_pkg_idx ON "${schemaName.replaceAll('"', '""')}"."extension_install_ops" (package_name)` },
    // cinatra#158 — APPEND-ONLY journal: one row per ATTEMPT (PK install_op_id),
    // not one row per (package, org). The OLD full unique indexes
    // (..._pkg_org_uniq / ..._pkg_global_uniq) enforced single-row-per-(pkg,org)
    // and MUST go — append-only legitimately keeps many rows per scope. Drop them
    // idempotently here too (not only via migration 0005) so an upgraded DB whose
    // schema-init ensure pass runs converges. (See migrations/core/core__0005.)
    { text: `DROP INDEX IF EXISTS "${schemaName.replaceAll('"', '""')}".extension_install_ops_pkg_org_uniq` },
    { text: `DROP INDEX IF EXISTS "${schemaName.replaceAll('"', '""')}".extension_install_ops_pkg_global_uniq` },
    // The TRUST INVARIANT moves to the DB: AT MOST ONE `finalized` op per
    // (package, org) — that single finalized op IS the install anchor. The
    // partial unique index makes it provable + serializes concurrent finalizes
    // (finalizeInstallOp's supersession demotes the prior finalized op first). A
    // GLOBAL (org_id IS NULL) twin is needed because Postgres treats NULLs as
    // distinct under a plain unique.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized ON "${schemaName.replaceAll('"', '""')}"."extension_install_ops" (package_name, org_id) WHERE phase = 'finalized'` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_ops_one_finalized_global ON "${schemaName.replaceAll('"', '""')}"."extension_install_ops" (package_name) WHERE phase = 'finalized' AND org_id IS NULL` },
    // Anchor / non-finalized-window / sweeper reads scan by (package, org, phase).
    { text: `CREATE INDEX IF NOT EXISTS extension_install_ops_scope_phase_idx ON "${schemaName.replaceAll('"', '""')}"."extension_install_ops" (package_name, org_id, phase)` },
    { text: `DO $$
      DECLARE def text;
      BEGIN
        SELECT pg_get_constraintdef(c.oid) INTO def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${schemaName.replaceAll("'", "''")}'
          AND t.relname = 'extension_install_ops'
          AND c.conname = 'extension_install_ops_phase_check';
        -- One-shot migration: a schema created before a newer phase keeps the OLD
        -- CHECK, which would reject the new phase. Drop it so the new set is
        -- (re)added below. cinatra#158 adds 'superseded' (a demoted prior anchor);
        -- it follows the same widen-the-CHECK pattern that added 'writing'.
        IF def IS NOT NULL AND def NOT LIKE '%superseded%' THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_install_ops"
            DROP CONSTRAINT extension_install_ops_phase_check;
          def := NULL;
        END IF;
        IF def IS NULL THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_install_ops"
            ADD CONSTRAINT extension_install_ops_phase_check
            CHECK (phase IN ('materialized', 'granted', 'preflighted', 'writing', 'finalized', 'failed', 'rolled_back', 'superseded'));
        END IF;
      END $$;` },

    // Runtime installer — install-BATCH ledger (#180). One row per dependency-
    // batch install: the root + the ordered exact-pinned member set, per-member
    // status + PRE-STATE (present-before-batch vs installed-by-this-batch).
    // Wraps the per-member install-op journal rows; the boot batch-sweeper
    // compensates stale active batches from THIS ledger (finalized members of
    // an incomplete batch are invisible to the per-op orphan cleanup, which
    // skips batch-owned ops). Active-batch uniqueness per (root, org) via the
    // partial unique indexes below; member-overlap refusal is the saga's
    // pre-begin guard under the global lifecycle lock.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_install_batches" (
      batch_id text PRIMARY KEY,
      root_package text NOT NULL,
      org_id text,
      phase text NOT NULL,
      members jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_install_batches'
            AND constraint_name = 'extension_install_batches_phase_check'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_install_batches"
            ADD CONSTRAINT extension_install_batches_phase_check
            CHECK (phase IN ('planning', 'installing', 'finalized', 'failed', 'compensated'));
        END IF;
      END $$;` },
    { text: `CREATE INDEX IF NOT EXISTS extension_install_batches_phase_idx ON "${schemaName.replaceAll('"', '""')}"."extension_install_batches" (phase)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_batches_active_root_org_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_install_batches" (root_package, org_id) WHERE phase IN ('planning', 'installing')` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_install_batches_active_root_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_install_batches" (root_package) WHERE phase IN ('planning', 'installing') AND org_id IS NULL` },

    // One-shot backfill from legacy tables + JSON payloads.
    // Idempotent via ON CONFLICT DO NOTHING. Re-runs are no-ops on already-
    // migrated deployments. The legacy tables are NOT dropped here — Wave F
    // does that after the generic API has switched all readers.
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
               (resource_kind, resource_id, user_id, granted_by, granted_at)
             SELECT 'agent_run', run_id, user_id, granted_by, granted_at
             FROM "${schemaName.replaceAll('"', '""')}"."run_co_owners"
             ON CONFLICT DO NOTHING` },
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
               (resource_kind, resource_id, user_id, granted_by, granted_at)
             SELECT 'skill_package', package_id, user_id, granted_by, granted_at
             FROM "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
             ON CONFLICT DO NOTHING` },
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_co_owners"
               (resource_kind, resource_id, user_id, granted_by, granted_at)
             SELECT 'skill', skill_id, user_id, granted_by, granted_at
             FROM "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
             ON CONFLICT DO NOTHING` },
    // Agent-run policies live in the columnar agent_runs.auth_policy (text
    // JSON). Backfill into the polymorphic table; the column stays for
    // back-compat readers until Wave F.
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
               (resource_kind, resource_id, policy)
             SELECT 'agent_run', id, auth_policy::jsonb
             FROM "${schemaName.replaceAll('"', '""')}"."agent_runs"
             WHERE auth_policy IS NOT NULL AND auth_policy <> ''
             ON CONFLICT DO NOTHING` },
    // Skill-package + skill policies live inside their respective payload
    // JSON blobs. Extract accessPolicy + installedByUserId (skill_packages
    // only) when present.
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
               (resource_kind, resource_id, policy, installed_by_user_id)
             SELECT
               'skill_package',
               id,
               payload::jsonb->'accessPolicy',
               payload::jsonb->>'installedByUserId'
             FROM "${schemaName.replaceAll('"', '""')}"."skill_packages"
             WHERE payload::jsonb ? 'accessPolicy'
               AND (payload::jsonb->'accessPolicy') IS NOT NULL
               AND (payload::jsonb->'accessPolicy') <> 'null'::jsonb
             ON CONFLICT DO NOTHING` },
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."extension_access_policy"
               (resource_kind, resource_id, policy)
             SELECT
               'skill',
               id,
               payload::jsonb->'accessPolicy'
             FROM "${schemaName.replaceAll('"', '""')}"."skills"
             WHERE payload::jsonb ? 'accessPolicy'
               AND (payload::jsonb->'accessPolicy') IS NOT NULL
               AND (payload::jsonb->'accessPolicy') <> 'null'::jsonb
             ON CONFLICT DO NOTHING` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."notifications" (id text PRIMARY KEY, payload text NOT NULL)` },
    // Typed columns for the Postgres-backed notifications layer.

    // user_id INTENTIONALLY NULLABLE on the table itself:
    //   - The intended schema called for NOT NULL, but the existing
    //     `notifications` table predates it as a generic
    //     (id, payload) JSON-row store. Pre-existing rows have no user_id
    //     and a destructive backfill is out of scope here.
    //   - The notifications service (packages/notifications/src/service.ts)
    //     *always* writes a non-null user_id; the partial indexes below
    //     (notifications_user_unread_idx, notifications_dedupe_job_kind_idx,
    //     notifications_dedupe_key_idx)
    //     scope to WHERE user_id IS NOT NULL so reads never return legacy
    //     orphan rows, and dedupe never collides across orphans.
    //   - A future migration may DROP COLUMN payload + SET NOT NULL on
    //     user_id once the in-memory shim's residual rows are aged out.

    // All columns added with ADD COLUMN IF NOT EXISTS so the migration is
    // idempotent across cold starts and dev hot-reloads.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ALTER COLUMN payload DROP NOT NULL` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS user_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS recipient_kind text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS recipient_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS topic text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS kind text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS title text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS body text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS href text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS metadata jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS source_job_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS source_job_name text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS dedupe_key text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS read_at timestamptz` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."notifications" ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()` },
    { text: `CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON "${schemaName.replaceAll('"', '""')}"."notifications" (user_id, read_at, created_at DESC) WHERE user_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS notifications_topic_created_idx ON "${schemaName.replaceAll('"', '""')}"."notifications" (topic, created_at DESC) WHERE topic IS NOT NULL` },
    // Prevent BullMQ retries from creating duplicate
    // notifications for the same (user, source job, kind) tuple. Partial
    // unique index so rows without a source_job_id remain unconstrained.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_job_kind_idx ON "${schemaName.replaceAll('"', '""')}"."notifications" (user_id, source_job_id, kind) WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL` },
    // General per-user dedupe key (issue #50): writers that emit the same
    // LOGICAL notification more than once (double-emitting milestone
    // writers, recipient fanouts that overlap on one user) pass a stable
    // `dedupeKey`; the INSERT in packages/notifications/src/service.ts then
    // arbitrates ON CONFLICT (user_id, dedupe_key) DO NOTHING. Partial
    // unique index so rows without a dedupe_key remain unconstrained.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx ON "${schemaName.replaceAll('"', '""')}"."notifications" (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND user_id IS NOT NULL` },
    // ------------------------------------------------------------------
    // LISTEN/NOTIFY for real-time inbox flyout updates.

    // ONE channel `cinatra_notifications` (not per-user), payload
    //   { "userId": "...", "id": "..." }
    // sidesteps the 63-byte/identifier-quoting concerns of per-user channels.
    // A single process-level pg.Client subscribes once and fans out by
    // userId in-process to per-tab SSE handlers — see packages/notifications/src/realtime.ts.

    // The function is `CREATE OR REPLACE FUNCTION` (idempotent) and the
    // trigger uses `DROP TRIGGER IF EXISTS ... CASCADE` then `CREATE TRIGGER`
    // because `CREATE TRIGGER` is NOT idempotent on its own — repeated
    // ensurePostgresSchema() invocations would error on the second boot.

    // Only fire when user_id IS NOT NULL: legacy in-memory-shim rows from
    // legacy shim rows carry NULL user_id and have nothing meaningful to route.
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_notify_notification_insert"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.user_id IS NOT NULL THEN
          PERFORM pg_notify(
            'cinatra_notifications',
            json_build_object('userId', NEW.user_id, 'id', NEW.id)::text
          );
        END IF;
        RETURN NEW;
      END;
      $body$` },
    { text: `DROP TRIGGER IF EXISTS trg_notifications_after_insert ON "${schemaName.replaceAll('"', '""')}"."notifications"` },
    { text: `CREATE TRIGGER trg_notifications_after_insert
       AFTER INSERT ON "${schemaName.replaceAll('"', '""')}"."notifications"
       FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_notify_notification_insert"()` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."record_activities" (id text PRIMARY KEY, payload text NOT NULL)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."chat_threads" (id text PRIMARY KEY, payload text NOT NULL)` },
    // chat_threads typed scope +
    // ordering columns. chat_threads was payload-only; sealed-room project
    // listing needs an indexable project_id + a real
    // creation-order column (`id` is not creation-order; chat list paths
    // sort by payload createdAt). Payload-to-column lockstep writes keep
    // the columns current. DEFAULT now() backfills legacy rows to a stable (not
    // historically exact) timestamp — acceptable for a PoC repo.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."chat_threads" ADD COLUMN IF NOT EXISTS project_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."chat_threads" ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."chat_threads" ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()` },
    { text: `CREATE INDEX IF NOT EXISTS chat_threads_project_created_idx ON "${schemaName.replaceAll('"', '""')}"."chat_threads" (project_id, created_at DESC, id) WHERE project_id IS NOT NULL` },
    // usage_events table for @cinatra-ai/metric-cost-api
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."usage_events" (
      id text PRIMARY KEY,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      source text NOT NULL,
      provider text NOT NULL,
      model text,
      operation text,
      agent_label text,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cached_input_tokens integer NOT NULL DEFAULT 0,
      reasoning_output_tokens integer NOT NULL DEFAULT 0,
      credits_consumed integer NOT NULL DEFAULT 0,
      cost_usd numeric(12,8),
      idempotency_key text NOT NULL
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_key_idx ON "${schemaName.replaceAll('"', '""')}"."usage_events" (idempotency_key)` },
    // Migrate pre-metrics-cost schemas that have usage_events(id, payload[, idempotency_key])
    // instead of the full typed schema. CREATE TABLE IF NOT EXISTS above is a no-op when the
    // table already exists, so old worktree schemas never get the new columns — and the
    // CREATE INDEX statements below then crash with "column does not exist". This DO block
    // is idempotent: it only runs when occurred_at is absent and adds all missing columns
    // plus drops the legacy payload column.
    { text: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'usage_events' AND column_name = 'occurred_at'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."usage_events"
      ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS model text,
      ADD COLUMN IF NOT EXISTS operation text,
      ADD COLUMN IF NOT EXISTS agent_label text,
      ADD COLUMN IF NOT EXISTS input_tokens integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS reasoning_output_tokens integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS credits_consumed integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cost_usd numeric(12,8);
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'usage_events' AND column_name = 'payload'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."usage_events" DROP COLUMN payload;
    END IF;
  END IF;
END $$` },
    { text: `CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx ON "${schemaName.replaceAll('"', '""')}"."usage_events" (occurred_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS usage_events_provider_occurred_at_idx ON "${schemaName.replaceAll('"', '""')}"."usage_events" (provider, occurred_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS usage_events_agent_label_occurred_at_idx ON "${schemaName.replaceAll('"', '""')}"."usage_events" (agent_label, occurred_at DESC)` },
    // model_pricing table for @cinatra-ai/metric-cost-api
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."model_pricing" (
      id text PRIMARY KEY,
      provider text NOT NULL,
      model_name text NOT NULL,
      input_cost_per_million numeric(12,8) NOT NULL,
      output_cost_per_million numeric(12,8) NOT NULL,
      cache_read_per_million numeric(12,8),
      source text NOT NULL DEFAULT 'litellm',
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    // Migrate pre-metrics-cost model_pricing schemas that only have (id, payload, …).
    // Idempotent: only runs when provider column is absent.
    { text: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'provider'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing"
      ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS model_name text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS input_cost_per_million numeric(20,8) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS output_cost_per_million numeric(20,8) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cache_read_per_million numeric(20,8);
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'payload'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN payload;
    END IF;
  END IF;
END $$` },
    { text: `DO $$ BEGIN
  -- Rename model → model_name, then drop old column
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'model') THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS model_name text;
    UPDATE "${schemaName.replaceAll('"', '""')}"."model_pricing" SET model_name = model WHERE model_name IS NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ALTER COLUMN model_name SET NOT NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN model;
  END IF;
  -- Rename input_cost_per_million_tokens → input_cost_per_million, then drop old column
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'input_cost_per_million_tokens') THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS input_cost_per_million numeric(12,8);
    UPDATE "${schemaName.replaceAll('"', '""')}"."model_pricing" SET input_cost_per_million = input_cost_per_million_tokens WHERE input_cost_per_million IS NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ALTER COLUMN input_cost_per_million SET NOT NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN input_cost_per_million_tokens;
  END IF;
  -- Rename output_cost_per_million_tokens → output_cost_per_million, then drop old column
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'output_cost_per_million_tokens') THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS output_cost_per_million numeric(12,8);
    UPDATE "${schemaName.replaceAll('"', '""')}"."model_pricing" SET output_cost_per_million = output_cost_per_million_tokens WHERE output_cost_per_million IS NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ALTER COLUMN output_cost_per_million SET NOT NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN output_cost_per_million_tokens;
  END IF;
  -- Rename cache_read_cost_per_million_tokens → cache_read_per_million, then drop old column
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'cache_read_cost_per_million_tokens') THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS cache_read_per_million numeric(12,8);
    UPDATE "${schemaName.replaceAll('"', '""')}"."model_pricing" SET cache_read_per_million = cache_read_cost_per_million_tokens WHERE cache_read_per_million IS NULL;
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN cache_read_cost_per_million_tokens;
  END IF;
  -- Drop other legacy columns if present
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN IF EXISTS cache_write_cost_per_million_tokens;
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN IF EXISTS credits_cost;
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN IF EXISTS effective_from;
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" DROP COLUMN IF EXISTS effective_until;
  -- Add source and updated_at if not present
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'litellm';
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing" ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  -- Drop old unique index that used (provider, model, effective_from) if still present
  DROP INDEX IF EXISTS "${schemaName.replaceAll('"', '""')}"."model_pricing_provider_model_effective_idx";
END $$` },
    // Widen pricing columns from numeric(12,8) to numeric(20,8) to handle high-priced models
    { text: `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'model_pricing' AND column_name = 'input_cost_per_million' AND numeric_precision = 12) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."model_pricing"
      ALTER COLUMN input_cost_per_million  TYPE numeric(20,8),
      ALTER COLUMN output_cost_per_million TYPE numeric(20,8),
      ALTER COLUMN cache_read_per_million  TYPE numeric(20,8);
  END IF;
END $$` },
    // Index must come after the migration block so model_name exists on old-schema tables
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS model_pricing_provider_model_idx ON "${schemaName.replaceAll('"', '""')}"."model_pricing" (provider, model_name)` },
    // Seed model_pricing with initial values (idempotent — ON CONFLICT DO NOTHING)
    // TODO: ALL pricing values are LOW confidence — verify against current provider pricing pages
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."model_pricing" (id, provider, model_name, input_cost_per_million, output_cost_per_million, cache_read_per_million, source, updated_at)
    VALUES
      ('seed-openai-gpt5', 'openai', 'gpt-5', 2.50000000, 10.00000000, 1.25000000, 'litellm', now()),
      ('seed-openai-gpt4o', 'openai', 'gpt-4o', 2.50000000, 10.00000000, 1.25000000, 'litellm', now()),
      ('seed-openai-gpt4o-mini', 'openai', 'gpt-4o-mini', 0.15000000, 0.60000000, 0.07500000, 'litellm', now()),
      ('seed-anthropic-sonnet', 'anthropic', 'claude-sonnet-4-5-20250929', 3.00000000, 15.00000000, 0.30000000, 'litellm', now()),
      ('seed-anthropic-opus', 'anthropic', 'claude-opus-4', 15.00000000, 75.00000000, 1.50000000, 'litellm', now()),
      ('seed-gemini-flash', 'gemini', 'gemini-2.5-flash', 0.07500000, 0.30000000, NULL, 'litellm', now()),
      ('seed-gemini-pro', 'gemini', 'gemini-2.5-pro', 1.25000000, 10.00000000, NULL, 'litellm', now())
    ON CONFLICT DO NOTHING` },
    // legacy_costs table for @cinatra-ai/metric-cost-api
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."legacy_costs" (
      id text PRIMARY KEY,
      provider text NOT NULL,
      description text NOT NULL,
      cost_usd numeric(12,8) NOT NULL,
      start_date date,
      end_date date,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS legacy_costs_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."legacy_costs" (created_at DESC)` },
    // Add frequency column to legacy_costs with backward-compatible default 'once'.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."legacy_costs" ADD COLUMN IF NOT EXISTS frequency text NOT NULL DEFAULT 'once'` },
    // Add cost_type column to legacy_costs with 'legacy' default for backward compatibility.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."legacy_costs" ADD COLUMN IF NOT EXISTS cost_type text NOT NULL DEFAULT 'legacy'` },
    // Migrations: rename legacy table and metadata key produced by earlier naming conventions.
    {
      text: `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'source_campaign_overrides'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'agent_campaign_overrides'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."source_campaign_overrides"
        RENAME TO "agent_campaign_overrides";
    ELSE
      INSERT INTO "${schemaName.replaceAll('"', '""')}"."agent_campaign_overrides"
        SELECT * FROM "${schemaName.replaceAll('"', '""')}"."source_campaign_overrides"
        ON CONFLICT DO NOTHING;
      DROP TABLE "${schemaName.replaceAll('"', '""')}"."source_campaign_overrides";
    END IF;
  END IF;
END $$`,
    },
    {
      text: `UPDATE "${schemaName.replaceAll('"', '""')}"."metadata"
  SET key = 'source_config:asset-blog'
  WHERE key = 'source_config:content-blog'`,
    },
    // agent_templates, agent_versions, agent_runs for @cinatra/agent-builder
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_templates" (
      id text PRIMARY KEY,
      org_id text,
      creator_id text,
      name text NOT NULL,
      description text,
      source_nl text NOT NULL,
      compiled_plan text NOT NULL,
      input_schema text NOT NULL,
      output_schema text,
      approval_policy text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_templates_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."agent_templates" (created_at DESC)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_versions" (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      version_number integer NOT NULL DEFAULT 1,
      content_hash text NOT NULL,
      snapshot text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_versions_template_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_versions" (template_id)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_runs" (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      version_id text,
      run_by text,
      status text NOT NULL DEFAULT 'queued',
      input_params text NOT NULL,
      step_results text,
      started_at timestamptz,
      completed_at timestamptz,
      error text
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_template_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (template_id)` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (status)` },
    // planned_actions and review_tasks tables are absent; synthetic IDs are used.
    // audit_events for @cinatra/authz: structured authorization audit log.
    // Full authorization-audit column set, all fields nullable except id (PK) and created_at.
    // Replaces the legacy HITL audit_events shape; the review_task_id
    // surface was retired. Drop block above (line ~135) handles legacy reset.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."audit_events" (
      id text PRIMARY KEY,
      organization_id text,
      actor_principal_id text,
      actor_principal_type text,
      auth_source text,
      delegated_by text,
      impersonated_user_id text,
      resource_type text,
      resource_id text,
      operation text,
      decision text,
      policy_version text,
      request_id text,
      run_id text,
      a2a_task_id text,
      ip text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    // Forward migration: upgrade legacy audit_events schemas that have the
    // legacy (review_task_id, actor_id, event_type, payload) HITL shape. The new
    // structured columns are ADDED idempotently; legacy columns are kept (NULL on
    // new rows) to avoid data loss for any historical HITL audit entries.
    { text: `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'audit_events' AND column_name = 'actor_principal_id'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."audit_events"
      ADD COLUMN IF NOT EXISTS organization_id text,
      ADD COLUMN IF NOT EXISTS actor_principal_id text,
      ADD COLUMN IF NOT EXISTS actor_principal_type text,
      ADD COLUMN IF NOT EXISTS auth_source text,
      ADD COLUMN IF NOT EXISTS delegated_by text,
      ADD COLUMN IF NOT EXISTS impersonated_user_id text,
      ADD COLUMN IF NOT EXISTS resource_type text,
      ADD COLUMN IF NOT EXISTS resource_id text,
      ADD COLUMN IF NOT EXISTS operation text,
      ADD COLUMN IF NOT EXISTS decision text,
      ADD COLUMN IF NOT EXISTS policy_version text,
      ADD COLUMN IF NOT EXISTS request_id text,
      ADD COLUMN IF NOT EXISTS run_id text,
      ADD COLUMN IF NOT EXISTS a2a_task_id text,
      ADD COLUMN IF NOT EXISTS ip text,
      ADD COLUMN IF NOT EXISTS metadata jsonb;
    -- Drop NOT NULL constraints on legacy HITL columns so the structured
    -- INSERT (which supplies none of these) does not fail on upgraded DBs.
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."audit_events"
      ALTER COLUMN review_task_id DROP NOT NULL,
      ALTER COLUMN actor_id DROP NOT NULL,
      ALTER COLUMN event_type DROP NOT NULL;
  END IF;
END $$` },
    // Drop the legacy review_task_id index if present — replaced by the new indexes below.
    { text: `DROP INDEX IF EXISTS "${schemaName.replaceAll('"', '""')}".audit_events_review_task_id_idx` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_actor_principal_id_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (actor_principal_id)` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (resource_type, resource_id)` },
    { text: `CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."audit_events" (created_at DESC)` },
    // dashboards + dashboard_revisions for @cinatra-ai/dashboards.
    // Idempotent — ALTERs below handle older schemas that lack CHECK constraints + lifecycle columns.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."dashboards" (
      id                        text PRIMARY KEY,
      name                      text NOT NULL,
      description               text,
      config_json               jsonb NOT NULL,
      config_version            text NOT NULL DEFAULT 'v1.2', -- DASHBOARD_CONFIG_VERSION=v1.2 (fresh-install apiVersion default; existing-DB flip in core__0006, cinatra#327)
      dashboard_version         integer NOT NULL DEFAULT 1,
      published_revision_number integer,
      owner_level               text NOT NULL CHECK (owner_level IN ('user','team','organization','workspace')),
      owner_id                  text NOT NULL,
      organization_id           text NOT NULL,
      visibility                text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','owners','members')),
      status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived','generation_failed')),
      created_by                text NOT NULL,
      updated_by                text,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),
      published_at              timestamptz,
      archived_at               timestamptz
    )` },
    { text: `CREATE INDEX IF NOT EXISTS dashboards_org_id_idx     ON "${schemaName.replaceAll('"', '""')}"."dashboards" (organization_id)` },
    { text: `CREATE INDEX IF NOT EXISTS dashboards_owner_idx      ON "${schemaName.replaceAll('"', '""')}"."dashboards" (owner_level, owner_id)` },
    { text: `CREATE INDEX IF NOT EXISTS dashboards_status_idx     ON "${schemaName.replaceAll('"', '""')}"."dashboards" (status)` },
    { text: `CREATE INDEX IF NOT EXISTS dashboards_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."dashboards" (created_at DESC)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."dashboard_revisions" (
      dashboard_id    text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."dashboards"(id) ON DELETE CASCADE,
      revision_number integer NOT NULL,
      config_json     jsonb NOT NULL,
      config_version  text NOT NULL,
      created_by      text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (dashboard_id, revision_number)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS dashboard_revisions_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."dashboard_revisions" (created_at DESC)` },
    // Idempotent CHECK constraints on the dashboards table.
    // CREATE TABLE IF NOT EXISTS doesn't apply constraints to a pre-existing
    // table; these DO blocks make the migration safe on dev instances that
    // were provisioned with a CHECK-free shape.
    { text: `DO $$ BEGIN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards"
        ADD CONSTRAINT dashboards_owner_level_check
        CHECK (owner_level IN ('user','team','organization','workspace'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    { text: `DO $$ BEGIN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards"
        ADD CONSTRAINT dashboards_visibility_check
        CHECK (visibility IN ('private','owners','members'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    { text: `DO $$ BEGIN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards"
        ADD CONSTRAINT dashboards_status_check
        CHECK (status IN ('draft','published','archived','generation_failed'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    // Extension-shipped + project-scoped dashboards. Additive:
    // existing rows default to operator-authored (extension_id NULL, is_template
    // false, project_id NULL). owner_level CHECK is UNCHANGED.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards" ADD COLUMN IF NOT EXISTS project_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards" ADD COLUMN IF NOT EXISTS extension_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards" ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards" ADD COLUMN IF NOT EXISTS template_scope text` },
    { text: `DO $$ BEGIN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dashboards"
        ADD CONSTRAINT dashboards_template_scope_check
        CHECK (template_scope IS NULL OR template_scope IN ('organization','team','workspace','user','project'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    { text: `CREATE INDEX IF NOT EXISTS dashboards_project_id_idx ON "${schemaName.replaceAll('"', '""')}"."dashboards" (project_id)` },
    // One TEMPLATE per (extension, org).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS dashboards_ext_template_uniq ON "${schemaName.replaceAll('"', '""')}"."dashboards" (extension_id, organization_id) WHERE extension_id IS NOT NULL AND is_template = true` },
    // One INSTANCE per (extension, org, project).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS dashboards_ext_instance_uniq ON "${schemaName.replaceAll('"', '""')}"."dashboards" (extension_id, organization_id, project_id) WHERE extension_id IS NOT NULL AND project_id IS NOT NULL` },
    // agent_registry_entries, agent_share_bindings, agent_forks for @cinatra/agent-builder registry
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_registry_entries" (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      version_id text NOT NULL,
      org_id text NOT NULL,
      published_by text NOT NULL,
      semver text NOT NULL,
      title text NOT NULL,
      description text,
      tool_access text NOT NULL,
      risk_level text NOT NULL,
      has_approval_gates boolean NOT NULL DEFAULT false,
      changelog text,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_registry_entries_org_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_registry_entries" (org_id)` },
    { text: `CREATE INDEX IF NOT EXISTS agent_registry_entries_template_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_registry_entries" (template_id)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_share_bindings" (
      id text PRIMARY KEY,
      registry_entry_id text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      can_view boolean NOT NULL DEFAULT true,
      can_run boolean NOT NULL DEFAULT false,
      can_edit_draft boolean NOT NULL DEFAULT false,
      can_publish boolean NOT NULL DEFAULT false,
      can_approve boolean NOT NULL DEFAULT false,
      granted_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_share_bindings_registry_entry_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_share_bindings" (registry_entry_id)` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_forks" (
      id text PRIMARY KEY,
      registry_entry_id text NOT NULL,
      forked_template_id text NOT NULL,
      forked_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_forks_registry_entry_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_forks" (registry_entry_id)` },
    // agent_templates task columns + agent_run_messages table
    // execution_mode ADD intentionally omitted; the column is retired permanently.
    // The DROP at the end of this migration chain is idempotent. Re-adding it here
    // would ratchet PostgreSQL's internal attnum counter on every restart, eventually
    // hitting the 1600-column hard limit even though live_cols stays small.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS task_spec text` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_messages" (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      role text NOT NULL,
      message_type text NOT NULL DEFAULT 'text',
      tool_call_id text,
      tool_name text,
      content text NOT NULL DEFAULT '',
      content_json text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_messages" (run_id, sequence)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_run_messages_run_id_sequence_unique ON "${schemaName.replaceAll('"', '""')}"."agent_run_messages" (run_id, sequence)` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_messages_tool_call_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_messages" (tool_call_id)` },
    // agent_run_hitl_prompts: WayFlow HITL amendment message capture for skill distillation
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_hitl_prompts" (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      agent_id text NOT NULL,
      step_key text NOT NULL,
      message text NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now(),
      excluded boolean NOT NULL DEFAULT false
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_hitl_prompts_run_id_agent_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_hitl_prompts" (run_id, agent_id)` },
    // submitted_values jsonb: structured renderer payload for HITL submission trail
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_run_hitl_prompts" ADD COLUMN IF NOT EXISTS submitted_values jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_run_hitl_prompts" ADD COLUMN IF NOT EXISTS schema_snapshot jsonb` },
    // agent_run_triggers: per-run trigger gate (immediate/scheduled/recurring)
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_triggers" (
      run_id text PRIMARY KEY REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      trigger_type text NOT NULL DEFAULT 'immediate',
      scheduled_at timestamptz,
      cron_expression text,
      timezone text NOT NULL DEFAULT 'UTC',
      enabled boolean NOT NULL DEFAULT true,
      released_at timestamptz,
      job_scheduler_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_triggers_released_at_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_triggers" (released_at)` },
    // agent_run_pm_links: schedule↔PM-task sync link table (cinatra#317). One
    // row per schedule-defining trigger mirrored to an external PM provider
    // (Plane). Keyed by run_id (one-to-one with the trigger). A link table, not
    // columns on agent_run_triggers, so a PM outage / absent provider leaves the
    // trigger untouched. external_task_id/synced_at are null until the first
    // successful push; sync_error holds the last fail-open error (null=healthy);
    // version is the optimistic-concurrency counter for the reconcile loop.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_pm_links" (
      run_id text PRIMARY KEY REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      provider text NOT NULL,
      external_task_id text,
      synced_at timestamptz,
      sync_error text,
      version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_pm_links_provider_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_pm_links" (provider)` },
    // agent_run_trigger_waits: in-flight WayFlow run
    // paused at a TriggerWaitNode. Distinct from agent_run_triggers (run-start
    // gate). PK is (run_id, node_id) to support multiple TriggerWaitNodes per
    // flow. agent_runs.id is text not uuid.
    // Resume path: trigger-release-job sends A2A message into a2a_context_id
    // (NOT re-dispatch from start).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_trigger_waits" (
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      node_id text NOT NULL,
      a2a_context_id text NOT NULL,
      trigger_config jsonb NOT NULL,
      expected_release_at timestamptz,
      armed_at timestamptz NOT NULL DEFAULT now(),
      attempt_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, node_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_run_trigger_waits_expected_release_at_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_trigger_waits" (expected_release_at) WHERE expected_release_at IS NOT NULL` },
    // email_send_events: append-only ledger of every
    // delivery attempt. Keyed by (org_id, recipient_email_normalized, ...)
    // so recipient-selection can apply a configurable cooldown filter
    // (default 30 days, configurable via cinatra.json) to prevent
    // re-spamming contacts who were emailed recently in any campaign.
    // Status enum: attempted (started), sent (delivered), skipped (filtered
    // by cooldown or dev-mode redirect), failed (provider error), replied
    // (reply received within cooldown window). idempotency_key UNIQUE
    // prevents twin-fire writes from the send executor.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."email_send_events" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      agent_package_name text NOT NULL,
      agent_template_id text NOT NULL,
      campaign_id text,
      channel text NOT NULL DEFAULT 'email',
      recipient_email_normalized text NOT NULL,
      contact_id text,
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('attempted','sent','skipped','failed','replied')),
      provider_send_id text,
      idempotency_key text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS email_send_events_cooldown_lookup_idx ON "${schemaName.replaceAll('"', '""')}"."email_send_events" (org_id, recipient_email_normalized, created_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS email_send_events_run_id_idx ON "${schemaName.replaceAll('"', '""')}"."email_send_events" (run_id, created_at DESC)` },
    // agent_run_skills_used: per-run snapshot of which
    // skills were actually invoked. Snapshot at run start (skills_installed_
    // resolve_for_agent populates the row set with invocation_count=0); the
    // /api/llm-bridge route increments invocation_count on each skill
    // resolution. Read by the new Skills tab in the run detail UI.
    // skill_kind enum no longer includes 'third-party';
    // GitHub-installed skills are now first-class extensions (kind=installed).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_run_skills_used" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      skill_id text NOT NULL,
      skill_kind text NOT NULL CHECK (skill_kind IN ('custom','installed','builtin')),
      first_invoked_at timestamptz NOT NULL DEFAULT now(),
      invocation_count integer NOT NULL DEFAULT 0
    )` },
    // Backfill existing rows in deployments with old skill_kind values
    // BEFORE we tighten the CHECK constraint. Idempotent: the WHERE clause
    // is a no-op on fresh deployments where no 'third-party' rows ever
    // existed.
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_run_skills_used"
             SET skill_kind = 'installed'
             WHERE skill_kind = 'third-party'` },
    // Drop the legacy CHECK constraint when present, then add the narrower
    // one. Idempotent across re-runs: both arms gate on
    // information_schema.table_constraints so each transition is a no-op
    // on already-converged deployments.
    { text: `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_column_usage ccu
            ON cc.constraint_name = ccu.constraint_name
          WHERE ccu.table_schema = '${schemaName.replaceAll("'", "''")}'
            AND ccu.table_name = 'agent_run_skills_used'
            AND ccu.column_name = 'skill_kind'
            AND cc.check_clause LIKE '%third-party%'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_run_skills_used"
            DROP CONSTRAINT IF EXISTS agent_run_skills_used_skill_kind_check;
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_run_skills_used"
            ADD CONSTRAINT agent_run_skills_used_skill_kind_check
            CHECK (skill_kind IN ('custom','installed','builtin'));
        END IF;
      END $$;` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_run_skills_used_run_skill_idx ON "${schemaName.replaceAll('"', '""')}"."agent_run_skills_used" (run_id, skill_id)` },
    // run_co_owners: per-run sharing join table.
    // Composite PK (run_id, user_id) is the natural uniqueness AND lookup
    // index for "is this user a co-owner of this run?". Secondary index on
    // user_id accelerates the future "list runs shared with me" query.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."run_co_owners" (
      run_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_runs"(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, user_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS run_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."run_co_owners" (user_id)` },
    // Defense-in-depth FK on run_co_owners.user_id
    // and run_co_owners.granted_by referencing the Better Auth public."user"
    // table. PostgreSQL supports cross-schema FKs; this catches non-existent
    // ids that the runtime org-membership check in addRunCoOwner missed
    // (e.g. a user deleted from Better Auth between session resolution and
    // the INSERT). Defensive DO blocks make the add idempotent across
    // re-runs (CREATE TABLE IF NOT EXISTS does not reapply constraints to
    // pre-existing tables).
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'run_co_owners'
            AND constraint_name = 'run_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."run_co_owners"
            ADD CONSTRAINT run_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'run_co_owners'
            AND constraint_name = 'run_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."run_co_owners"
            ADD CONSTRAINT run_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
      END $$;` },
    // trigger_mode + gated_steps on agent_templates (read by execution.ts and the Trigger tab UI).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS trigger_mode text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS gated_steps text` },
    // external_mcp_servers table for the external MCP server registry
    // scope values: 'global' | 'org' | 'team' | 'user'
    // API keys stored in Nango; nango_connection_id references the Nango connection per row
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" (
      id text PRIMARY KEY,
      label text NOT NULL,
      server_url text NOT NULL,
      nango_connection_id text,
      scope text NOT NULL DEFAULT 'global',
      org_id text,
      user_id text,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    // Migration: replace plaintext auth columns with Nango connection reference
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" ADD COLUMN IF NOT EXISTS nango_connection_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" DROP COLUMN IF EXISTS auth_header_name` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" DROP COLUMN IF EXISTS auth_header_value` },
    { text: `CREATE INDEX IF NOT EXISTS external_mcp_servers_scope_idx ON "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" (scope)` },
    { text: `CREATE INDEX IF NOT EXISTS external_mcp_servers_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" (user_id)` },
    { text: `CREATE INDEX IF NOT EXISTS external_mcp_servers_org_id_idx ON "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" (org_id)` },
    { text: `CREATE INDEX IF NOT EXISTS external_mcp_servers_enabled_scope_idx ON "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" (enabled, scope) WHERE enabled = true` },
    // Two-layer toolName enforcement.
    // allowed_tools: native MCP tools allowlist (filters tools/list visible to the LLM provider).
    // allowed_catalog_tools: workspace-catalog tools reachable via `execute_tool({toolName})`
    //   (filters the Twenty MCP proxy in src/lib/external-mcp/twenty-execute-tool-proxy.ts).
    // Both NULL = "no filter, pass everything authorized" (legacy behavior preserved for
    // rows created before this migration).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" ADD COLUMN IF NOT EXISTS allowed_tools text[]` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."external_mcp_servers" ADD COLUMN IF NOT EXISTS allowed_catalog_tools text[]` },
    // agent_runs consolidation: title, created_at, source_type, source_id columns
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS title text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()` },
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_runs" SET created_at = COALESCE(started_at, completed_at, created_at)` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'agent_builder'` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS source_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_source_lookup_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (source_type, source_id, created_at DESC)` },
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_runs" SET title = input_params::jsonb ->> '__agent_run_name' WHERE title IS NULL AND input_params::jsonb ? '__agent_run_name'` },
    // Insert synthetic system:* templates for scrape, research, enrichment.
    // execution_mode column omitted; it is retired by the DROP later in this chain.
    // package_name NOT NULL is set by a later migration; seed valid placeholders here so this INSERT does not fail on fresh-schema bootstrap. These rows are DELETEd by the next cleanup in this chain.
    { text: `INSERT INTO "${schemaName.replaceAll('"', '""')}"."agent_templates" (id, name, description, source_nl, compiled_plan, input_schema, approval_policy, status, package_name) VALUES ('system:scrape', 'Scrape Agent', 'System template for scrape agent runs', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/system-scrape'), ('system:research', 'Research Agent', 'System template for research agent runs', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/system-research'), ('system:enrichment', 'Enrichment Agent', 'System template for enrichment agent runs', '', '[]', '{}', '{"steps":[]}', 'published', '@cinatra/system-enrichment') ON CONFLICT DO NOTHING` },
    // Remove system:* agent templates (scrape/research/enrichment packages archived).
    { text: `DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" WHERE id IN ('system:scrape', 'system:research', 'system:enrichment')` },
    // agent_template_versions: immutable per-save snapshots with semver + diff support
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_template_versions" (
      id text PRIMARY KEY,
      template_id text NOT NULL,
      version_number integer NOT NULL,
      semver text NOT NULL,
      bump_type text NOT NULL,
      changelog_line text,
      content_hash text NOT NULL,
      snapshot text NOT NULL,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_template_versions_template_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_template_versions" (template_id, version_number DESC)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_template_versions_template_version_uniq ON "${schemaName.replaceAll('"', '""')}"."agent_template_versions" (template_id, version_number)` },
    // Pointer model: tracks which version is currently active (nullable; null = latest).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS current_version_id text` },
    // package_name / package_version: stable npm-package identity for git-native agents
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS package_name text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS package_version text` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_package_name_idx ON "${schemaName.replaceAll('"', '""')}"."agent_templates" (package_name) WHERE package_name IS NOT NULL` },
    // hitl_screens: JSON string array of namespaced x-renderer IDs
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS hitl_screens text` },
    // A2A version pinning: records the concrete semver resolved at request time
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS package_version text` },
    // A2A taskId/runId bridge for UI transport migration
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS a2a_task_id text` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_a2a_task_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (a2a_task_id) WHERE a2a_task_id IS NOT NULL` },
    // agent_dependencies: JSON-stringified Record<string,string> of @cinatra/* dep ranges
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS agent_dependencies text` },
    // connector_dependencies: JSON-stringified
    // Record<string,string> of @cinatra-ai/<x>-connector workspace dep ranges.
    // One-shot ADD COLUMN IF NOT EXISTS — nullable, no backfill (no legacy
    // values to migrate; agents publish with the field present).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS connector_dependencies text` },
    // type: leaf | proxy | orchestrator (default 'leaf')
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'leaf'` },
    // parent_run_id: self-referential FK for orchestrator sub-agent workspaces
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS parent_run_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_parent_run_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (parent_run_id) WHERE parent_run_id IS NOT NULL` },
    // Idempotent agent_run start for release-workflow dispatch
    // (additive; all nullable). Same idempotency_key → same child run; partial
    // unique enforces it. workflow_id/workflow_task_id are denormalized provenance.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS idempotency_key text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS workflow_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS workflow_task_id text` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_idempotency_key_uniq ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (idempotency_key) WHERE idempotency_key IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_workflow_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (workflow_id) WHERE workflow_id IS NOT NULL` },
    // Delegated execution-actor snapshot.
    // Captured at instantiate from the requesting user's ActorContext and
    // replayed at run-start re-authz + mid-run authz checks. Nullable JSON
    // text — legacy rows fall back to live-session derivation.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS delegated_actor_snapshot text` },
    // Per-scope role_grant store. Subject
    // is always a user. Scope is one of user/team/organization/
    // workspace/project. Idempotent CREATE TABLE — no legacy rows exist
    // One-shot table: drop never required.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."role_grant" (
      subject_user_id text NOT NULL,
      role            text NOT NULL CHECK (role IN ('developer','release_manager','customer')),
      scope_level     text NOT NULL CHECK (scope_level IN ('user','team','organization','workspace','project')),
      scope_record_id text NOT NULL,
      org_id          text NOT NULL,
      granted_by      text NOT NULL,
      granted_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz,
      PRIMARY KEY (subject_user_id, role, scope_level, scope_record_id)
    )` },
    // Subject + granter MUST be valid users.
    // Cross-schema FKs added as guarded ALTER TABLE so reruns on existing
    // schemas don't fail when the constraint is already present.
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'role_grant'
            AND constraint_name = 'role_grant_subject_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."role_grant"
            ADD CONSTRAINT role_grant_subject_fkey
            FOREIGN KEY (subject_user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'role_grant'
            AND constraint_name = 'role_grant_granted_by_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."role_grant"
            ADD CONSTRAINT role_grant_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id) ON DELETE SET NULL
            DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'role_grant'
            AND constraint_name = 'role_grant_org_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."role_grant"
            ADD CONSTRAINT role_grant_org_fkey
            FOREIGN KEY (org_id) REFERENCES public."organization"(id) ON DELETE CASCADE;
        END IF;
      END $$;` },
    { text: `CREATE INDEX IF NOT EXISTS role_grant_subject_idx ON "${schemaName.replaceAll('"', '""')}"."role_grant" (subject_user_id, org_id)` },
    { text: `CREATE INDEX IF NOT EXISTS role_grant_scope_idx ON "${schemaName.replaceAll('"', '""')}"."role_grant" (scope_level, scope_record_id)` },
    { text: `CREATE INDEX IF NOT EXISTS role_grant_org_idx ON "${schemaName.replaceAll('"', '""')}"."role_grant" (org_id, role)` },
    // io_spec: AgentIOSpec JSON blob; nullable; null = no I/O declaration yet
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS io_spec text` },
    // ag_ui_enabled: explicit AG-UI SSE capability marker on agent_runs.
    // Null for legacy runs (no backfill). True for new AG-UI-capable runs.
    // Used by AgenticRunPanel to route: SSE path (ag_ui_enabled=true) vs. legacy polling.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS ag_ui_enabled boolean` },
    // durable (distributed-tier flag) was added here, never consulted by any
    // routing/execution code, and dropped again — see migrations/0002. The
    // DROP keeps existing deployments in lockstep with fresh bootstraps,
    // which no longer create the column.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" DROP COLUMN IF EXISTS durable` },
    // hitl_required: HITL gate flag; default false
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS hitl_required boolean NOT NULL DEFAULT false` },
    // execution_provider: "openai"|"anthropic"|"gemini"|"default"; default "default"
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS execution_provider text NOT NULL DEFAULT 'default'` },
    // lg_thread_id: LangGraph Server thread correlation. Nullable — only set for
    // runs dispatched to LangGraph Server (template.execution_provider === 'langgraph').
    // Required for HITL resume: the worker reads this to call
    // client.runs.stream(thread_id, graph_id, { command: { resume: ... } }).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS lg_thread_id text` },
    // trace_id: OTel trace ID correlation on agent_runs.
    // Nullable; set at run start once a root span is started.
    // Correlates this run record with the full span tree in the cinatra.traces table.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS trace_id text` },
    // timeout_seconds: server-side run timeout.
    // When set, the execution worker self-terminates the run with error 'timed_out' if elapsed time exceeds this value.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS timeout_seconds integer` },
    // traces table: Postgres SpanExporter storage.
    // Composite PK (trace_id, span_id). attributes/events stored as jsonb.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."traces" (
  trace_id       text NOT NULL,
  span_id        text NOT NULL,
  parent_span_id text,
  name           text NOT NULL,
  service        text NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  duration_ms    integer,
  status         text NOT NULL DEFAULT 'unset',
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  events         jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_run_id   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, span_id)
)` },
    { text: `CREATE INDEX IF NOT EXISTS traces_trace_id_idx ON "${schemaName.replaceAll('"', '""')}"."traces" (trace_id)` },
    { text: `CREATE INDEX IF NOT EXISTS traces_agent_run_id_idx ON "${schemaName.replaceAll('"', '""')}"."traces" (agent_run_id) WHERE agent_run_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS traces_started_at_idx ON "${schemaName.replaceAll('"', '""')}"."traces" (started_at DESC)` },
    // lg_graph_code: Python StateGraph module emitted by the compiler.
    // Nullable — only set for execution_provider='langgraph' templates. Deployed to
    // LangGraph Server's graph registry on save/publish.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS lg_graph_code text` },
    // lg_graph_id: stable identifier used when registering/updating the
    // graph with LangGraph Server. Nullable — only set for execution_provider='langgraph'
    // templates.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS lg_graph_id text` },
    // objects table: generic typed-object store for future content types.
    // Existing content types (blog-post, email-draft, transcript-content) keep their
    // current storage to avoid a forced migration.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."objects" (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  parent_id   text,
  parent_type text,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  org_id      text
)` },
    { text: `CREATE INDEX IF NOT EXISTS objects_type_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (type)` },
    { text: `CREATE INDEX IF NOT EXISTS objects_parent_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (parent_id) WHERE parent_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS objects_org_type_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (org_id, type) WHERE org_id IS NOT NULL` },
    // Tenant-scoped blob metadata. Bytes live
    // on the blob store (data/artifacts), NEVER in objects.data. sha256
    // dedupe (if used) is internal + org-scoped — never global, never an
    // authorization signal. Additive, isolated table; no shared-table ALTER.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_blobs" (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  storage_backend text NOT NULL DEFAULT 'local-disk',
  storage_key     text NOT NULL,
  sha256          text NOT NULL,
  size_bytes      bigint NOT NULL,
  mime_detected   text NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_blobs_org_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_blobs" (org_id)` },
    // Internal, ORG-SCOPED dedupe lookup only (never global sha, never authz).
    { text: `CREATE INDEX IF NOT EXISTS artifact_blobs_org_sha_size_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_blobs" (org_id, sha256, size_bytes)` },
    // Immutable artifact versions. Each
    // upload/regeneration appends one immutable row; `objects.version` (a
    // mutable per-row counter for Graphiti staleness) is NEVER reused for
    // pinning. Full-fidelity `file` model from row one (architecture §2.2):
    // digest, mime/viewer_hint, origin_kind, editable body, image variants,
    // provenance, publication/reference metadata.
    // `artifact_versions` was the retired substrate
    // version table. RETIRED. The table is empty after the substrate
    // rows were purged; current writers do not touch it; the
    // serve resolver reads through `representation → resource →
    // artifact_blobs`). The DROP TABLE IF EXISTS lands here as
    // idempotent migration on live schemas; fresh schemas never
    // create the table.
    { text: `DROP TABLE IF EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_versions" CASCADE` },
    // Canonical normalized ArtifactRef. A run/message pins
    // {artifact_id, representation_revision_id, digest} immutably
    // (replay-safe); chat-thread JSON may cache a projection of
    // this, never the record.

    // Column rename `version_id` →
    // `representation_revision_id`. Fresh DDL uses the new name; the
    // idempotent ALTER block below renames the column on a live
    // schema (no-op when the new name is already in place).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_refs" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  artifact_id                 text NOT NULL,
  representation_revision_id  text NOT NULL,
  digest                      text NOT NULL,
  mime                        text NOT NULL,
  origin_kind                 text NOT NULL,
  referrer_kind               text NOT NULL,
  referrer_id                 text NOT NULL,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by                  text,
  created_at                  timestamptz NOT NULL DEFAULT now()
)` },
    // Idempotent live-schema column rename. Postgres `ALTER
    // TABLE RENAME COLUMN` lacks `IF EXISTS`, so guard with an
    // information_schema check inside a DO block.
    { text: `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='${schemaName.replaceAll('"', '""').replaceAll("'", "''")}'
      AND table_name='artifact_refs'
      AND column_name='version_id'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."artifact_refs"
      RENAME COLUMN version_id TO representation_revision_id;
  END IF;
END $$` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_refs_referrer_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_refs" (referrer_kind, referrer_id)` },
    // Index recreated under the new column name. PG keeps
    // the index name through RENAME COLUMN, so this is a no-op on live
    // schemas (the IF NOT EXISTS guard); fresh schemas get the index
    // under the new column.
    { text: `CREATE INDEX IF NOT EXISTS artifact_refs_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_refs" (org_id, artifact_id, representation_revision_id)` },
    // `artifact_refs` is the replay-safe
    // pin table. A unique index on the natural
    // pin key enables ON CONFLICT DO NOTHING idempotent inserts from
    // the chat-thread / agent-run / WayFlow-envelope writers.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_refs_pin_unique_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_refs" (org_id, artifact_id, representation_revision_id, referrer_kind, referrer_id)` },
    // The retired retention vehicle
    // (`artifact_versions.tombstoned_at / retain_until`) is retired
    // alongside the `artifact_versions` table itself (DROP above).
    // Current retention is `resource.metadata->>'retain_until'`, set by
    // tombstoneArtifact; physical GC is in
    // `artifact-retention.ts:runResourceBlobGc`.
    // Column rename `version_id` →
    // `representation_revision_id`. The column was already used to
    // store the representation pin (`createSemanticArtifact`
    // bound it as the audit row's representationRevisionId); this migration
    // renames the column to match its actual semantic.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_audit" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  artifact_id                 text NOT NULL,
  representation_revision_id  text,
  action                      text NOT NULL,
  actor                       text,
  detail                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
)` },
    { text: `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='${schemaName.replaceAll('"', '""').replaceAll("'", "''")}'
      AND table_name='artifact_audit'
      AND column_name='version_id'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."artifact_audit"
      RENAME COLUMN version_id TO representation_revision_id;
  END IF;
END $$` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_audit_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_audit" (org_id, artifact_id, created_at DESC)` },
    // Provider-file-ref cache. Maps an
    // (org, artifact-version, digest, provider) to the provider's uploaded
    // file id so the same artifact is NOT re-uploaded every turn. Holds
    // provider refs + metadata only — NEVER bytes. Expiry-aware; GC reaps
    // expired rows via the provider adapter's deleteFile. Additive table.
    // Column rename `version_id` →
    // `representation_revision_id`. The provider-cache stores the
    // provider's file id keyed by the artifact representation pin.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."artifact_provider_cache" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  artifact_id                 text NOT NULL,
  representation_revision_id  text NOT NULL,
  digest                      text NOT NULL,
  provider                    text NOT NULL,
  provider_file_id            text NOT NULL,
  mime                        text NOT NULL,
  size_bytes                  bigint NOT NULL DEFAULT 0,
  expires_at                  timestamptz,
  last_used_at                timestamptz NOT NULL DEFAULT now(),
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
)` },
    { text: `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='${schemaName.replaceAll('"', '""').replaceAll("'", "''")}'
      AND table_name='artifact_provider_cache'
      AND column_name='version_id'
  ) THEN
    ALTER TABLE "${schemaName.replaceAll('"', '""')}"."artifact_provider_cache"
      RENAME COLUMN version_id TO representation_revision_id;
  END IF;
END $$` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS artifact_provider_cache_key_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_provider_cache" (org_id, representation_revision_id, digest, provider)` },
    { text: `CREATE INDEX IF NOT EXISTS artifact_provider_cache_expiry_idx ON "${schemaName.replaceAll('"', '""')}"."artifact_provider_cache" (provider, expires_at) WHERE expires_at IS NOT NULL` },
    // Resource backend layer. A `resource` is the
    // concrete bytes-or-pointer the system can store/dedupe/audit; identity
    // is its SUBSTANCE (canonical+namespaced `substance_key` per kind —
    // file=blob:<sha256>, connector=connector:<kind>:<acct>:<extId>:<rev>:<mime>,
    // dashboard=dashboard:<sha256(canonicalSortedJSON)>). Dedupe by
    // (org_id, kind, substance_key). One resource may underlie
    // representations of many artifacts (multi-artifact attribution; the
    // representation link). Backend-only — never a UI
    // noun. Additive, isolated table; no shared-table ALTER. DB-level CHECK
    // guards on the kind + malware-status enums.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."resource" (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL,
  kind                text NOT NULL,
  substance_key       text NOT NULL,
  mime                text NOT NULL,
  size_bytes          bigint NOT NULL DEFAULT 0,
  malware_scan_status text NOT NULL DEFAULT 'pending',
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_kind_chk CHECK (kind IN ('blob','connector','dashboard')),
  CONSTRAINT resource_malware_chk CHECK (malware_scan_status IN ('pending','clean','flagged','skipped'))
)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS resource_substance_idx ON "${schemaName.replaceAll('"', '""')}"."resource" (org_id, kind, substance_key)` },
    { text: `CREATE INDEX IF NOT EXISTS resource_org_idx ON "${schemaName.replaceAll('"', '""')}"."resource" (org_id)` },
    // Representation binding + semantic assertion
    // + eligibility lifecycle. THE data-model pivot. `objects.type` for an
    // artifact is now ONE GENERIC type ("@cinatra-ai/artifact:object", no
    // semantic meaning); semantic identity = the `semantic_assertion` set.

    // `representation` is APPEND-ONLY: one immutable row
    // per (artifact, revision); a change = a NEW revision. Revision is
    // allocated in-tx under pg_advisory_xact_lock(hashtext(artifact_id)).
    // The BEFORE UPDATE/DELETE trigger makes the table physically append-only
    // (replay-safe pin = the representation row id).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."representation" (
  id                  text PRIMARY KEY,
  org_id              text NOT NULL,
  artifact_id         text NOT NULL,
  resource_id         text NOT NULL,
  revision            integer NOT NULL,
  form                text NOT NULL,
  created_by          text,
  created_by_run_id   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  classifier_signals  jsonb,
  CONSTRAINT representation_form_chk CHECK (form IN ('file','connectorRef','dashboard'))
)` },
    // Idempotent live-schema ALTER for the
    // classifier_signals column. PoC one-shot: pre-existing
    // representation rows stay NULL (no backfill). NULL ⇒ identical
    // observable behavior to the prior path. ADD COLUMN does NOT fire
    // `trg_representation_append_only` (BEFORE UPDATE OR DELETE only).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."representation" ADD COLUMN IF NOT EXISTS classifier_signals jsonb` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS representation_artifact_rev_idx ON "${schemaName.replaceAll('"', '""')}"."representation" (org_id, artifact_id, revision)` },
    { text: `CREATE INDEX IF NOT EXISTS representation_resource_idx ON "${schemaName.replaceAll('"', '""')}"."representation" (org_id, resource_id)` },
    { text: `CREATE INDEX IF NOT EXISTS representation_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."representation" (org_id, artifact_id)` },
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_representation_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'representation is append-only: % forbidden — write a new revision row instead', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_representation_append_only ON "${schemaName.replaceAll('"', '""')}"."representation"` },
    { text: `CREATE TRIGGER trg_representation_append_only BEFORE UPDATE OR DELETE ON "${schemaName.replaceAll('"', '""')}"."representation" FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_representation_append_only"()` },
    // `semantic_assertion` — the ONLY semantic identity of an artifact.
    // DB-level guards, generalizing the partial-index
    // lesson — service enforcement alone is insufficient against a raw-SQL/
    // MCP bypass):
    //  - asserted_by ∈ user|authoring_skill|agent|matcher; eligibility ∈
    //    eligible|draft|archived (enum CHECKs);
    //  - a `matcher` row may ONLY be draft|archived — NEVER eligible (so a
    //    matcher draft can never become eligible by UPDATE either);
    //  - a non-matcher row is NEVER `draft` (draft is the matcher-pending
    //    state only);
    //  - ≤1 ACTIVE (non-archived) assertion per (org,artifact,extension)
    //    (partial-unique);
    //  - BEFORE UPDATE trigger freezes extension/asserted_by/asserted_at/
    //    confidence (reclassification = a NEW row, never a mutation —
    //    replay-safety).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (
  id                    text PRIMARY KEY,
  org_id                text NOT NULL,
  artifact_id           text NOT NULL,
  extension             text NOT NULL,
  asserted_by           text NOT NULL,
  eligibility           text NOT NULL,
  confidence            double precision,
  asserted_by_principal text,
  asserted_at           timestamptz NOT NULL DEFAULT now(),
  archived_at           timestamptz,
  CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher')),
  CONSTRAINT sa_elig_chk CHECK (eligibility IN ('eligible','draft','archived')),
  CONSTRAINT sa_matcher_draft_chk CHECK (asserted_by <> 'matcher' OR eligibility IN ('draft','archived')),
  CONSTRAINT sa_nonmatcher_nodraft_chk CHECK (asserted_by = 'matcher' OR eligibility <> 'draft')
)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS sa_active_unique_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id, extension) WHERE eligibility <> 'archived'` },
    { text: `CREATE INDEX IF NOT EXISTS sa_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id)` },
    { text: `CREATE INDEX IF NOT EXISTS sa_eligible_idx ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" (org_id, artifact_id) WHERE eligibility = 'eligible'` },
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_semantic_assertion_frozen"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.extension <> OLD.extension OR NEW.asserted_by <> OLD.asserted_by
     OR NEW.asserted_at <> OLD.asserted_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.artifact_id <> OLD.artifact_id OR NEW.org_id <> OLD.org_id THEN
    RAISE EXCEPTION 'semantic_assertion identity is immutable: extension/asserted_by/asserted_at/confidence/artifact_id/org_id cannot change — reclassification must INSERT a new assertion';
  END IF;
  -- The ONLY legal eligibility UPDATE is a
  -- transition INTO 'archived' from a non-archived state. No resurrection
  -- (archived -> eligible/draft), no eligible<->draft re-write, no
  -- archived no-op churn. Becoming eligible/draft happens ONLY via INSERT
  -- This preserves raw-SQL and MCP defense-in-depth.
  IF NEW.eligibility <> OLD.eligibility THEN
    IF OLD.eligibility = 'archived' OR NEW.eligibility <> 'archived' THEN
      RAISE EXCEPTION 'semantic_assertion eligibility may only transition to archived from a non-archived state: % -> % forbidden — becoming eligible/draft requires a new INSERT', OLD.eligibility, NEW.eligibility;
    END IF;
  END IF;
  RETURN NEW;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_semantic_assertion_frozen ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion"` },
    { text: `CREATE TRIGGER trg_semantic_assertion_frozen BEFORE UPDATE ON "${schemaName.replaceAll('"', '""')}"."semantic_assertion" FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_semantic_assertion_frozen"()` },
    // ---- run_context_selections audit table ----

    // Append-only audit row written by the context-agent at every
    // selection. PINS the replay-safe triple
    // (artifact_id, representation_revision_id, semantic_assertion_id)
    // so future replays of the parent run resolve to the EXACT artifact
    // version + the EXACT extension classification that was selected at
    // run-time, even if the artifact gets re-classified or the
    // representation gets a newer revision later.

    // Replay-safety guard: like semantic_assertion this
    // table is append-only — never UPDATE or DELETE. A correction is a
    // NEW row, not a mutation.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."run_context_selections" (
  id                          text PRIMARY KEY,
  org_id                      text NOT NULL,
  parent_run_id               text NOT NULL,
  parent_package_name         text NOT NULL,
  slot_id                     text NOT NULL,
  artifact_id                 text NOT NULL,
  representation_revision_id  text NOT NULL,
  semantic_assertion_id       text NOT NULL,
  extension                   text NOT NULL,
  source_scope                text NOT NULL,
  selected_by                 text NOT NULL,
  selection_mode              text NOT NULL,
  selected_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rcs_source_chk CHECK (source_scope IN ('user','team','organization','workspace','project')),
  CONSTRAINT rcs_selectedby_chk CHECK (selected_by IN ('user','agent','autonomous')),
  CONSTRAINT rcs_selmode_chk CHECK (selection_mode IN ('interactive','autonomous'))
)` },
    { text: `CREATE INDEX IF NOT EXISTS rcs_run_idx ON "${schemaName.replaceAll('"', '""')}"."run_context_selections" (org_id, parent_run_id, selected_at)` },
    { text: `CREATE INDEX IF NOT EXISTS rcs_artifact_idx ON "${schemaName.replaceAll('"', '""')}"."run_context_selections" (org_id, artifact_id)` },
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_run_context_selections_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'run_context_selections is append-only: % forbidden — write a NEW audit row to correct a prior selection', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_run_context_selections_append_only ON "${schemaName.replaceAll('"', '""')}"."run_context_selections"` },
    { text: `CREATE TRIGGER trg_run_context_selections_append_only BEFORE UPDATE OR DELETE ON "${schemaName.replaceAll('"', '""')}"."run_context_selections" FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_run_context_selections_append_only"()` },
    // ---- authoring_invocation_ledger ----

    // Operational recursion-control table for authoring-skill chains.
    // Recorded BEFORE an authoring step admits child fan-out so the
    // server can refuse cycles (same `extension` already on the chain)
    // or excessive depth (default cap 8, env-overridable
    // CINATRA_AUTHORING_MAX_DEPTH, clamped 1..32).

    // **Operational, NOT append-only**: a future
    // TTL sweep deletes rows older than 30 days (orphaned chains from
    // crashed/aborted runs). status='committed'|'aborted' is the
    // signal for finished chains; rows in 'open' that are older than
    // the TTL are abandoned and safe to remove.

    // `parent_step_id` is server-derived from the calling context
    // (agent_run parent_run_id, or NULL for chat-skill direct root) —
    // NEVER trusted from LLM-supplied input.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."authoring_invocation_ledger" (
  authoring_step_id           text PRIMARY KEY,
  org_id                      text NOT NULL,
  parent_step_id              text,
  extension                   text NOT NULL,
  depth                       int NOT NULL,
  run_id                      text,
  status                      text NOT NULL DEFAULT 'open',
  started_at                  timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  CONSTRAINT ail_depth_chk CHECK (depth >= 0 AND depth <= 32),
  CONSTRAINT ail_status_chk CHECK (status IN ('open','committed','aborted'))
)` },
    { text: `CREATE INDEX IF NOT EXISTS ail_org_run_idx ON "${schemaName.replaceAll('"', '""')}"."authoring_invocation_ledger" (org_id, run_id)` },
    { text: `CREATE INDEX IF NOT EXISTS ail_org_parent_idx ON "${schemaName.replaceAll('"', '""')}"."authoring_invocation_ledger" (org_id, parent_step_id)` },
    { text: `CREATE INDEX IF NOT EXISTS ail_started_at_idx ON "${schemaName.replaceAll('"', '""')}"."authoring_invocation_ledger" (started_at)` },
    // skill_label: LLM call skill attribution.
    // Nullable; historical rows remain NULL; forward-only attribution.
    // Index matches the (skill_label, occurred_at DESC) shape used by readCostBySkill.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."usage_events" ADD COLUMN IF NOT EXISTS skill_label text` },
    { text: `CREATE INDEX IF NOT EXISTS usage_events_skill_label_occurred_at_idx ON "${schemaName.replaceAll('"', '""')}"."usage_events" (skill_label, occurred_at DESC)` },
    // External A2A template columns.
    // source_type discriminates Cinatra-built ("internal") from remote A2A servers
    // ("external"). agent_url holds the canonical base URL for external templates
    // (normalized: lowercase scheme+host, trailing slashes stripped). connector_slug
    // + remote_agent_id form the composite upsert key (stable across display-name
    // changes and version bumps).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'internal'` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS agent_url text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS connector_slug text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS remote_agent_id text` },
    // Drop execution_mode column entirely. All templates are LangGraph;
    // the deterministic/agentic distinction is vestigial. IF EXISTS makes this
    // idempotent on repeated boots after the column is gone.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" DROP COLUMN IF EXISTS execution_mode` },
    // Objects-layer: generic typed-object store fronted by Graphiti
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" (
  type              text PRIMARY KEY,
  display_name      text NOT NULL,
  inferred_category text NOT NULL,
  slug              text,
  json_schema       jsonb,
  source            text,
  confidence        text,
  status            text NOT NULL DEFAULT 'proposed',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  promoted_to_type  text
)` },
    // object_sync_adapter_configs disambiguates from transport "connector" packages.
    // Existing DBs are migrated separately; ensurePostgresSchema below uses
    // the current name on fresh DBs.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" (
  id            text PRIMARY KEY,
  object_type   text NOT NULL,
  adapter_id    text NOT NULL,
  config        jsonb NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(object_type, adapter_id)
)` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS exported_to jsonb NOT NULL DEFAULT '{}'::jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS deleted_at timestamptz` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS classification_confidence real` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS agent_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS run_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS source text` },
    // Surface OAS-format and package-version provenance alongside
    // the existing agent_id / run_id columns so the shadow PG table is fully
    // queryable by (run, agent, version, spec) without going through Graphiti.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS package_version text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS agent_spec_version text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS canonical_keys text[]` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS external_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_sync_status text NOT NULL DEFAULT 'synced'` },
    { text: `CREATE INDEX IF NOT EXISTS objects_deleted_at_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (deleted_at) WHERE deleted_at IS NULL` },
    { text: `CREATE INDEX IF NOT EXISTS objects_external_id_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (external_id) WHERE external_id IS NOT NULL` },
    // Partial indexes for the new attribution dimensions; partial
    // (WHERE … IS NOT NULL) keeps storage tight for non-agent rows.
    { text: `CREATE INDEX IF NOT EXISTS objects_run_id_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (run_id) WHERE run_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS objects_agent_id_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (agent_id) WHERE agent_id IS NOT NULL` },
    // Postgres-primary projection metadata + outbox.
    // The version column is required by the version-guard SQL in the projector
    // the 5 graphiti_* columns are the projection state machine the
    // projector updates after a successful add_episode call. The new
    // graphiti_projection_outbox table is the durable outbox the repair worker
    // drains every ~30s. Pattern: inline ALTER … ADD COLUMN IF NOT
    // EXISTS, idempotent on every boot — no drizzle-kit migration files.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_episode_uuid TEXT` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_projected_version INTEGER` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_projected_hash TEXT` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_projected_at TIMESTAMPTZ` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS graphiti_projection_error TEXT` },
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  object_id TEXT NOT NULL,
  object_version INTEGER NOT NULL,
  org_id TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
)` },
    { text: `CREATE INDEX IF NOT EXISTS graphiti_outbox_pending_idx ON "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" (status, created_at) WHERE status IN ('pending', 'failed')` },
    { text: `CREATE INDEX IF NOT EXISTS graphiti_outbox_object_idx ON "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" (object_id)` },
    // object_sync_adapter_configs backfill: columns added after the
    // initial id/payload schema; ALTER TABLE guards let older branch schemas
    // catch up on next startup. The table + column are replacing
    // the prior object_connector_configs /
    // connector_id form for existing DBs.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS object_type text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS adapter_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS created_by text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()` },
    { text: `CREATE INDEX IF NOT EXISTS object_sync_adapter_configs_type_idx ON "${schemaName.replaceAll('"', '""')}"."object_sync_adapter_configs" (object_type) WHERE is_active = true` },
    // dynamic_object_types backfill — columns added after the initial id/payload schema.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS type text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS display_name text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS inferred_category text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS slug text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS json_schema jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS source text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS confidence text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'proposed'` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS created_by text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS promoted_to_type text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS identity_key text` },
    // Reconcile confidence column type (real → text) and add origin_context.
    // The cast is safe because no production rows have written to confidence — this column
    // was declared earlier but never populated by any caller.
    // Both entries are idempotent: ALTER COLUMN ... USING ::text is a no-op once already text.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ALTER COLUMN confidence TYPE text USING confidence::text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."dynamic_object_types" ADD COLUMN IF NOT EXISTS origin_context jsonb` },
    // streamed_text: accumulated external A2A peer text output,
    // persisted on clean RUN_FINISHED by external-sse-proxy. Nullable;
    // legacy rows + internal runs + incomplete externals remain NULL.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS streamed_text text` },
    // a2a_context_id: fasta2a conversation context ID for WayFlow resume.
    // Resume sends a new message into the same context so the flow continues from
    // the input-required checkpoint rather than starting a fresh conversation.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS a2a_context_id text` },
    // projects table for the bounded-work-context model.
    // id text PK (random UUID generated in app code via crypto.randomUUID()).
    // owner_level + owner_id resolve via app code.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."projects" (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      owner_level text NOT NULL,
      owner_id text NOT NULL,
      visibility text NOT NULL DEFAULT 'private',
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS projects_owner_idx ON "${schemaName.replaceAll('"', '""')}"."projects" (owner_level, owner_id)` },
    { text: `CREATE INDEX IF NOT EXISTS projects_created_at_idx ON "${schemaName.replaceAll('"', '""')}"."projects" (created_at DESC)` },
    // organization_id column for the kernel cross-org guard.
    // Idempotent ALTER. Nullable: legacy rows stay NULL (kernel treats NULL
    // as "no tenant constraint" for legacy rows).
    // New writes populate this from the requester's active org.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."projects" ADD COLUMN IF NOT EXISTS organization_id text` },
    { text: `CREATE INDEX IF NOT EXISTS projects_organization_id_idx ON "${schemaName.replaceAll('"', '""')}"."projects" (organization_id)` },
    // Archive-only lifecycle. Nullable;
    // existing rows = NULL = active. No backfill. No projects_delete ever.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."projects" ADD COLUMN IF NOT EXISTS archived_at timestamptz` },
    // service_accounts credential store
    // Persistent identity layer for external A2A service accounts. Cinatra-specific
    // metadata (scopes, org binding, revocation, rotation) lives here; the OAuth
    // client_id/client_secret pair lives in better-auth's public."oauthClient".
    // Linked via service_accounts.client_id ↔ "oauthClient"."clientId".
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."service_accounts" (
      id                  text PRIMARY KEY,
      name                text NOT NULL,
      org_id              text,
      client_id           text NOT NULL UNIQUE,
      scopes              text NOT NULL DEFAULT '',
      revoked_at          timestamptz,
      rotated_at          timestamptz,
      previous_client_id  text,
      grace_period_seconds integer NOT NULL DEFAULT 900,
      created_by          text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS service_accounts_client_id_idx ON "${schemaName.replaceAll('"', '""')}"."service_accounts" (client_id)` },
    { text: `CREATE INDEX IF NOT EXISTS service_accounts_org_id_idx ON "${schemaName.replaceAll('"', '""')}"."service_accounts" (org_id)` },
    // AgentAuthPolicy: ownership and access-control model for Cinatra-built agents.
    // agentAuthPolicy on agent_templates: template-level default policy (JSON-as-text; nullable = use DEFAULT_AGENT_AUTH_POLICY).
    // authPolicy on agent_runs: per-run override (JSON-as-text; nullable = use template's agentAuthPolicy or DEFAULT_AGENT_AUTH_POLICY).
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS agent_auth_policy text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS auth_policy text` },
    // agent_runs.org_id: org-scoping for run lists.
    // Nullable; existing rows remain NULL (visible only to platform-admin
    // cross-org reads via skipOrgFilter). No automatic backfill — document
    // as admin task.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS org_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_org_id_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (org_id)` },
    // agent_runs.project_id inheritance
    // carrier). Nullable refinement, never an ownership tier. agent_runs has
    // created_at (added earlier in this array) + status. Partial indexes:
    // project listing + project+status active-run move guard.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ADD COLUMN IF NOT EXISTS project_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (project_id, created_at DESC) WHERE project_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS agent_runs_project_status_idx ON "${schemaName.replaceAll('"', '""')}"."agent_runs" (project_id, status, created_at DESC) WHERE project_id IS NOT NULL` },
    // agent_runs.org_id NOT NULL. Drops legacy NULL rows; no backfill.
    // PoC mode (no production data preservation). Idempotent: DELETE matches zero
    // rows on subsequent boots once the column is NOT NULL, and ALTER on an
    // already-NOT-NULL column is a no-op in Postgres.
    // Order matters: DELETE must precede ALTER — PG rejects SET NOT NULL on a
    // column with NULL rows.
    { text: `DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_runs" WHERE org_id IS NULL` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs" ALTER COLUMN org_id SET NOT NULL` },
    // Backfill NULL package_name rows with deterministically-unique
    // values then enforce NOT NULL. Unconditional templateId suffix guarantees uniqueness
    // even when multiple legacy rows share creator+name. The migration is
    // idempotent — once SET NOT NULL succeeds, the WHERE filter on the UPDATE matches
    // zero rows on subsequent runs, and the ALTER is a no-op when the column is already
    // NOT NULL.


    // Lowercase + slugify the creator_id and id segments so
    // the backfilled package_name matches the strict resolveWayflowUrl regex
    // (`/^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/`). Without the
    // LOWER + REGEXP_REPLACE on creator_id/id, mixed-case better-auth user ids
    // ("Vqp7kZ9...") would produce package names that fail the manifest
    // round-trip and 502 against the catch-all proxy.
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_templates"
       SET package_name = '@user-' ||
                          REGEXP_REPLACE(LOWER(COALESCE(creator_id::text, 'unknown')), '[^a-z0-9-]+', '-', 'g') || '/' ||
                          REGEXP_REPLACE(LOWER(COALESCE(name, 'untitled')), '[^a-z0-9-]+', '-', 'g') || '-' ||
                          REGEXP_REPLACE(LOWER(id::text), '[^a-z0-9-]+', '-', 'g')
       WHERE package_name IS NULL` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ALTER COLUMN package_name SET NOT NULL` },
    // Objects scope columns + project_co_owners join table.
    // Objects has NO Drizzle binding by deliberate design (raw-SQL store at
    // src/lib/objects-store.ts); the ALTERs below are idempotent and live
    // entirely in this boot-time migration array. Backfill defaults to
    // org-scope per CONTEXT Open Question #2 resolution: existing rows are
    // safe to surface to organization members because org_id was the only
    // tenant boundary enforced for those rows.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS owner_level text NOT NULL DEFAULT 'organization'` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS owner_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'organization'` },
    // Backfill owner_id from org_id for any pre-existing rows. Idempotent:
    // once SET NOT NULL succeeds the WHERE filter matches zero rows.
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."objects" SET owner_id = org_id WHERE owner_id IS NULL AND org_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS objects_owner_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (owner_level, owner_id)` },
    // objects.project_id. This ONE
    // column covers BOTH objects AND artifacts: artifacts are objects rows of
    // SEMANTIC_ARTIFACT_OBJECT_TYPE (there is NO physical artifacts table —
    // there is no physical artifacts table). Nullable refinement, never an
    // ownership tier. Composite (owner + project + recency) for project
    // listing; partial project index for sealed-room.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS project_id text` },
    { text: `CREATE INDEX IF NOT EXISTS objects_owner_project_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (owner_level, owner_id, project_id, created_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS objects_project_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (project_id, created_at DESC) WHERE project_id IS NOT NULL` },
    // project_co_owners: per-project sharing join table.
    // Mirrors run_co_owners including the cross-schema
    // DO-block FKs to public."user". Composite PK (project_id, user_id) is
    // both the natural uniqueness constraint and the lookup index for
    // "is this user a co-owner of this project?". Secondary index on user_id
    // accelerates "list projects shared with me".
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."project_co_owners" (
      project_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."projects"(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      granted_by text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS project_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."project_co_owners" (user_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'project_co_owners'
            AND constraint_name = 'project_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."project_co_owners"
            ADD CONSTRAINT project_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'project_co_owners'
            AND constraint_name = 'project_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."project_co_owners"
            ADD CONSTRAINT project_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
      END $$;` },
    // ───────────────────────────────────────────────────────────────────
    // Project scoping tables.
    // project_access REPLACES user-only project_co_owners with an
    // N:M principal model; owner is implicit and never a row here.
    // Emitted AFTER projects + project_co_owners + agent_templates, all of
    // which exist earlier in this array.
    // ───────────────────────────────────────────────────────────────────
    // project_access. Polymorphic principal_id with per-type CASCADE FK
    // via STORED GENERATED columns (NULL for non-matching level → FK not
    // enforced). workspace principal canonicalized to '__workspace__'
    // (matches the existing reserved sentinel).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."project_access" (
      project_id      text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."projects"(id) ON DELETE CASCADE,
      principal_level text NOT NULL CHECK (principal_level IN ('user','team','organization','workspace')),
      principal_id    text NOT NULL,
      role            text NOT NULL CHECK (role IN ('read','write','admin')),
      granted_by      text NOT NULL,
      granted_at      timestamptz NOT NULL DEFAULT now(),
      principal_user_id text GENERATED ALWAYS AS (CASE WHEN principal_level='user'         THEN principal_id END) STORED,
      principal_team_id text GENERATED ALWAYS AS (CASE WHEN principal_level='team'         THEN principal_id END) STORED,
      principal_org_id  text GENERATED ALWAYS AS (CASE WHEN principal_level='organization' THEN principal_id END) STORED,
      CONSTRAINT project_access_workspace_principal_chk CHECK (
        (principal_level =  'workspace' AND principal_id =  '__workspace__') OR
        (principal_level <> 'workspace' AND principal_id <> '__workspace__')),
      PRIMARY KEY (project_id, principal_level, principal_id)
    )` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'project_access'
            AND constraint_name = 'project_access_user_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."project_access"
            ADD CONSTRAINT project_access_user_fkey
            FOREIGN KEY (principal_user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'project_access'
            AND constraint_name = 'project_access_team_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."project_access"
            ADD CONSTRAINT project_access_team_fkey
            FOREIGN KEY (principal_team_id) REFERENCES public."team"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'project_access'
            AND constraint_name = 'project_access_org_fkey') THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."project_access"
            ADD CONSTRAINT project_access_org_fkey
            FOREIGN KEY (principal_org_id) REFERENCES public."organization"(id) ON DELETE CASCADE;
        END IF;
      END $$;` },
    { text: `CREATE INDEX IF NOT EXISTS project_access_user_idx ON "${schemaName.replaceAll('"', '""')}"."project_access" (principal_user_id) WHERE principal_user_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS project_access_team_idx ON "${schemaName.replaceAll('"', '""')}"."project_access" (principal_team_id) WHERE principal_team_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS project_access_org_idx ON "${schemaName.replaceAll('"', '""')}"."project_access" (principal_org_id) WHERE principal_org_id IS NOT NULL` },
    // Workspace grants have no generated column;
    // the resolver needs a lookup path for them.
    { text: `CREATE INDEX IF NOT EXISTS project_access_workspace_idx ON "${schemaName.replaceAll('"', '""')}"."project_access" (project_id) WHERE principal_level = 'workspace' AND principal_id = '__workspace__'` },
    // Same-org validation trigger. Idempotent:
    // CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER
    // (mirrors fn_notify_notification_insert). Better-auth membership tables
    // live in public and exist when this applies (real-DB connection).
    // FAIL CLOSED. org-NULL project must reject
    // every non-workspace principal: no org anchor means it cannot validate
    // membership → must NOT bypass). Missing project row → reject.
    { text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_project_access_same_org"() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE proj_org text;
      BEGIN
        SELECT organization_id INTO proj_org FROM "${schemaName.replaceAll('"', '""')}"."projects" WHERE id = NEW.project_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'project_access: project % does not exist', NEW.project_id;
        END IF;
        IF proj_org IS NULL THEN
          IF NEW.principal_level <> 'workspace' THEN
            RAISE EXCEPTION 'project_access: % grant requires project organization_id; only workspace grant is allowed for org-null projects', NEW.principal_level;
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.principal_level = 'user' THEN
          IF NOT EXISTS (
            SELECT 1 FROM public.member m WHERE m."userId" = NEW.principal_id AND m."organizationId" = proj_org) THEN
            RAISE EXCEPTION 'project_access: user % is not a member of project org %', NEW.principal_id, proj_org;
          END IF;
        ELSIF NEW.principal_level = 'team' THEN
          IF NOT EXISTS (
            SELECT 1 FROM public."team" t WHERE t.id = NEW.principal_id AND t."organizationId" = proj_org) THEN
            RAISE EXCEPTION 'project_access: team % is not in project org %', NEW.principal_id, proj_org;
          END IF;
        ELSIF NEW.principal_level = 'organization' THEN
          IF NEW.principal_id <> proj_org THEN
            RAISE EXCEPTION 'project_access: organization principal % must equal project org %', NEW.principal_id, proj_org;
          END IF;
        ELSIF NEW.principal_level = 'workspace' THEN
          RAISE EXCEPTION 'project_access: workspace grant not allowed on org-bound project (org %)', proj_org;
        END IF;
        RETURN NEW;
      END;
      $body$` },
    { text: `DROP TRIGGER IF EXISTS trg_project_access_same_org ON "${schemaName.replaceAll('"', '""')}"."project_access"` },
    { text: `CREATE TRIGGER trg_project_access_same_org BEFORE INSERT OR UPDATE ON "${schemaName.replaceAll('"', '""')}"."project_access" FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}"."fn_project_access_same_org"()` },
    // project_agent_template_bindings (tool curation; templates stay
    // ambient). FK to agent_templates so template removal cannot
    // orphan bindings. jsonb object CHECK on overrides.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."project_agent_template_bindings" (
      project_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."projects"(id) ON DELETE CASCADE,
      agent_template_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id) ON DELETE CASCADE,
      visibility text NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden','project-private')),
      pinned_version text,
      default_context_overrides jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT patb_overrides_object_chk CHECK (default_context_overrides IS NULL OR jsonb_typeof(default_context_overrides) = 'object'),
      PRIMARY KEY (project_id, agent_template_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS patb_template_idx ON "${schemaName.replaceAll('"', '""')}"."project_agent_template_bindings" (agent_template_id)` },
    // resource_project_moves: append-only move audit.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."resource_project_moves" (
      id text PRIMARY KEY,
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      old_project_id text,
      new_project_id text,
      actor_id text NOT NULL,
      source_run_id text,
      source_thread_id text,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS resource_project_moves_resource_idx ON "${schemaName.replaceAll('"', '""')}"."resource_project_moves" (resource_kind, resource_id, created_at DESC)` },
    // project_resource_refs: cross-project linked refs; blocked-by-
    // default external link. Double FK to projects.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."project_resource_refs" (
      id text PRIMARY KEY,
      source_project_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."projects"(id) ON DELETE CASCADE,
      target_project_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."projects"(id) ON DELETE CASCADE,
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_project_id, target_project_id, resource_kind, resource_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS project_resource_refs_source_idx ON "${schemaName.replaceAll('"', '""')}"."project_resource_refs" (source_project_id, created_at DESC)` },
    // custom_skill_assignments: ownership-scoped resolution
    // for custom skills. Idempotent. Workspace enum value reserved but never written.
    // Plain {text, values} objects only — Worker structured-clone rejects methods.
    {
      text: `DO $$ BEGIN
  CREATE TYPE "${schemaName.replaceAll('"', '""')}"."custom_skill_owner_type" AS ENUM ('user','team','project','organization','workspace');
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."custom_skill_assignments" (
      skill_id text NOT NULL,
      agent_id text NOT NULL,
      owner_type "${schemaName.replaceAll('"', '""')}"."custom_skill_owner_type" NOT NULL,
      owner_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      PRIMARY KEY (skill_id, agent_id)
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS custom_skill_assignments_owner_idx ON "${schemaName.replaceAll('"', '""')}"."custom_skill_assignments" (owner_type, owner_id)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS custom_skill_assignments_agent_idx ON "${schemaName.replaceAll('"', '""')}"."custom_skill_assignments" (agent_id)`,
    },
    // Derived-store ownership columns.
    // org_id already exists on objects + graphiti_projection_outbox; add the
    // remaining tuple (owner_type, owner_id, visibility) as nullable for
    // lazy-backfill semantics.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS owner_type text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS owner_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."objects" ADD COLUMN IF NOT EXISTS visibility text` },
    { text: `CREATE INDEX IF NOT EXISTS objects_ownership_idx ON "${schemaName.replaceAll('"', '""')}"."objects" (org_id, owner_type, owner_id)` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" ADD COLUMN IF NOT EXISTS owner_type text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" ADD COLUMN IF NOT EXISTS owner_id text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."graphiti_projection_outbox" ADD COLUMN IF NOT EXISTS visibility text` },
    // ---------------------------------------------------------------------------
    // Extension lifecycle: pgEnum, status columns, RESTRICT FKs,
    // and audit table. All entries are idempotent.
    // ---------------------------------------------------------------------------
    // Step 1: Create the pgEnum for extension lifecycle status.
    {
      text: `DO $$ BEGIN
  CREATE TYPE "${schemaName.replaceAll('"', '""')}"."extension_lifecycle_status" AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    },
    // The canonical installed_extension manifest is the single source of
    // truth; the per-kind extension_lifecycle_status columns are NOT
    // CREATED here. The pgEnum above is retained (harmless; referenced
    // by the 'locked' ALTER below) but no longer backs any per-kind column.
    // Step 4a: RESTRICT FK — agent_runs.template_id → agent_templates(id).
    // Uses NOT VALID to avoid a blocking lock on a large table.
    { text: `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
        AND table_name = 'agent_runs'
        AND constraint_name = 'agent_runs_template_id_fkey'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs"
        ADD CONSTRAINT agent_runs_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id)
        ON DELETE RESTRICT NOT VALID;
    END IF;
  END $$;` },
    // Step 4b: RESTRICT FK — agent_versions.template_id → agent_templates(id).
    { text: `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
        AND table_name = 'agent_versions'
        AND constraint_name = 'agent_versions_template_id_fkey'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_versions"
        ADD CONSTRAINT agent_versions_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id)
        ON DELETE RESTRICT NOT VALID;
    END IF;
  END $$;` },
    // Step 4c: RESTRICT FK — agent_template_versions.template_id → agent_templates(id).
    { text: `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
        AND table_name = 'agent_template_versions'
        AND constraint_name = 'agent_template_versions_template_id_fkey'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_template_versions"
        ADD CONSTRAINT agent_template_versions_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id)
        ON DELETE RESTRICT NOT VALID;
    END IF;
  END $$;` },
    // Step 4d: RESTRICT FK — agent_registry_entries.template_id → agent_templates(id).
    { text: `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
        AND table_name = 'agent_registry_entries'
        AND constraint_name = 'agent_registry_entries_template_id_fkey'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_registry_entries"
        ADD CONSTRAINT agent_registry_entries_template_id_fkey
        FOREIGN KEY (template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id)
        ON DELETE RESTRICT NOT VALID;
    END IF;
  END $$;` },
    // Step 4e: RESTRICT FK — agent_forks.forked_template_id → agent_templates(id).
    { text: `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
        AND table_name = 'agent_forks'
        AND constraint_name = 'agent_forks_forked_template_id_fkey'
    ) THEN
      ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_forks"
        ADD CONSTRAINT agent_forks_forked_template_id_fkey
        FOREIGN KEY (forked_template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id)
        ON DELETE RESTRICT NOT VALID;
    END IF;
  END $$;` },
    // Step 5: VALIDATE CONSTRAINT for each FK — takes only SHARE UPDATE EXCLUSIVE
    // lock (does not block reads/writes). Idempotent: Postgres no-ops on already-valid
    // constraints.

    // Each VALIDATE block (a) pre-cleans any orphan rows whose
    // template_id no longer matches an agent_templates.id, then (b) attempts
    // VALIDATE. The pre-clean is defensive and idempotent — on a clean DB it
    // affects 0 rows. Without it, a single orphan from the pre-FK era would
    // raise unhandled foreign_key_violation (SQLSTATE 23503) at boot, which
    // the previous EXCEPTION clause (undefined_object | invalid_table_definition)
    // did NOT catch — crashing the migration and blocking app startup.

    // The EXCEPTION clause also now catches foreign_key_violation as a final
    // safety net in case orphans appear between the DELETE and the VALIDATE
    // (concurrent writes to the table during migration). On that path we
    // RAISE NOTICE so operators can investigate without a hard failure.
    { text: `DO $$ BEGIN
  DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_runs" r
  WHERE NOT EXISTS (
    SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" t
    WHERE t.id = r.template_id
  );
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_runs"
    VALIDATE CONSTRAINT agent_runs_template_id_fkey;
EXCEPTION
  WHEN undefined_object OR invalid_table_definition THEN NULL;
  WHEN foreign_key_violation THEN
    RAISE NOTICE 'agent_runs_template_id_fkey VALIDATE skipped due to orphan rows; investigate and re-run.';
END $$` },
    { text: `DO $$ BEGIN
  DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_versions" v
  WHERE NOT EXISTS (
    SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" t
    WHERE t.id = v.template_id
  );
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_versions"
    VALIDATE CONSTRAINT agent_versions_template_id_fkey;
EXCEPTION
  WHEN undefined_object OR invalid_table_definition THEN NULL;
  WHEN foreign_key_violation THEN
    RAISE NOTICE 'agent_versions_template_id_fkey VALIDATE skipped due to orphan rows; investigate and re-run.';
END $$` },
    { text: `DO $$ BEGIN
  DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_template_versions" tv
  WHERE NOT EXISTS (
    SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" t
    WHERE t.id = tv.template_id
  );
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_template_versions"
    VALIDATE CONSTRAINT agent_template_versions_template_id_fkey;
EXCEPTION
  WHEN undefined_object OR invalid_table_definition THEN NULL;
  WHEN foreign_key_violation THEN
    RAISE NOTICE 'agent_template_versions_template_id_fkey VALIDATE skipped due to orphan rows; investigate and re-run.';
END $$` },
    { text: `DO $$ BEGIN
  DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_registry_entries" e
  WHERE NOT EXISTS (
    SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" t
    WHERE t.id = e.template_id
  );
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_registry_entries"
    VALIDATE CONSTRAINT agent_registry_entries_template_id_fkey;
EXCEPTION
  WHEN undefined_object OR invalid_table_definition THEN NULL;
  WHEN foreign_key_violation THEN
    RAISE NOTICE 'agent_registry_entries_template_id_fkey VALIDATE skipped due to orphan rows; investigate and re-run.';
END $$` },
    { text: `DO $$ BEGIN
  DELETE FROM "${schemaName.replaceAll('"', '""')}"."agent_forks" f
  WHERE NOT EXISTS (
    SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."agent_templates" t
    WHERE t.id = f.forked_template_id
  );
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_forks"
    VALIDATE CONSTRAINT agent_forks_forked_template_id_fkey;
EXCEPTION
  WHEN undefined_object OR invalid_table_definition THEN NULL;
  WHEN foreign_key_violation THEN
    RAISE NOTICE 'agent_forks_forked_template_id_fkey VALIDATE skipped due to orphan rows; investigate and re-run.';
END $$` },
    // Step 6: Create extension_lifecycle_audit table + 2 indexes.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_lifecycle_audit" (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  actor_type text NOT NULL,
  org_id text,
  operation text NOT NULL,
  package_name text NOT NULL,
  package_version text,
  destroyed_row_snapshot jsonb,
  dangling_references jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
)` },
    { text: `CREATE INDEX IF NOT EXISTS extension_lifecycle_audit_package_name_idx
  ON "${schemaName.replaceAll('"', '""')}"."extension_lifecycle_audit" (package_name)` },
    { text: `CREATE INDEX IF NOT EXISTS extension_lifecycle_audit_created_at_idx
  ON "${schemaName.replaceAll('"', '""')}"."extension_lifecycle_audit" (created_at DESC)` },
    // ---------------------------------------------------------------------------
    // Canonical installed_extension manifest.
    // Single source of truth for "what's installed and from where". Replaces
    // the per-kind extension_lifecycle_status columns on agent_templates,
    // skill_packages, and workflow_template (those columns become zombie
    // data after backfill; readers/writers route through
    // the canonical manifest + transitionExtensionLifecycle primitive).
    // ---------------------------------------------------------------------------
    // Step 1: extend the lifecycle status enum with 'locked'.
    {
      text: `DO $$ BEGIN
  ALTER TYPE "${schemaName.replaceAll('"', '""')}"."extension_lifecycle_status" ADD VALUE 'locked';
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    },
    // Step 2: create the canonical installed_extension table.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."installed_extension" (
  id text PRIMARY KEY,
  package_name text NOT NULL,
  owner_level text NOT NULL,
  owner_id text NOT NULL,
  organization_id text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  source jsonb NOT NULL,
  required_in_prod boolean NOT NULL DEFAULT false,
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)` },
    // Identity is (organization_id, owner_level, owner_id, package_name).
    // organization_id may be NULL for platform-wide rows (sentinel '__platform__'
    // in owner_id). Postgres treats NULLs as distinct in unique constraints by
    // default — partial indexes handle both cases.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_org_idx
  ON "${schemaName.replaceAll('"', '""')}"."installed_extension"
    (organization_id, owner_level, owner_id, package_name)
  WHERE organization_id IS NOT NULL` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS installed_extension_identity_platform_idx
  ON "${schemaName.replaceAll('"', '""')}"."installed_extension"
    (owner_level, owner_id, package_name)
  WHERE organization_id IS NULL` },
    { text: `CREATE INDEX IF NOT EXISTS installed_extension_kind_status_idx
  ON "${schemaName.replaceAll('"', '""')}"."installed_extension" (kind, status)` },
    { text: `CREATE INDEX IF NOT EXISTS installed_extension_package_name_idx
  ON "${schemaName.replaceAll('"', '""')}"."installed_extension" (package_name)` },
    // CHECK constraints enforce the kind /
    // status / owner_level domains + the platform-sentinel invariant at the
    // DB layer (defense-in-depth alongside the TS validators). Wrapped in
    // DO/EXCEPTION so re-running setup is idempotent (ADD CONSTRAINT has no
    // IF NOT EXISTS in PG ≤17).
    { text: `DO $$ BEGIN
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."installed_extension"
    ADD CONSTRAINT installed_extension_kind_chk
    CHECK (kind IN ('agent','connector','artifact','skill','workflow'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    { text: `DO $$ BEGIN
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."installed_extension"
    ADD CONSTRAINT installed_extension_status_chk
    CHECK (status IN ('active','archived','locked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    { text: `DO $$ BEGIN
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."installed_extension"
    ADD CONSTRAINT installed_extension_owner_level_chk
    CHECK (owner_level IN ('user','team','organization','workspace','platform'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    // Platform invariant — sentinel `__platform__` is allowed only at
    // platform and workspace tiers (both with NULL organization_id). At
    // user / team / organization tier, owner_id must be a real id (not the
    // sentinel, not NULL). The workspace branch admits the documented
    // "system-shipped, every-user-visible install" pattern that
    // `registerExtensionSkill()` writes for every workspace-tier system
    // skill — workspace itself has no DB table, so the sentinel models the
    // implicit deployment-wide workspace owner.
    //
    // We DROP the constraint first (idempotent IF EXISTS) instead of
    // relying on `EXCEPTION WHEN duplicate_object` to swallow the re-add.
    // The swallow would preserve any older constraint definition forever
    // on a dev DB that already has one, even after a code update.
    // Dropping first guarantees source IS the truth on every boot.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."installed_extension"
  DROP CONSTRAINT IF EXISTS installed_extension_platform_invariant_chk` },
    { text: `DO $$ BEGIN
  ALTER TABLE "${schemaName.replaceAll('"', '""')}"."installed_extension"
    ADD CONSTRAINT installed_extension_platform_invariant_chk
    CHECK (
      (owner_level = 'platform'
         AND organization_id IS NULL
         AND owner_id = '__platform__')
      OR (owner_level = 'workspace'
         AND organization_id IS NULL
         AND owner_id = '__platform__')
      OR (owner_level IN ('user','team','organization')
         AND owner_id IS NOT NULL
         AND owner_id <> '__platform__')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$` },
    // ---------------------------------------------------------------------------
    // origin JSONB column on agent_templates + skill_packages,
    // extension_destinations credential store, and grandfather backfill.
    // All entries are idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
    // ---------------------------------------------------------------------------
    // Step 1: Add origin JSONB column to agent_templates.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates"
    ADD COLUMN IF NOT EXISTS origin jsonb` },
    // Step 2: Add origin JSONB column to skill_packages.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages"
    ADD COLUMN IF NOT EXISTS origin jsonb` },
    // Step 3: Create extension_destinations credential store table.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_destinations" (
    id text PRIMARY KEY,
    label text NOT NULL,
    registry_url text NOT NULL,
    token_ciphertext text NOT NULL,
    token_iv text NOT NULL,
    token_algo text NOT NULL DEFAULT 'aes-256-gcm',
    read_token_ciphertext text,
    read_token_iv text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )` },
    // Step 4: Grandfather backfill — existing agent_templates rows are public/cinatra.
    // Idempotent: only updates rows where origin IS NULL and package_name IS NOT NULL.
    // Guarded by column existence check: structured-column schemas have package_name;
    // payload-format schemas (worktree copies) do not and are skipped safely.
    { text: `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '${schemaName.replaceAll("'", "''")}' AND table_name = 'agent_templates' AND column_name = 'package_name'
  ) THEN
    UPDATE "${schemaName.replaceAll('"', '""')}"."agent_templates"
    SET origin = jsonb_build_object(
      'packageName', package_name,
      'version', COALESCE(package_version, '0.0.0'),
      'destinationId', NULL,
      'scope', '@cinatra-ai',
      'visibility', 'public',
      'registryUrl', 'https://registry.cinatra.ai'
    )
    WHERE package_name IS NOT NULL AND origin IS NULL;
  END IF;
END $$` },
    // Step 5: Grandfather backfill — existing skill_packages rows are public.
    // Idempotent: only updates rows where origin IS NULL and payload contains packageName.
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."skill_packages"
    SET origin = jsonb_build_object(
      'packageName', payload::jsonb->>'packageName',
      'version', COALESCE(payload::jsonb->>'version', '0.0.0'),
      'destinationId', NULL,
      'scope', '@cinatra-ai',
      'visibility', 'public',
      'registryUrl', 'https://registry.cinatra.ai'
    )
    WHERE origin IS NULL AND payload IS NOT NULL AND payload::jsonb->>'packageName' IS NOT NULL` },
    // agent_templates ownership tier (owner_level + owner_id).
    // Backfill makes existing rows organization-owned; new installs land via
    // installRegistryPackageAtScope with the picker's chosen scope.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS owner_level text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS owner_id text` },
    { text: `CREATE INDEX IF NOT EXISTS agent_templates_owner_idx ON "${schemaName.replaceAll('"', '""')}"."agent_templates" (owner_level, owner_id)` },
    // Single-pass backfill that covers BOTH org-backed and
    // orphan rows (org_id IS NULL). agent_templates.org_id is nullable (created
    // nullable from its initial schema; only agent_runs was tightened
    // but not templates), so a partial backfill that omits NULL-org rows
    // leaves owner_level=NULL forever, which downstream readers
    // (enforceResourceAccess, future scope filters) treat as an unhandled
    // state. The COALESCE assigns the empty string '' as a sentinel for
    // orphan rows: '' is not a valid org id (org ids are non-empty strings,
    // typically Better Auth nanoid), so it does not alias any real org. A
    // follow-up should either (a) tighten agent_templates.org_id to
    // NOT NULL after assigning a real org to orphans, or (b) introduce a
    // dedicated 'unassigned' sentinel and document its semantics. Until then
    // any reader that encounters owner_id='' MUST treat it the same as
    // legacy NULL-org rows (no implicit access).
    { text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_templates" SET owner_level = 'organization', owner_id = COALESCE(org_id, '') WHERE owner_level IS NULL` },
    // usage_events provider-routing telemetry.
    // requested_provider: what cinatra_llm.preferredProvider asked for (NULL when no preference).
    // effective_provider: the provider that actually dispatched.
    // Both nullable; legacy rows stay NULL (no backfill). Pattern mirrors the
    // skill_label additive migration above.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."usage_events" ADD COLUMN IF NOT EXISTS requested_provider text` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."usage_events" ADD COLUMN IF NOT EXISTS effective_provider text` },

    // -----------------------------------------------------------------
    // LLM-based skill matching tables
    // -----------------------------------------------------------------
    // 1. skill_matches: per-(agent, skill) evaluator state.
    //    source CHECK ('rule' | 'llm' | 'manual'); status CHECK ('ok' | 'error' | 'skipped');
    //    score numeric(4,3) NULL with CHECK constraint range [0.000,1.000] AND CHECK that NULL iff source='manual'.
    //    error_message capped 4 KiB at write time (enforced in app code, not DB).
    //    job_started_at drives the stale-write guard.
    {
      text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_matches" (
        agent_id text NOT NULL,
        skill_id text NOT NULL,
        source text NOT NULL CHECK (source IN ('rule', 'llm', 'manual')),
        matched boolean NOT NULL,
        score numeric(4,3),
        rationale text,
        evaluator_version text NOT NULL,
        agent_input_hash text NOT NULL,
        skill_input_hash text NOT NULL,
        status text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
        error_code text,
        error_message text,
        evaluated_at timestamptz NOT NULL,
        job_started_at timestamptz NOT NULL,
        PRIMARY KEY (agent_id, skill_id),
        -- Score scale 0.000-1.000; NULL ONLY for manual rows.
        CONSTRAINT skill_matches_score_range_chk
          CHECK (score IS NULL OR (score >= 0.000 AND score <= 1.000)),
        CONSTRAINT skill_matches_score_source_chk
          CHECK ((source = 'manual' AND score IS NULL)
              OR (source <> 'manual' AND score IS NOT NULL))
      )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS skill_matches_evaluated_at_idx ON "${schemaName.replaceAll('"', '""')}"."skill_matches" (evaluated_at)`,
    },

    // 2. skill_match_batch_runs: one row per OpenAI batch.
    {
      text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_match_batch_runs" (
        batch_id text PRIMARY KEY,
        submitted_by text NOT NULL,
        submitted_at timestamptz NOT NULL,
        pair_count integer NOT NULL,
        input_file_id text NOT NULL,
        output_file_id text,
        error_file_id text,
        status text NOT NULL,
        last_polled_at timestamptz,
        completed_at timestamptz,
        error_message text,
        evaluator_version text NOT NULL
      )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS skill_match_batch_runs_submitted_at_idx ON "${schemaName.replaceAll('"', '""')}"."skill_match_batch_runs" (submitted_at DESC)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS skill_match_batch_runs_status_idx ON "${schemaName.replaceAll('"', '""')}"."skill_match_batch_runs" (status) WHERE status IN ('validating', 'in_progress', 'finalizing')`,
    },

    // 3. skill_match_schedule: single-row cron config.
    //    Singleton row keyed id='default'. Boot hook reads + registers BullMQ
    //    scheduler "skill-match-batch-default" idempotently.

    //    Drift sampler columns extend the row with
    //    drift_sampler_enabled + drift_sampler_cron — the boot hook for the
    //    drift sampler reads these to decide whether to register the
    //    "skill-match-drift-sampler" BullMQ scheduler. Both default to off so
    //    no behavior change ships with the migration.
    {
      text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."skill_match_schedule" (
        id text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT false,
        cron_expression text,
        timezone text NOT NULL DEFAULT 'UTC',
        last_run_at timestamptz,
        last_run_status text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        drift_sampler_enabled boolean NOT NULL DEFAULT false,
        drift_sampler_cron text
      )`,
    },
    // Idempotent ALTER for deployments where the table already exists from
    // Adds the drift sampler columns with safe
    // defaults so existing rows continue to mean "drift sampler disabled".
    {
      text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_match_schedule"
        ADD COLUMN IF NOT EXISTS drift_sampler_enabled boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS drift_sampler_cron text`,
    },

    // ====================================================================
    // Skills storage restructure + production-grade relocation
    // ====================================================================

    // Adds the columns/tables/triggers required by the new ownership-first
    // layout (data/skills/<scope>/<id>/[~agents|~teams|~projects]/<vendor>/
    // <package>/<skill>/SKILL.md), the durable outbox-driven path-relocation
    // saga, and the SQL-conditional first-run gate for agent reassignment.

    // Key design
    // decisions:

    //   - All DDL is idempotent (IF NOT EXISTS / IF EXISTS / DO-block with
    //     EXCEPTION WHEN duplicate_object — `ensurePostgresSchema` replays
    //     this list on every boot).
    //   - Slug normalization in PL/pgSQL: trims hyphens, collapses runs,
    //     empty → 'item', caps at 60 chars (leaves -N suffix budget).
    //   - De-collision in PL/pgSQL: loops until each slug is unique within
    //     its scope (per-org for teams, per-(owner_level, owner_id) for
    //     projects).
    //   - `skill_pkg_vendor_required_chk` is NOT VALID so existing rows
    //     backfilled with source_kind='installed' but no vendor/package are
    //     grandfathered (Recreate Library wipes legacy rows anyway).
    //   - `path_relocations` outbox: no partial unique index — chained
    //     renames A→B→C produce two rows that the worker processes in order.
    //   - All trigger helper functions are defined BEFORE the trigger funcs
    //     that call them (Postgres requires this at compile time).

    // -------------------------------------------------------------------
    // Slug normalization helper
    // -------------------------------------------------------------------
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"._normalize_slug(input text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
        SELECT
          CASE
            WHEN trim(both '-' from regexp_replace(lower(coalesce(input,'')), '[^a-z0-9]+', '-', 'g')) = ''
              THEN 'item'
            ELSE substring(trim(both '-' from regexp_replace(lower(coalesce(input,'')), '[^a-z0-9]+', '-', 'g')) for 60)
          END
      $$`,
    },

    // -------------------------------------------------------------------
    // Owner-prefix helper (used by project + agent triggers)
    // -------------------------------------------------------------------
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".compute_owner_path_prefix(p_level text, p_id text) RETURNS text LANGUAGE plpgsql AS $body$
        DECLARE
          user_slug text;
          team_slug text;
          team_org_id text;
          org_slug text;
        BEGIN
          IF p_level = 'workspace' OR p_level IS NULL OR p_id IS NULL OR p_id = '' THEN
            RETURN 'workspace';
          ELSIF p_level IN ('user','personal') THEN
            SELECT username INTO user_slug FROM public."user" WHERE id = p_id;
            IF user_slug IS NULL THEN RETURN NULL; END IF;
            RETURN 'personal/' || user_slug;
          ELSIF p_level = 'organization' THEN
            SELECT slug INTO org_slug FROM public."organization" WHERE id = p_id;
            IF org_slug IS NULL THEN RETURN NULL; END IF;
            RETURN 'organization/' || org_slug;
          ELSIF p_level = 'team' THEN
            SELECT slug, "organizationId" INTO team_slug, team_org_id FROM public."team" WHERE id = p_id;
            IF team_slug IS NULL THEN RETURN NULL; END IF;
            SELECT slug INTO org_slug FROM public."organization" WHERE id = team_org_id;
            IF org_slug IS NULL THEN RETURN NULL; END IF;
            RETURN 'organization/' || org_slug || '/~teams/' || team_slug;
          END IF;
          RETURN NULL;
        END;
        $body$`,
    },

    // -------------------------------------------------------------------
    // Add nullable slug + identity columns
    // -------------------------------------------------------------------
    { text: `ALTER TABLE public."team" ADD COLUMN IF NOT EXISTS slug text` },
    {
      text: `UPDATE public."team" SET slug = "${schemaName.replaceAll('"', '""')}"._normalize_slug(name)
              WHERE slug IS NULL OR slug = ''`,
    },

    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."projects" ADD COLUMN IF NOT EXISTS slug text` },
    {
      text: `UPDATE "${schemaName.replaceAll('"', '""')}"."projects"
                SET slug = "${schemaName.replaceAll('"', '""')}"._normalize_slug(name)
              WHERE slug IS NULL OR slug = ''`,
    },

    {
      text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages"
        ADD COLUMN IF NOT EXISTS owner_scope text,
        ADD COLUMN IF NOT EXISTS owner_id text,
        ADD COLUMN IF NOT EXISTS binding_scope text,
        ADD COLUMN IF NOT EXISTS source_kind text,
        ADD COLUMN IF NOT EXISTS vendor text,
        ADD COLUMN IF NOT EXISTS package text,
        ADD COLUMN IF NOT EXISTS agent_template_id text,
        ADD COLUMN IF NOT EXISTS skill_slug text`,
    },
    // Backfill: legacy rows lack identity, but Recreate Library will wipe them.
    // Use 'user-authored' source_kind so the vendor-required CHECK doesn't
    // need backfilled vendor/package columns (NOT VALID also handles this).
    {
      text: `UPDATE "${schemaName.replaceAll('"', '""')}"."skill_packages" SET
        owner_scope   = COALESCE(owner_scope, 'workspace'),
        binding_scope = COALESCE(binding_scope, 'owner'),
        source_kind   = COALESCE(source_kind, 'user-authored'),
        skill_slug    = COALESCE(skill_slug, id)`,
    },

    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."agent_templates" ADD COLUMN IF NOT EXISTS first_run_at timestamptz` },
    {
      text: `UPDATE "${schemaName.replaceAll('"', '""')}"."agent_templates" t SET first_run_at = sub.min_created
              FROM (SELECT template_id, MIN(created_at) AS min_created
                      FROM "${schemaName.replaceAll('"', '""')}"."agent_runs"
                     GROUP BY template_id) sub
             WHERE t.id = sub.template_id AND t.first_run_at IS NULL`,
    },

    // -------------------------------------------------------------------
    // Pure-SQL de-collision (per-scope)
    // -------------------------------------------------------------------
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"._decollide_team_slugs() RETURNS void LANGUAGE plpgsql AS $body$
        DECLARE
          r RECORD;
          candidate text;
          n int;
        BEGIN
          FOR r IN
            SELECT t.id, t.slug, t."organizationId"
              FROM public."team" t
              JOIN (
                SELECT slug, "organizationId" FROM public."team"
                 WHERE slug IS NOT NULL
                 GROUP BY slug, "organizationId" HAVING count(*) > 1
              ) dupes ON dupes.slug = t.slug AND dupes."organizationId" IS NOT DISTINCT FROM t."organizationId"
             ORDER BY t.id
          LOOP
            candidate := r.slug;
            n := 2;
            WHILE EXISTS (
              SELECT 1 FROM public."team"
               WHERE "organizationId" IS NOT DISTINCT FROM r."organizationId"
                 AND slug = candidate
                 AND id <> r.id
            ) LOOP
              candidate := substring(r.slug for 60 - length('-' || n)) || '-' || n;
              n := n + 1;
            END LOOP;
            IF candidate <> r.slug THEN
              UPDATE public."team" SET slug = candidate WHERE id = r.id;
            END IF;
          END LOOP;
        END;
        $body$`,
    },
    { text: `SELECT "${schemaName.replaceAll('"', '""')}"._decollide_team_slugs()` },

    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}"._decollide_project_slugs() RETURNS void LANGUAGE plpgsql AS $body$
        DECLARE
          r RECORD;
          candidate text;
          n int;
          schema_name text := '${schemaName.replaceAll("'", "''")}';
        BEGIN
          FOR r IN EXECUTE format(
            'SELECT p.id, p.slug, p.owner_level, p.owner_id
               FROM %I.projects p
               JOIN (
                 SELECT slug, owner_level, owner_id FROM %I.projects
                  WHERE slug IS NOT NULL
                  GROUP BY slug, owner_level, owner_id HAVING count(*) > 1
               ) dupes ON dupes.slug = p.slug AND dupes.owner_level = p.owner_level AND dupes.owner_id = p.owner_id
              ORDER BY p.id',
            schema_name, schema_name)
          LOOP
            candidate := r.slug;
            n := 2;
            WHILE EXISTS (
              SELECT 1 FROM "${schemaName.replaceAll('"', '""')}"."projects"
               WHERE owner_level = r.owner_level
                 AND owner_id = r.owner_id
                 AND slug = candidate
                 AND id <> r.id
            ) LOOP
              candidate := substring(r.slug for 60 - length('-' || n)) || '-' || n;
              n := n + 1;
            END LOOP;
            IF candidate <> r.slug THEN
              UPDATE "${schemaName.replaceAll('"', '""')}"."projects" SET slug = candidate WHERE id = r.id;
            END IF;
          END LOOP;
        END;
        $body$`,
    },
    { text: `SELECT "${schemaName.replaceAll('"', '""')}"._decollide_project_slugs()` },

    // -------------------------------------------------------------------
    // NOT NULL + CHECK + UNIQUE constraints
    // -------------------------------------------------------------------
    { text: `ALTER TABLE public."team" ALTER COLUMN slug SET NOT NULL` },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE public."team" ADD CONSTRAINT team_slug_format
          CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' AND slug NOT LIKE '~%');
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS team_slug_uniq_in_org ON public."team" ("organizationId", slug)` },

    // -------------------------------------------------------------------
    // public."member" single-membership invariant
    // -------------------------------------------------------------------
    // member (organizationId, userId) had only btree indexes, no UNIQUE —
    // two concurrent ensureInitialAdminBootstrap + ensureDefaultOrganization-
    // Membership callers on a fresh DB could both INSERT, leaving duplicate
    // rows. Step 1: one-shot dedup, gated on the index not yet existing so
    // it runs at most once per deployment (once the index exists, duplicates
    // are impossible). The window CTE keeps the highest-role row per pair,
    // breaking ties by oldest createdAt (NULLS LAST) then lowest id —
    // mirrored in JS by pickSurvivingMemberRow() for unit testing.
    //
    // role_rank is the MAX rank across comma-split role tokens: Better Auth
    // stores multi-role membership as comma-joined text (parseRoles() →
    // 'owner,admin') and its permission checks split member.role on commas,
    // so 'owner,admin' is an owner-CAPABLE row and must outrank a plain
    // 'member' row. Ranking the raw string would score 'owner,admin' as 0
    // (unknown) and delete the owner-capable row — a deploy-time privilege
    // downgrade + data loss. owner=3, admin=2, member=1, unknown/NULL=0.
    //
    // RAISE WARNING makes the deleted count auditable in operator logs (the
    // post-deploy verification step reads it); it does NOT fail loud on
    // count > 0 — the deploy SHOULD repair this exact bad state. Step 2
    // creates the index. The dedup and
    // CREATE INDEX are separate statements; the only residual race is an old
    // writer inserting a duplicate between them during a rolling deploy —
    // accepted (the auth-session.ts ordering guard keeps the expected dedup
    // count at 0).
    {
      text: `DO $body$
        DECLARE deleted_count integer;
        BEGIN
          IF to_regclass('public.member_org_user_uniq') IS NULL THEN
            WITH scored AS (
              SELECT id, "organizationId", "userId", "createdAt",
                COALESCE((
                  SELECT MAX(CASE trim(tok)
                    WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'member' THEN 1 ELSE 0 END)
                  FROM unnest(string_to_array(role, ',')) AS tok
                ), 0) AS role_rank
              FROM public."member"
            ),
            ranked AS (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY "organizationId", "userId"
                ORDER BY role_rank DESC, "createdAt" ASC NULLS LAST, id ASC
              ) AS rn
              FROM scored
            ),
            deleted AS (
              DELETE FROM public."member" WHERE id IN (SELECT id FROM ranked WHERE rn > 1) RETURNING id
            )
            SELECT COUNT(*) INTO deleted_count FROM deleted;
            RAISE WARNING 'member dedup: deleted % duplicate member rows', deleted_count;
          END IF;
        END $body$`,
    },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uniq ON public."member" ("organizationId", "userId")` },

    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."projects" ALTER COLUMN slug SET NOT NULL` },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."projects" ADD CONSTRAINT projects_slug_format
          CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' AND slug NOT LIKE '~%');
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_uniq ON "${schemaName.replaceAll('"', '""')}"."projects" (owner_level, owner_id, slug)` },

    // NOT NULL was temporarily relaxed. The four identity columns above were
    // declared NOT NULL before every legacy writer
    // was rewired to populate them. UPSERTs through replaceSkillCatalogInDatabase
    // → buildUpsertJsonRowQuery on skill_packages only set {id, payload}; any
    // INSERT branch (e.g. the MCP extensions_uninstall flow rebuilding the
    // catalog) aborts on the NOT NULL constraint. Until every writer threads
    // every writer to thread SkillWriteContext, these columns must allow NULL
    // on legacy-shaped INSERTs. The CHECK constraints below are NOT VALID so
    // they only apply to new rows. New writers (the resolver) still populate
    // identity correctly; the backfill populates historical rows.
    // The DROP NOT NULL hotfix is restored to SET NOT NULL.
    // buildUpsertSkillPackageQuery populates
    // identity columns on every UPSERT, so no new INSERT can land with
    // NULL identity. Historical rows are backfilled before
    // applying SET NOT NULL we run a guard query: if ANY row still has
    // NULL identity, we leave the column nullable + log a manual-repair
    // warning (operator must backfill before the next deploy).

    // The guard runs in a single PL/pgSQL DO block so we can branch on
    // the row count without exposing a side-effect to runPostgresQueriesSync.
    {
      text: `DO $body$
        DECLARE
          null_count int;
        BEGIN
          SELECT COUNT(*) INTO null_count FROM "${schemaName.replaceAll('"', '""')}"."skill_packages"
           WHERE owner_scope IS NULL OR binding_scope IS NULL OR source_kind IS NULL OR skill_slug IS NULL;
          IF null_count = 0 THEN
            ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ALTER COLUMN owner_scope SET NOT NULL;
            ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ALTER COLUMN binding_scope SET NOT NULL;
            ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ALTER COLUMN source_kind SET NOT NULL;
            ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ALTER COLUMN skill_slug SET NOT NULL;
            RAISE NOTICE 'NOT NULL restored on skill_packages identity columns';
          ELSE
            RAISE NOTICE '% rows still have NULL identity; NOT NULL restoration deferred until backfill completes', null_count;
          END IF;
        END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_agent_template_fk
          FOREIGN KEY (agent_template_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."agent_templates"(id) ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_owner_scope_chk
          CHECK (owner_scope IN ('personal','team','organization','workspace','project'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_binding_scope_chk
          CHECK (binding_scope IN ('owner','agent'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_source_kind_chk
          CHECK (source_kind IN ('installed','bundled','user-authored'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_workspace_null_chk
          CHECK ((owner_scope = 'workspace') = (owner_id IS NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_agent_bound_iff_template_chk
          CHECK ((binding_scope = 'agent') = (agent_template_id IS NOT NULL));
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    // NOT VALID — applies to new/updated rows only; legacy backfilled rows
    // (source_kind='user-authored' with no vendor/package) are grandfathered.
    // DROP-then-ADD pattern changed the
    // definition from strict bidirectional-equality to one-way implication.
    // Without the DROP step, any DB that already booted with the strict
    // version keeps the strict definition forever (the ADD silently hits
    // EXCEPTION WHEN duplicate_object). DROP IF EXISTS is idempotent —
    // safe on fresh boots, replaces the constraint on upgraded boots.
    {
      text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" DROP CONSTRAINT IF EXISTS skill_pkg_vendor_required_chk`,
    },
    {
      text: `DO $body$ BEGIN
        ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_packages" ADD CONSTRAINT skill_pkg_vendor_required_chk
          -- Installed/bundled rows MUST have vendor+package; user-authored MAY
          -- have them (custom skill against an installed agent).
          CHECK (source_kind = 'user-authored'
                 OR (vendor IS NOT NULL AND package IS NOT NULL))
          NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL; END $body$`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS skill_pkg_identity_uniq ON "${schemaName.replaceAll('"', '""')}"."skill_packages"
        (owner_scope, COALESCE(owner_id,'_'), binding_scope, COALESCE(agent_template_id,'_'),
         COALESCE(vendor,'_'), COALESCE(package,'_'), skill_slug)`,
    },

    // -------------------------------------------------------------------
    // agent_templates first_run_at trigger
    // -------------------------------------------------------------------
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".set_agent_template_first_run() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          UPDATE "${schemaName.replaceAll('"', '""')}"."agent_templates"
             SET first_run_at = NEW.created_at
           WHERE id = NEW.template_id AND first_run_at IS NULL;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS agent_templates_first_run_trg ON "${schemaName.replaceAll('"', '""')}"."agent_runs"` },
    {
      text: `CREATE TRIGGER agent_templates_first_run_trg AFTER INSERT ON "${schemaName.replaceAll('"', '""')}"."agent_runs"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".set_agent_template_first_run()`,
    },

    // -------------------------------------------------------------------
    // path_relocations outbox
    // -------------------------------------------------------------------
    {
      text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."path_relocations" (
        id              text PRIMARY KEY,
        subject_kind    text NOT NULL CHECK (subject_kind IN ('user','team','organization','project','agent_template')),
        subject_id      text NOT NULL,
        old_slug        text NOT NULL,
        new_slug        text NOT NULL,
        old_path        text NOT NULL,
        new_path        text NOT NULL,
        status          text NOT NULL CHECK (status IN ('pending','in_progress','completed','failed')),
        marker_path     text,
        attempts        int NOT NULL DEFAULT 0,
        last_error      text,
        enqueued_at     timestamptz NOT NULL DEFAULT now(),
        started_at      timestamptz,
        completed_at    timestamptz
      )`,
    },
    { text: `CREATE INDEX IF NOT EXISTS path_reloc_pending_idx ON "${schemaName.replaceAll('"', '""')}"."path_relocations" (status, enqueued_at) WHERE status = 'pending'` },
    { text: `CREATE INDEX IF NOT EXISTS path_reloc_subject_idx ON "${schemaName.replaceAll('"', '""')}"."path_relocations" (subject_kind, subject_id, enqueued_at)` },

    // -------------------------------------------------------------------
    // Slug-capture triggers
    //   All five capture OLD slug/owner state at UPDATE time and write the
    //   authoritative old_path + new_path columns to path_relocations.
    //   Worker reads those columns verbatim — no re-resolution from current
    //   DB state. PG_NOTIFY wakes the worker via LISTEN/NOTIFY.
    // -------------------------------------------------------------------

    // 2.1 user.username → personal/<username>
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_user_slug_move() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE
          new_id text;
          old_p text;
          new_p text;
        BEGIN
          IF OLD.username IS DISTINCT FROM NEW.username AND OLD.username IS NOT NULL AND OLD.username <> ''
             AND NEW.username IS NOT NULL AND NEW.username <> '' THEN
            new_id := 'reloc_' || gen_random_uuid()::text;
            old_p := 'personal/' || OLD.username;
            new_p := 'personal/' || NEW.username;
            INSERT INTO "${schemaName.replaceAll('"', '""')}"."path_relocations"
              (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
            VALUES (new_id, 'user', NEW.id, OLD.username, NEW.username, old_p, new_p, 'pending');
            PERFORM pg_notify('cinatra_path_relocations_pending', new_id);
          END IF;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS user_slug_move_trg ON public."user"` },
    {
      text: `CREATE TRIGGER user_slug_move_trg AFTER UPDATE OF username ON public."user"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_user_slug_move()`,
    },

    // 2.2 team.slug → organization/<org-slug>/~teams/<team-slug>
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_team_slug_move() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE
          new_id text;
          org_slug text;
          old_p text;
          new_p text;
        BEGIN
          IF OLD.slug IS DISTINCT FROM NEW.slug AND OLD.slug IS NOT NULL AND OLD.slug <> '' AND NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
            SELECT slug INTO org_slug FROM public."organization" WHERE id = NEW."organizationId";
            IF org_slug IS NULL THEN
              RAISE EXCEPTION 'enqueue_team_slug_move: organization % has no slug', NEW."organizationId";
            END IF;
            new_id := 'reloc_' || gen_random_uuid()::text;
            old_p := 'organization/' || org_slug || '/~teams/' || OLD.slug;
            new_p := 'organization/' || org_slug || '/~teams/' || NEW.slug;
            INSERT INTO "${schemaName.replaceAll('"', '""')}"."path_relocations"
              (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
            VALUES (new_id, 'team', NEW.id, OLD.slug, NEW.slug, old_p, new_p, 'pending');
            PERFORM pg_notify('cinatra_path_relocations_pending', new_id);
          END IF;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS team_slug_move_trg ON public."team"` },
    {
      text: `CREATE TRIGGER team_slug_move_trg AFTER UPDATE OF slug ON public."team"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_team_slug_move()`,
    },

    // 2.3 organization.slug → organization/<slug>
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_org_slug_move() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE
          new_id text;
          old_p text;
          new_p text;
        BEGIN
          IF OLD.slug IS DISTINCT FROM NEW.slug AND OLD.slug IS NOT NULL AND OLD.slug <> '' AND NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
            new_id := 'reloc_' || gen_random_uuid()::text;
            old_p := 'organization/' || OLD.slug;
            new_p := 'organization/' || NEW.slug;
            INSERT INTO "${schemaName.replaceAll('"', '""')}"."path_relocations"
              (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
            VALUES (new_id, 'organization', NEW.id, OLD.slug, NEW.slug, old_p, new_p, 'pending');
            PERFORM pg_notify('cinatra_path_relocations_pending', new_id);
          END IF;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS org_slug_move_trg ON public."organization"` },
    {
      text: `CREATE TRIGGER org_slug_move_trg AFTER UPDATE OF slug ON public."organization"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_org_slug_move()`,
    },

    // 2.4 project.slug → <owner-prefix>/~projects/<slug>
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_project_slug_move() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE
          new_id text;
          prefix text;
          old_p text;
          new_p text;
        BEGIN
          IF OLD.slug IS DISTINCT FROM NEW.slug AND OLD.slug IS NOT NULL AND OLD.slug <> '' AND NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
            prefix := "${schemaName.replaceAll('"', '""')}".compute_owner_path_prefix(NEW.owner_level, NEW.owner_id);
            IF prefix IS NULL THEN
              RAISE EXCEPTION 'enqueue_project_slug_move: cannot resolve owner path for project %', NEW.id;
            END IF;
            new_id := 'reloc_' || gen_random_uuid()::text;
            old_p := prefix || '/~projects/' || OLD.slug;
            new_p := prefix || '/~projects/' || NEW.slug;
            INSERT INTO "${schemaName.replaceAll('"', '""')}"."path_relocations"
              (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
            VALUES (new_id, 'project', NEW.id, OLD.slug, NEW.slug, old_p, new_p, 'pending');
            PERFORM pg_notify('cinatra_path_relocations_pending', new_id);
          END IF;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS project_slug_move_trg ON "${schemaName.replaceAll('"', '""')}"."projects"` },
    {
      text: `CREATE TRIGGER project_slug_move_trg AFTER UPDATE OF slug ON "${schemaName.replaceAll('"', '""')}"."projects"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_project_slug_move()`,
    },

    // 2.5 agent_templates.(owner_level, owner_id) →
    //     <owner-prefix>/~agents/<package_name>

    // Authoritative full path is written at enqueue time:
    // includes vendor/package via agent_templates.package_name (which holds
    // the full vendor-namespaced name, e.g. "cinatra/email-test-delivery-agent").
    // The worker physically moves the entire ~agents/<package_name>/ subtree
    // (containing all bundled + user-authored skills).
    {
      text: `CREATE OR REPLACE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_agent_owner_move() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE
          new_id text;
          old_prefix text;
          new_prefix text;
          old_p text;
          new_p text;
        BEGIN
          IF (OLD.owner_level, OLD.owner_id) IS DISTINCT FROM (NEW.owner_level, NEW.owner_id) THEN
            old_prefix := "${schemaName.replaceAll('"', '""')}".compute_owner_path_prefix(OLD.owner_level, OLD.owner_id);
            new_prefix := "${schemaName.replaceAll('"', '""')}".compute_owner_path_prefix(NEW.owner_level, NEW.owner_id);
            IF old_prefix IS NULL OR new_prefix IS NULL THEN
              RAISE EXCEPTION 'enqueue_agent_owner_move: cannot resolve owner paths for template %', NEW.id;
            END IF;
            IF NEW.package_name IS NULL OR NEW.package_name = '' THEN
              RAISE EXCEPTION 'enqueue_agent_owner_move: template % has no package_name', NEW.id;
            END IF;
            new_id := 'reloc_' || gen_random_uuid()::text;
            old_p := old_prefix || '/~agents/' || NEW.package_name;
            new_p := new_prefix || '/~agents/' || NEW.package_name;
            INSERT INTO "${schemaName.replaceAll('"', '""')}"."path_relocations"
              (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
            VALUES (new_id, 'agent_template', NEW.id,
                    COALESCE(OLD.owner_level,'') || ':' || COALESCE(OLD.owner_id,''),
                    COALESCE(NEW.owner_level,'') || ':' || COALESCE(NEW.owner_id,''),
                    old_p, new_p, 'pending');
            PERFORM pg_notify('cinatra_path_relocations_pending', new_id);
          END IF;
          RETURN NEW;
        END;
        $body$`,
    },
    { text: `DROP TRIGGER IF EXISTS agent_owner_move_trg ON "${schemaName.replaceAll('"', '""')}"."agent_templates"` },
    {
      text: `CREATE TRIGGER agent_owner_move_trg AFTER UPDATE OF owner_level, owner_id ON "${schemaName.replaceAll('"', '""')}"."agent_templates"
        FOR EACH ROW EXECUTE FUNCTION "${schemaName.replaceAll('"', '""')}".enqueue_agent_owner_move()`,
    },
    // ====================================================================
    // End skills storage restructure
    // ====================================================================

    // ====================================================================
    // Anthropic skill sync state.

    // The catalog→Anthropic mirror's local state. PRIMARY KEY is the
    // collision-safe 3-tuple (api_key_fingerprint, environment,
    // catalog_skill_id): a single Anthropic API key is shared across
    // worktree/clone/staging/prod, so keying by catalog id alone is unsafe
    // (spec §4.2). `environment` is a deterministic per-deployment composite
    // (schema + DB-identity hash + optional CINATRA_DEPLOYMENT_ENV) derived by
    // src/lib/anthropic-skill-sync-service.ts. `stale` is a local boolean
    // There is NO remote deletion in the mark-stale path.
    // ====================================================================
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."anthropic_skill_sync" (
      api_key_fingerprint text NOT NULL,
      environment text NOT NULL,
      catalog_skill_id text NOT NULL,
      anthropic_skill_id text NOT NULL,
      anthropic_version text NOT NULL,
      content_hash text NOT NULL,
      stale boolean NOT NULL DEFAULT false,
      synced_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (api_key_fingerprint, environment, catalog_skill_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS anthropic_skill_sync_skill_idx ON "${schemaName.replaceAll('"', '""')}"."anthropic_skill_sync" (anthropic_skill_id)` },
    // ====================================================================
    // `stale_at` is the GC stale-age GRACE anchor.
    // Stamped (false->true only, never reset) by mark-stale
    // DAO ops. The leased/refcounted GC engine refuses to reclaim a row
    // until `stale_at <= now() - GRACE` (≫ max run + lease TTL + skew), so a
    // dropped best-effort lease only DELAYS reclamation, never over-deletes.
    // ADD COLUMN IF NOT EXISTS so an already-provisioned namespace upgrades.
    // ====================================================================
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."anthropic_skill_sync" ADD COLUMN IF NOT EXISTS stale_at timestamptz` },
    // ====================================================================
    // Short-lived in-flight reference leases. Many
    // concurrent runs ⇒ many lease rows per (skill, version); the random
    // `lease_id` disambiguates them. `expires_at` self-reaps a crashed run's
    // lease. GC refuses any anthropic_skill_id with a non-expired lease on
    // ANY of its versions. Namespace-scoped exactly like anthropic_skill_sync.
    // ====================================================================
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."anthropic_skill_lease" (
      api_key_fingerprint text NOT NULL,
      environment text NOT NULL,
      catalog_skill_id text NOT NULL,
      anthropic_skill_id text NOT NULL,
      anthropic_version text NOT NULL,
      lease_id text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (api_key_fingerprint, environment, catalog_skill_id, anthropic_version, lease_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS anthropic_skill_lease_skill_idx ON "${schemaName.replaceAll('"', '""')}"."anthropic_skill_lease" (api_key_fingerprint, environment, anthropic_skill_id)` },
    { text: `CREATE INDEX IF NOT EXISTS anthropic_skill_lease_expires_idx ON "${schemaName.replaceAll('"', '""')}"."anthropic_skill_lease" (expires_at)` },

    // -----------------------------------------------------------------------
    // Release workflows (@cinatra-ai/workflows). Emitted base →
    // FK-dependent and fresh-schema-safe: workflow_template and
    // workflow first (no FK to other workflow tables; workflow snapshots the template
    // by id+version without a hard FK), then everything that references
    // workflow / workflow_task. Mirrors packages/workflows/src/schema.ts
    // (both must agree). task_id FK is RESTRICT on the evidence tables (attempt/
    // artifact/approval) so a task with run/approval/artifact evidence cannot be
    // deleted; CASCADE on the structural tables (dependency/gate).
    // -----------------------------------------------------------------------
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_template" (
      id text PRIMARY KEY,
      key text NOT NULL,
      version integer NOT NULL,
      name text NOT NULL,
      description text,
      definition jsonb NOT NULL,
      owner_level text,
      owner_id text,
      org_id text NOT NULL,
      project_id text,
      origin jsonb,
      visibility text,
      package_name text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_template_org_key_version_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_template" (org_id, key, version)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_template_org_id_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_template" (org_id)` },
    // Idempotent migration for pre-existing schemas: the reader facet keys
    // lifecycle-live visibility off package_name.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_template" ADD COLUMN IF NOT EXISTS package_name text` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_template_package_name_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_template" (package_name)` },
    // workflow_template.extension_lifecycle_status DROP is
    // owned by the one-shot migration script (correct backfill→drop ordering),
    // NOT this DDL. The CREATE TABLE above no longer creates the column.

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow" (
      id text PRIMARY KEY,
      source_template_id text,
      source_template_version integer,
      name text NOT NULL,
      product text,
      target_at_utc timestamptz,
      target_tz text,
      status text NOT NULL DEFAULT 'draft',
      owner_level text,
      owner_id text,
      org_id text NOT NULL,
      project_id text,
      created_by text,
      spec_version integer NOT NULL DEFAULT 1,
      lock_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_org_id_status_idx ON "${schemaName.replaceAll('"', '""')}"."workflow" (org_id, status)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_source_template_idx ON "${schemaName.replaceAll('"', '""')}"."workflow" (source_template_id, source_template_version)` },
    // Project-scope filter (workflow_status_list +projectId,
    // workflow-launcher tagging). Partial: only project-scoped workflows.
    { text: `CREATE INDEX IF NOT EXISTS workflow_project_id_idx ON "${schemaName.replaceAll('"', '""')}"."workflow" (project_id) WHERE project_id IS NOT NULL` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_task" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      key text NOT NULL,
      type text NOT NULL,
      title text NOT NULL,
      parent_task_id text REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE SET NULL,
      assignee_level text,
      assignee_id text,
      agent_package text,
      agent_ref jsonb,
      input jsonb,
      schedule jsonb,
      anchor jsonb,
      planned_start_utc timestamptz,
      planned_end_utc timestamptz,
      actual_start_utc timestamptz,
      actual_end_utc timestamptz,
      due_at_utc timestamptz,
      status text NOT NULL DEFAULT 'idle',
      required boolean NOT NULL DEFAULT true,
      failure_policy text,
      missed_window_policy text,
      retry_policy jsonb,
      max_attempts integer,
      cancel_policy jsonb,
      run_id text,
      pinned boolean NOT NULL DEFAULT false,
      risk text,
      foreach_config jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      lock_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_task_workflow_id_key_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_task" (workflow_id, key)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_task_workflow_id_status_due_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_task" (workflow_id, status, due_at_utc)` },
    // Self-referencing hierarchy link. Idempotent migration for
    // already-bootstrapped schemas: the column above only lands on a FRESH
    // CREATE TABLE, so add it + its FK + index here for existing DBs.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_task" ADD COLUMN IF NOT EXISTS parent_task_id text` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'workflow_task'
            AND constraint_name = 'workflow_task_parent_task_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_task"
            ADD CONSTRAINT workflow_task_parent_task_id_fkey
            FOREIGN KEY (parent_task_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE SET NULL;
        END IF;
      END $$;` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_task_workflow_id_parent_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_task" (workflow_id, parent_task_id)` },
    // Idempotent ALTERs for existing schemas. foreach_config
    // is nullable (only foreach parent rows carry it; children are NULL, see
    // the foreach materializer). metadata defaults to '{}' so existing rows backfill correctly.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_task" ADD COLUMN IF NOT EXISTS foreach_config jsonb` },
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_task" ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_dependency" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE CASCADE,
      depends_on_task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE CASCADE,
      outcome text NOT NULL DEFAULT 'success'
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_dependency_edge_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_dependency" (task_id, depends_on_task_id)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_dependency_depends_on_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_dependency" (depends_on_task_id)` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_gate" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE CASCADE,
      gate_kind text NOT NULL,
      state text NOT NULL,
      reason text,
      details jsonb,
      blocker_refs jsonb,
      evaluated_at timestamptz
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_gate_task_id_kind_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_gate" (task_id, gate_kind)` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_event" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text,
      task_key text,
      kind text NOT NULL,
      payload jsonb,
      actor_id text,
      actor_level text,
      source text,
      correlation_id text,
      idempotency_key text,
      spec_version integer,
      lock_version integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_event_workflow_id_created_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_event" (workflow_id, created_at)` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE RESTRICT,
      attempt_no integer NOT NULL,
      idempotency_key text NOT NULL,
      status text NOT NULL,
      child_run_id text,
      error jsonb,
      output jsonb,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_task_attempt_idempotency_key_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt" (idempotency_key)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_task_attempt_task_attempt_no_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt" (workflow_id, task_id, attempt_no)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_task_attempt_child_run_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt" (child_run_id)` },
    // Captured agent-run output for foreach materializer source.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt" ADD COLUMN IF NOT EXISTS output jsonb` },

    // workflow_dispatch_lease — durable dispatch lease (one live lease per
    // task; acquired in the claim tx, heartbeat-extended in flight, released
    // with the outcome). Transient operational state, NOT evidence — every FK
    // CASCADEs. Mirrors packages/workflows/src/schema.ts (workflowDispatchLease).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_dispatch_lease" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE CASCADE,
      attempt_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task_attempt"(id) ON DELETE CASCADE,
      holder_id text NOT NULL,
      token text NOT NULL,
      acquired_at timestamptz NOT NULL,
      heartbeat_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_dispatch_lease_task_id_uniq ON "${schemaName.replaceAll('"', '""')}"."workflow_dispatch_lease" (task_id)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_dispatch_lease_workflow_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_dispatch_lease" (workflow_id)` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_artifact" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE RESTRICT,
      kind text NOT NULL,
      ref text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      pinned boolean NOT NULL DEFAULT true,
      authoring_step_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_artifact_workflow_task_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_artifact" (workflow_id, task_id)` },
    // Idempotent additions for already-bootstrapped schemas.
    { text: `ALTER TABLE "${schemaName.replaceAll('"', '""')}"."workflow_artifact" ADD COLUMN IF NOT EXISTS authoring_step_id text` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_artifact_authoring_step_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_artifact" (authoring_step_id)` },
    // Partial unique index scopes (workflow_id, task_id, ref) uniqueness to
    // new ledger-linked rows only. Legacy rows (kind:"agent_run" /
    // kind:"agent_output") predate this column with authoring_step_id IS NULL
    // and may have non-unique ref shapes; the partial filter excludes them.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifact_wf_task_ref_uniq_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_artifact" (workflow_id, task_id, ref) WHERE authoring_step_id IS NOT NULL` },

    // authoring_step_artifacts — linkage from a committed ledger step to every
    // artifact representation it emitted. FK ON DELETE CASCADE so a ledger
    // rollback also unlinks. No FK on artifact_id: object lifecycle is owned
    // by the objects/artifacts subsystem.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."authoring_step_artifacts" (
      authoring_step_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."authoring_invocation_ledger"(authoring_step_id) ON DELETE CASCADE,
      org_id text NOT NULL,
      artifact_id text NOT NULL,
      representation_revision_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (authoring_step_id, artifact_id, representation_revision_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS asa_org_step_idx ON "${schemaName.replaceAll('"', '""')}"."authoring_step_artifacts" (org_id, authoring_step_id)` },

    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."workflow_approval" (
      id text PRIMARY KEY,
      workflow_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow"(id) ON DELETE CASCADE,
      task_id text NOT NULL REFERENCES "${schemaName.replaceAll('"', '""')}"."workflow_task"(id) ON DELETE RESTRICT,
      required_scope jsonb NOT NULL,
      resolved_approver_ids jsonb,
      solicitation_schedule jsonb,
      deadline_utc timestamptz,
      review_packet_hash text,
      status text NOT NULL DEFAULT 'pending',
      rejection_policy text,
      invalidated_at timestamptz,
      notification_state jsonb,
      decided_by text,
      decided_at timestamptz,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_approval_status_deadline_idx ON "${schemaName.replaceAll('"', '""')}"."workflow_approval" (status, deadline_utc)` },
    { text: `CREATE INDEX IF NOT EXISTS workflow_approval_resolved_approvers_gin ON "${schemaName.replaceAll('"', '""')}"."workflow_approval" USING gin (resolved_approver_ids)` },
    // Agent-Creation Approval Workflow — agent_creation_request.
    // The pending/proposal store for the non-admin authoring path. Pending
    // state lives ONLY on this row; agent_templates is created/updated only
    // when an admin approve dispatches the existing gated publish. Mirrors
    // the workflow_approval pattern (CAS via snapshot_hash, decided_by/at,
    // resolved_approver_ids, notification_state) but uses its OWN table — the
    // workflow_approval row is FK-bound to workflow/workflow_task and not
    // reusable as-is. State machine: draft → proposed → approved → published,
    // plus rejected → (author edits) → proposed (REOPENABLE).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."agent_creation_request" (
      id                     text PRIMARY KEY,
      org_id                 text NOT NULL,
      author_id              text NOT NULL,
      package_slug           text NOT NULL,
      package_name           text NOT NULL,
      package_version        text NOT NULL,
      status                 text NOT NULL,
      proposal_snapshot      jsonb NOT NULL,
      review_report          jsonb,
      snapshot_hash          text NOT NULL,
      required_scope         jsonb,
      resolved_approver_ids  jsonb,
      decided_by             text,
      decided_at             timestamptz,
      rejection_reason       text,
      publish_result         jsonb,
      notification_state     jsonb,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT acr_status_chk CHECK (status IN ('draft','proposed','approved','rejected','published'))
    )` },
    { text: `CREATE INDEX IF NOT EXISTS agent_creation_request_org_status_idx ON "${schemaName.replaceAll('"', '""')}"."agent_creation_request" (org_id, status)` },
    { text: `CREATE INDEX IF NOT EXISTS agent_creation_request_author_idx ON "${schemaName.replaceAll('"', '""')}"."agent_creation_request" (author_id, status)` },
    { text: `CREATE INDEX IF NOT EXISTS agent_creation_request_resolved_approvers_gin ON "${schemaName.replaceAll('"', '""')}"."agent_creation_request" USING gin (resolved_approver_ids)` },
    // Data Safety: Undo & Versioning substrate.
    // object_change_event = append-only history with canonical before/after
    // SNAPSHOTS. Emitted in the SAME DB transaction as the
    // cinatra.objects mutation + the Graphiti outbox enqueue. Append-only:
    // existing rows are never updated; remote-effect status lives on the
    // separate remote_effect_attempts table.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."object_change_event" (
      id                       text PRIMARY KEY,
      change_set_id            text NOT NULL,
      sequence                 integer NOT NULL,
      object_id                text NOT NULL,
      object_type              text NOT NULL,
      operation                text NOT NULL,
      history_effect           text NOT NULL,
      before_snapshot          jsonb,
      after_snapshot           jsonb,
      base_version             integer,
      result_version           integer NOT NULL,
      object_schema_version    text NOT NULL DEFAULT 'v1',
      restore_eligible         boolean NOT NULL DEFAULT true,
      restore_ineligible_reason text,
      compensating_template_id text,
      remote_revision_ref      jsonb,
      actor_id                 text,
      actor_kind               text,
      run_id                   text,
      audit_event_id           text,
      org_id                   text,
      project_id               text,
      owner_level              text,
      owner_id                 text,
      visibility               text,
      idempotency_key          text NOT NULL,
      event_checksum           text NOT NULL,
      created_at               timestamptz NOT NULL DEFAULT now(),
      tombstoned_at            timestamptz
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS object_change_event_idempotency_key_idx ON "${schemaName.replaceAll('"', '""')}"."object_change_event" (idempotency_key)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS object_change_event_change_set_sequence_idx ON "${schemaName.replaceAll('"', '""')}"."object_change_event" (change_set_id, sequence)` },
    { text: `CREATE INDEX IF NOT EXISTS object_change_event_object_id_created_idx ON "${schemaName.replaceAll('"', '""')}"."object_change_event" (object_id, created_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS object_change_event_org_created_idx ON "${schemaName.replaceAll('"', '""')}"."object_change_event" (org_id, created_at DESC) WHERE org_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS object_change_event_run_idx ON "${schemaName.replaceAll('"', '""')}"."object_change_event" (run_id) WHERE run_id IS NOT NULL` },
    // change_set = grouping primitive. Atomic mutation closes its own
    // change_set; run-level rollup is a query over closed change_sets. Effect
    // rollup + restorable are computed on close and persisted; eligibility is
    // re-evaluated at restore-time (referenced reachability + retention +
    // external freshness can shift after close).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."change_set" (
      id                          text PRIMARY KEY,
      org_id                      text,
      opened_at                   timestamptz NOT NULL DEFAULT now(),
      closed_at                   timestamptz,
      closure_reason              text,
      actor_id                    text,
      actor_kind                  text,
      run_id                      text,
      tool_call_id                text,
      action_id                   text,
      effect_rollup               text NOT NULL DEFAULT 'reversible-internal',
      restorable                  boolean NOT NULL DEFAULT true,
      restorable_reason           text,
      parent_change_set_id        text,
      restore_of_change_set_id    text,
      created_by                  text,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS change_set_org_opened_idx ON "${schemaName.replaceAll('"', '""')}"."change_set" (org_id, opened_at DESC) WHERE org_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS change_set_run_idx ON "${schemaName.replaceAll('"', '""')}"."change_set" (run_id) WHERE run_id IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS change_set_closed_idx ON "${schemaName.replaceAll('"', '""')}"."change_set" (closed_at DESC) WHERE closed_at IS NOT NULL` },
    { text: `CREATE INDEX IF NOT EXISTS change_set_restore_of_idx ON "${schemaName.replaceAll('"', '""')}"."change_set" (restore_of_change_set_id) WHERE restore_of_change_set_id IS NOT NULL` },
    // remote_effect_attempts = mutable status for connector restores. Keyed to
    // the canonical object_change_event row but separate so the append-only
    // history surface stays append-only.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."remote_effect_attempts" (
      id                  text PRIMARY KEY,
      change_event_id     text NOT NULL,
      connector_name      text NOT NULL,
      target_kind         text NOT NULL,
      target_id           text,
      intended_state      jsonb,
      status              text NOT NULL DEFAULT 'pending',
      attempt_count       integer NOT NULL DEFAULT 0,
      last_error          text,
      remote_revision_ref jsonb,
      read_back_payload   jsonb,
      idempotency_key     text NOT NULL,
      started_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      org_id              text
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS remote_effect_attempts_idempotency_key_idx ON "${schemaName.replaceAll('"', '""')}"."remote_effect_attempts" (idempotency_key)` },
    { text: `CREATE INDEX IF NOT EXISTS remote_effect_attempts_change_event_idx ON "${schemaName.replaceAll('"', '""')}"."remote_effect_attempts" (change_event_id)` },
    { text: `CREATE INDEX IF NOT EXISTS remote_effect_attempts_status_idx ON "${schemaName.replaceAll('"', '""')}"."remote_effect_attempts" (status, updated_at DESC) WHERE status <> 'succeeded'` },
    // merge_proposal table. Enrichment-agents create
    // proposals; humans review and approve through the MERGE
    // policy. Proposals are append-only; the review verdict lives in
    // status. Approved proposals trigger a canonical historyAwareUpsert
    // with the merged data and the captured baseVersion.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."merge_proposal" (
      id                text PRIMARY KEY,
      object_id         text NOT NULL,
      object_type       text NOT NULL,
      base_version      integer NOT NULL,
      proposing_actor_id text,
      proposing_actor_kind text,
      proposing_run_id  text,
      source_kind       text NOT NULL,
      source_ref        jsonb,
      proposed_fields   jsonb NOT NULL,
      provenance        jsonb,
      status            text NOT NULL DEFAULT 'pending',
      reviewed_by       text,
      reviewed_at       timestamptz,
      review_notes      text,
      applied_change_event_id text,
      org_id            text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS merge_proposal_object_idx ON "${schemaName.replaceAll('"', '""')}"."merge_proposal" (object_id, created_at DESC)` },
    { text: `CREATE INDEX IF NOT EXISTS merge_proposal_status_idx ON "${schemaName.replaceAll('"', '""')}"."merge_proposal" (status, created_at DESC) WHERE status = 'pending'` },
    { text: `CREATE INDEX IF NOT EXISTS merge_proposal_org_idx ON "${schemaName.replaceAll('"', '""')}"."merge_proposal" (org_id, created_at DESC) WHERE org_id IS NOT NULL` },
    // widget_stream_tokens (cinatra#220): short-lived, origin/aud/scope-bound
    // tokens minted by the token-exchange endpoint and consumed by the
    // /api/agents/[agentSlug]/stream route. ONLY SHA-256(rawToken) is stored
    // (hash-at-rest) — a DB/log leak never yields a live credential. Columns
    // are the persisted token claims (see src/lib/widget-token-broker.ts).
    // expires_at index drives the on-mint/on-consume sweep (no external cron).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."widget_stream_tokens" (
      token_hash text PRIMARY KEY,
      jti text NOT NULL,
      agent_slug text NOT NULL,
      aud text NOT NULL,
      iss text NOT NULL,
      origin text NOT NULL,
      scope text NOT NULL,
      sub text,
      token_config_key text NOT NULL,
      token_key_fingerprint text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS widget_stream_tokens_expires_at_idx ON "${schemaName.replaceAll('"', '""')}"."widget_stream_tokens" (expires_at)` },
    // -----------------------------------------------------------------------
    // cinatra#407 — hosted /widget-auth PKCE login + user-scoped widget token.
    //
    // Three short-lived, single-use-discipline tables for the per-user widget
    // login (Plan B, EPIC #406). All secrets are HASH-AT-REST (only sha256 of
    // each code/token is stored). Dedicated tables (NOT TTL-cached
    // connector_config JSON) so the single-use consume is an atomic
    // UPDATE/DELETE...RETURNING free of read-modify-write races. Each carries an
    // expires_at index driving the on-write sweep (no external cron). The full
    // engine + the security rationale live in src/lib/widget-user-auth.ts.
    //
    // Table 1 — auth transactions. Created by the site-token-authenticated init
    // route; pins the SERVER-VERIFIED context {site_id, client, org_id,
    // site_origin, agent_slug, instance_id} + the widget's PKCE code_challenge +
    // single-use state. consumed_at marks single-use (set when the code issues).
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."widget_auth_transactions" (
      txn_id         uuid PRIMARY KEY,
      site_id        uuid NOT NULL,
      client         text NOT NULL,
      org_id         text NOT NULL,
      site_origin    text NOT NULL,
      agent_slug     text NOT NULL,
      instance_id    text NOT NULL,
      code_challenge text NOT NULL,
      state          text NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      consumed_at    timestamptz
    )` },
    { text: `CREATE INDEX IF NOT EXISTS widget_auth_transactions_expiry_idx ON "${schemaName.replaceAll('"', '""')}"."widget_auth_transactions" (expires_at)` },
    // Table 2 — user authorization codes. Issued by the hosted page after the
    // logged-in MEMBER consents; keyed by the sha256 of the plaintext code
    // (which is postMessage'd to the verified opener origin and never stored).
    // Carries the full user binding; redeemed exactly once via DELETE...RETURNING.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."widget_auth_codes" (
      code_hash      text PRIMARY KEY,
      user_id        text NOT NULL,
      site_id        uuid NOT NULL,
      client         text NOT NULL,
      org_id         text NOT NULL,
      site_origin    text NOT NULL,
      agent_slug     text NOT NULL,
      instance_id    text NOT NULL,
      code_challenge text NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL
    )` },
    { text: `CREATE INDEX IF NOT EXISTS widget_auth_codes_expiry_idx ON "${schemaName.replaceAll('"', '""')}"."widget_auth_codes" (expires_at)` },
    // Table 3 — opaque short-lived user tokens (cwu_). Browser-held bearer the
    // stream route validates (CHILD 3). Keyed by sha256(rawToken); only the hash
    // is stored. Multi-use within TTL; instant revoke via row delete or the live
    // connect-site re-check (see consumeUserWidgetToken). NO refresh token.
    //
    // `credential_version` pins the `connect_sites` credential generation the
    // token was minted against (rotation binding, mirroring the site-scoped
    // broker's `token_key_fingerprint` re-check in widget-token-broker.ts:384).
    // A reconnect ROTATES the same active site row (bumping credential_version)
    // WITHOUT revoking it, so the live org/origin re-check alone would let an
    // outstanding `cwu_` survive a rotation for its full TTL. Re-checking this
    // version at consume kills outstanding user tokens the instant the site
    // credential is rotated.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."widget_user_tokens" (
      token_hash         text PRIMARY KEY,
      jti                text NOT NULL,
      user_id            text NOT NULL,
      site_id            uuid NOT NULL,
      client             text NOT NULL,
      org_id             text NOT NULL,
      site_origin        text NOT NULL,
      agent_slug         text NOT NULL,
      instance_id        text NOT NULL,
      credential_version integer NOT NULL,
      aud                text NOT NULL,
      iss                text NOT NULL,
      scope              text NOT NULL,
      expires_at         timestamptz NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS widget_user_tokens_expiry_idx ON "${schemaName.replaceAll('"', '""')}"."widget_user_tokens" (expires_at)` },
    // -----------------------------------------------------------------------
    // cinatra#221 "Connect with Cinatra" provisioning tables.
    //
    // Dedicated tables (NOT TTL-cached connector_config JSON) so single-use
    // consume, revoke, and lastUsedAt updates are atomic UPDATE...RETURNING
    // statements free of the read-modify-write lost-update races that JSON-blob
    // storage would carry. Secrets are NEVER stored in plaintext: only the
    // sha256 hash of each authorization/install code and per-site credential is
    // persisted. See src/lib/connect-sites-store.ts and
    // src/lib/connect-provisioning.ts.
    //
    // Table A — short-lived grants (auth codes + install codes). Keyed by the
    // sha256 code hash; the plaintext code/install-code never touches the DB.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."connect_authorization_codes" (
      code_hash        text PRIMARY KEY,
      grant_type       text NOT NULL,
      client           text NOT NULL,
      redirect_uri     text,
      widget_origin    text NOT NULL,
      callback_origin  text,
      code_challenge   text,
      admin_user_id    text,
      org_id           text,
      scope            text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      expires_at       timestamptz NOT NULL,
      consumed_at      timestamptz
    )` },
    { text: `CREATE INDEX IF NOT EXISTS connect_auth_codes_expiry_idx ON "${schemaName.replaceAll('"', '""')}"."connect_authorization_codes" (expires_at)` },
    // Table B — connected-site source of truth AND the per-site bearer
    // allowlist (single source of truth, codex High). The partial unique index
    // enforces at most one ACTIVE (non-revoked) row per (org_id, client,
    // widget_origin) so a reconnect ROTATES the same row instead of minting a
    // parallel valid credential.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."connect_sites" (
      site_id             uuid PRIMARY KEY,
      client              text NOT NULL,
      widget_origin       text NOT NULL,
      callback_origin     text,
      credential_hash     text NOT NULL,
      credential_version  int NOT NULL,
      webhook_secret_hash text,
      admin_user_id       text,
      org_id              text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      last_exchanged_at   timestamptz,
      last_used_at        timestamptz,
      revoked_at          timestamptz,
      revoked_by          text
    )` },
    // NULLS NOT DISTINCT (Postgres 15+) is REQUIRED: without it Postgres treats
    // NULL org_id as distinct, so two active rows could coexist for a null-org
    // (org_id, client, widget_origin) tuple — minting parallel valid cnx_
    // credentials and breaking rotate-in-place (codex High). With NULLS NOT
    // DISTINCT a null org_id collides like any other value, so reconnect always
    // rotates the single active row.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS connect_sites_active_uniq ON "${schemaName.replaceAll('"', '""')}"."connect_sites" (org_id, client, widget_origin) NULLS NOT DISTINCT WHERE revoked_at IS NULL` },
    { text: `CREATE INDEX IF NOT EXISTS connect_sites_org_idx ON "${schemaName.replaceAll('"', '""')}"."connect_sites" (org_id) WHERE revoked_at IS NULL` },
    { text: `CREATE INDEX IF NOT EXISTS connect_sites_active_origin_idx ON "${schemaName.replaceAll('"', '""')}"."connect_sites" (widget_origin) WHERE revoked_at IS NULL` },
    // webhook_idempotency: leased dedupe ledger for the generic inbound-webhook
    // route (cinatra#340). One row per (scope, site_id, message_id); the route
    // CLAIMS (atomic UPSERT) before dispatch and FINALIZES (attempt-fenced)
    // after. All three key columns NOT NULL (a nullable unique-key column would
    // admit duplicate NULL rows → broken idempotency). site_id uuid (the
    // connect_sites.site_id identity space). Migration parity: core__0008.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."webhook_idempotency" (
      id            bigserial PRIMARY KEY,
      scope         text NOT NULL,
      site_id       uuid NOT NULL,
      message_id    text NOT NULL,
      status        text NOT NULL DEFAULT 'processing',
      lease_until   timestamptz,
      attempt_count integer NOT NULL DEFAULT 1,
      received_at   timestamptz NOT NULL DEFAULT now(),
      finalized_at  timestamptz
    )` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS webhook_idempotency_key_uniq ON "${schemaName.replaceAll('"', '""')}"."webhook_idempotency" (scope, site_id, message_id)` },
    // webhook_secret_bindings: per-(vendor,slug,hook,site) Standard-Webhooks
    // secret material, ENCRYPTED via the host secretsCodec (ciphertext+iv, NOT a
    // ref), with the bounded dual-secret rotation window (previous_* until
    // previous_expires_at). Resolved by the server-issued opaque binding_id
    // (NEVER the payload). Partial-unique active-row index enforces at most one
    // active binding per tuple. legacy_enabled is the #343 structural hook
    // (legacy-secret storage deferred to #343; false in #340). site_id uuid.
    // Migration parity: core__0009.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."webhook_secret_bindings" (
      binding_id                 text PRIMARY KEY,
      vendor                     text NOT NULL,
      slug                       text NOT NULL,
      hook                       text NOT NULL,
      site_id                    uuid NOT NULL,
      current_secret_ciphertext  text NOT NULL,
      current_secret_iv          text NOT NULL,
      previous_secret_ciphertext text,
      previous_secret_iv         text,
      previous_expires_at        timestamptz,
      rotated_at                 timestamptz,
      legacy_enabled             boolean NOT NULL DEFAULT false,
      revoked_at                 timestamptz,
      created_at                 timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS webhook_secret_bindings_site_idx ON "${schemaName.replaceAll('"', '""')}"."webhook_secret_bindings" (site_id)` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS webhook_secret_bindings_active_uniq ON "${schemaName.replaceAll('"', '""')}"."webhook_secret_bindings" (vendor, slug, hook, site_id) WHERE revoked_at IS NULL` },
  ];

  // Fresh-schema ordering invariant. On a populated DB every object already
  // exists so statement order is moot, but on any fresh schema a seed INSERT
  // emitted before the CREATE TABLE or ADD COLUMN it references aborts the
  // whole DDL batch at cold boot. A stable two-phase split puts all structural
  // DDL first in original order, preserving the leading legacy-DROP guard,
  // function/trigger/constraint sequencing, and every existing intra-DDL
  // invariant. Standalone seed INSERTs then run in original order.
  // Structural DDL never depends on seed rows, so end-loading the INSERTs is
  // safe. Only statement-leading `INSERT INTO` moves; INSERTs inside
  // DO-blocks and trigger-function bodies are left in place.

  const isSeedInsert = (q: QueryInput): boolean =>
    /^\s*INSERT\s+INTO/i.test(q.text);
  // Data-migration queries run AFTER all structural DDL + seed inserts so
  // they see the latest schema shape. Each migration is idempotent and
  // safe to replay on every boot.
  return [
    ...queries.filter((q) => !isSeedInsert(q)),
    ...queries.filter((q) => isSeedInsert(q)),
  ];
}

export function buildReadMetadataQuery(schemaName: string, key: string): QueryInput {
  const store = getStore(schemaName);
  return toQueryInput(
    store.db
      .select({ value: store.tables.metadata.value })
      .from(store.tables.metadata)
      .where(eq(store.tables.metadata.key, key))
      .limit(1),
  );
}

export function buildWriteMetadataQuery(schemaName: string, key: string, value: string): QueryInput {
  const store = getStore(schemaName);
  return toQueryInput(
    store.db
      .insert(store.tables.metadata)
      .values({ key, value })
      .onConflictDoUpdate({
        target: store.tables.metadata.key,
        set: { value },
      }),
  );
}

// Physically REMOVE a metadata row. Distinct from `buildWriteMetadataQuery(key, "null")`
// which UPSERTs the JSON string "null" and leaves the row in place — the
// extension settings/secrets teardown needs a true row delete.
export function buildDeleteMetadataQuery(schemaName: string, key: string): QueryInput {
  const table = `"${schemaName.replaceAll('"', '""')}"."metadata"`;
  return { text: `DELETE FROM ${table} WHERE key = $1`, values: [key] };
}

// Physically REMOVE every metadata row whose key starts with `prefix`. LIKE
// wildcards (`%`, `_`, `\`) in the caller-supplied prefix are escaped so a
// literal prefix (e.g. `connector_config:ext:<pkg>:`) can never be widened into
// a broader match. Used by the extension data-teardown hook to reap an
// uninstalled extension's org-scoped settings/secrets keys (and, once the
// dev-fixtures contract lands, its fixture-provenance keys).
export function buildDeleteMetadataByPrefixQuery(schemaName: string, prefix: string): QueryInput {
  const table = `"${schemaName.replaceAll('"', '""')}"."metadata"`;
  const escaped = prefix.replace(/([\\%_])/g, "\\$1");
  return { text: `DELETE FROM ${table} WHERE key LIKE $1 ESCAPE '\\'`, values: [`${escaped}%`] };
}

export function buildSelectJsonRowsQuery(schemaName: string, tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">): QueryInput {
  const store = getStore(schemaName);
  const table = getPayloadTable(store.tables, tableName);

  return toQueryInput(
    store.db
      .select({ id: table.id, payload: table.payload })
      .from(table),
  );
}

export function buildDeleteAllRowsQuery(schemaName: string, tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">): QueryInput {
  const store = getStore(schemaName);
  return toQueryInput(store.db.delete(getPayloadTable(store.tables, tableName)));
}

export function buildInsertJsonRowQuery(
  schemaName: string,
  tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">,
  row: { id: string; payload: string },
): QueryInput {
  const store = getStore(schemaName);
  return toQueryInput(
    store.db.insert(getPayloadTable(store.tables, tableName)).values(row),
  );
}

export function buildUpsertJsonRowQuery(
  schemaName: string,
  tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">,
  row: { id: string; payload: string },
): QueryInput {
  const store = getStore(schemaName);
  const table = getPayloadTable(store.tables, tableName);
  return toQueryInput(
    store.db.insert(table).values(row).onConflictDoUpdate({
      target: table.id,
      set: { payload: row.payload },
    }),
  );
}

/**
 * Specialized UPSERT for `skill_packages` that ALSO sets the
 * typed identity columns (owner_scope, owner_id,
 * binding_scope, source_kind, vendor, package, agent_template_id,
 * skill_slug). Replaces the generic `buildUpsertJsonRowQuery` for that
 * table — the generic version only writes `{id, payload}` and leaves the
 * NOT-NULL-aspirant identity columns as NULL, which is exactly the bug
 * nullable-column hotfix had to relax with `ALTER COLUMN ... DROP NOT NULL`.
 *
 * After this function is used by every catalog write path, the NOT NULL
 * constraints can be restored.
 *
 * The Drizzle schema declares skill_packages with only {id, payload}
 * (the identity columns were added via raw ALTER TABLE in
 * ensurePostgresSchema). Drizzle's `.values()` won't typecheck against
 * those raw columns, so this function emits raw SQL via the QueryInput
 * shape used by `runPostgresQueriesSync`.
 */
// Import the literal unions from @cinatra-ai/skills so a
// typo (e.g. "workspaces" instead of "workspace") fails typecheck instead of
// hitting `skill_pkg_owner_scope_chk` at runtime mid-transaction.
export type SkillPackageIdentity = {
  owner_scope: OwnerScope;
  owner_id: string | null;
  binding_scope: BindingScope;
  source_kind: SourceKind;
  vendor: string | null;
  package: string | null;
  agent_template_id: string | null;
  skill_slug: string;
};

export function buildUpsertSkillPackageQuery(
  schemaName: string,
  row: { id: string; payload: string },
  identity: SkillPackageIdentity,
): QueryInput {
  // Raw SQL: $1..$10 = id, payload, owner_scope, owner_id, binding_scope,
  // source_kind, vendor, package, agent_template_id, skill_slug.
  // The schema identifier is interpolated (whitelist-validated upstream;
  // only ever `postgresSchema` from .env). All values are parameterized.
  const escapedSchema = schemaName.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${escapedSchema}"."skill_packages"
        (id, payload, owner_scope, owner_id, binding_scope, source_kind,
         vendor, package, agent_template_id, skill_slug)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        payload          = EXCLUDED.payload,
        owner_scope      = EXCLUDED.owner_scope,
        owner_id         = EXCLUDED.owner_id,
        binding_scope    = EXCLUDED.binding_scope,
        source_kind      = EXCLUDED.source_kind,
        vendor           = EXCLUDED.vendor,
        package          = EXCLUDED.package,
        agent_template_id = EXCLUDED.agent_template_id,
        skill_slug       = EXCLUDED.skill_slug`,
    values: [
      row.id,
      row.payload,
      identity.owner_scope,
      identity.owner_id,
      identity.binding_scope,
      identity.source_kind,
      identity.vendor,
      identity.package,
      identity.agent_template_id,
      identity.skill_slug,
    ],
  };
}

export function buildDeleteJsonRowQuery(
  schemaName: string,
  tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">,
  id: string,
): QueryInput {
  const store = getStore(schemaName);
  const table = getPayloadTable(store.tables, tableName);
  return toQueryInput(
    store.db.delete(table).where(eq(table.id, id)),
  );
}

/**
 * DELETE every row whose `id` is NOT in the given
 * keep set. Used by `replaceSkillCatalogInDatabase()` to drop catalog rows
 * that vanished from the new catalog without wiping rows that are still
 * present (the latter would cascade-/restrict-delete sibling tables like
 * `skill_package_co_owners`).
 *
 * If `keepIds` is empty, deletes every row in the table.
 *
 * The DELETE is one statement; with FK ON DELETE RESTRICT, the database
 * rejects (and the entire transaction rolls back) any DELETE that would
 * orphan a sibling-table row — surfacing a clear error to the caller.
 */
export function buildDeleteRowsNotInQuery(
  schemaName: string,
  tableName: Exclude<TableName, "metadata" | "extension_lifecycle_audit" | "extension_destinations">,
  keepIds: ReadonlyArray<string>,
): QueryInput {
  const store = getStore(schemaName);
  const table = getPayloadTable(store.tables, tableName);
  if (keepIds.length === 0) {
    return toQueryInput(store.db.delete(table));
  }
  return toQueryInput(
    store.db.delete(table).where(notInArray(table.id, keepIds as string[])),
  );
}

// ---------------------------------------------------------------------------
// extension_lifecycle_audit insert query builder.
// The audit table is NOT a JSON-payload table so it cannot use buildInsertJsonRowQuery.
// This function produces a parameterized INSERT that database.ts runs via
// runPostgresQueriesSync (same pattern as all other write helpers in this file).
// ---------------------------------------------------------------------------
export type ExtensionLifecycleAuditRow = {
  id: string;
  actorId: string;
  actorType: string;
  orgId: string | null;
  operation: string;
  packageName: string;
  packageVersion: string | null;
  destroyedRowSnapshot: unknown;
  danglingReferences: unknown;
  reason: string | null;
};

export function buildInsertExtensionLifecycleAuditQuery(
  schemaName: string,
  row: ExtensionLifecycleAuditRow,
): QueryInput {
  const store = getStore(schemaName);
  return toQueryInput(
    store.db
      .insert(store.tables.extension_lifecycle_audit)
      .values({
        id: row.id,
        actorId: row.actorId,
        actorType: row.actorType,
        orgId: row.orgId ?? undefined,
        operation: row.operation,
        packageName: row.packageName,
        packageVersion: row.packageVersion ?? undefined,
        destroyedRowSnapshot: row.destroyedRowSnapshot ?? undefined,
        danglingReferences: row.danglingReferences ?? undefined,
        reason: row.reason ?? undefined,
      }),
  );
}
