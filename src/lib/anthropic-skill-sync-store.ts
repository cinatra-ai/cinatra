import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema, text, boolean, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { Pool } from "pg";

/**
 * Drizzle binding for `cinatra.anthropic_skill_sync`.
 *
 * Schema binding only (mirrors `src/lib/projects-store.ts`). The DDL is the
 * source of truth in `drizzle-store.ts#buildCreateStoreSchemaQueries` (this
 * codebase uses raw SQL migrations, not drizzle-kit); the ORM declaration here
 * is advisory and kept in sync with that DDL. Async pool — the sync engine
 * runs at admin-save/setup, never during production build-time page collection.
 *
 * The 3-tuple PRIMARY KEY (api_key_fingerprint, environment, catalog_skill_id)
 * is the collision-safe namespace key: one Anthropic API key shared across
 * worktree/clone/staging/prod must not clobber another environment's rows.
 */

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const anthropicSkillSync = cinatraSchema.table(
  "anthropic_skill_sync",
  {
    apiKeyFingerprint: text("api_key_fingerprint").notNull(),
    environment: text("environment").notNull(),
    catalogSkillId: text("catalog_skill_id").notNull(),
    anthropicSkillId: text("anthropic_skill_id").notNull(),
    anthropicVersion: text("anthropic_version").notNull(),
    contentHash: text("content_hash").notNull(),
    stale: boolean("stale").notNull().default(false),
    // Set false->true only by the mark-stale DAO ops; the GC stale-age GRACE
    // anchor. Nullable rows are GC-ineligible, fail-closed.
    staleAt: timestamp("stale_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.apiKeyFingerprint, t.environment, t.catalogSkillId] }),
    skillIdx: index("anthropic_skill_sync_skill_idx").on(t.anthropicSkillId),
  }),
);

export type AnthropicSkillSyncRecord = typeof anthropicSkillSync.$inferSelect;

/**
 * Drizzle binding for `cinatra.anthropic_skill_lease`.
 *
 * One row per in-flight reference: a creation run resolving a synced skill at
 * dispatch records a short-lived lease on its (catalog_skill_id,
 * anthropic_version). The random `lease_id` disambiguates many concurrent
 * runs; `expires_at` self-reaps a crashed run. GC refuses to reclaim any
 * anthropic_skill_id with a non-expired lease on ANY of its versions.
 * Namespace-keyed exactly like `anthropic_skill_sync` (one Anthropic API key
 * shared across worktree/clone/staging/prod).
 */
export const anthropicSkillLease = cinatraSchema.table(
  "anthropic_skill_lease",
  {
    apiKeyFingerprint: text("api_key_fingerprint").notNull(),
    environment: text("environment").notNull(),
    catalogSkillId: text("catalog_skill_id").notNull(),
    anthropicSkillId: text("anthropic_skill_id").notNull(),
    anthropicVersion: text("anthropic_version").notNull(),
    leaseId: text("lease_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [
        t.apiKeyFingerprint,
        t.environment,
        t.catalogSkillId,
        t.anthropicVersion,
        t.leaseId,
      ],
    }),
    skillIdx: index("anthropic_skill_lease_skill_idx").on(
      t.apiKeyFingerprint,
      t.environment,
      t.anthropicSkillId,
    ),
    expiresIdx: index("anthropic_skill_lease_expires_idx").on(t.expiresAt),
  }),
);

export type AnthropicSkillLeaseRecord = typeof anthropicSkillLease.$inferSelect;

declare global {
  var __cinatraAnthropicSkillSyncPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
let anthropicSkillSyncPoolInstance: Pool | undefined;
function getAnthropicSkillSyncPool(): Pool {
  if (anthropicSkillSyncPoolInstance) return anthropicSkillSyncPoolInstance;
  if (globalThis.__cinatraAnthropicSkillSyncPool) {
    return (anthropicSkillSyncPoolInstance = globalThis.__cinatraAnthropicSkillSyncPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/anthropic-skill-sync-store");
  }
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[anthropic-skill-sync-store] pg pool idle client error:", err.message);
    });
  }
  anthropicSkillSyncPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraAnthropicSkillSyncPool = pool;
  }
  return pool;
}

function createAnthropicSkillSyncDb() {
  return drizzle(getAnthropicSkillSyncPool(), {
    schema: { anthropicSkillSync, anthropicSkillLease },
  });
}
let anthropicSkillSyncDbInstance: ReturnType<typeof createAnthropicSkillSyncDb> | undefined;
function getAnthropicSkillSyncDb(): ReturnType<typeof createAnthropicSkillSyncDb> {
  return (anthropicSkillSyncDbInstance ??= createAnthropicSkillSyncDb());
}

// Lazy value-export proxies preserve the historical `anthropicSkillSyncPool` /
// `anthropicSkillSyncDb` import contract (zero consumer changes) while deferring
// pool creation to first use. Method access is bound to the real target.
export const anthropicSkillSyncPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    const target: any = getAnthropicSkillSyncPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const anthropicSkillSyncDb: ReturnType<typeof createAnthropicSkillSyncDb> = new Proxy(
  {} as ReturnType<typeof createAnthropicSkillSyncDb>,
  {
    get(_t, prop) {
      const target: any = getAnthropicSkillSyncDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);
