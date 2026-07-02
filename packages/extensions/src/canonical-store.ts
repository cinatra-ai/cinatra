// Canonical installed_extension store.
// CRUD for the single source of truth manifest row.
//
// IMPORTANT: callers MUST NOT use this store to write `status` directly —
// every status mutation goes through `transitionExtensionLifecycle`
// (lifecycle-primitive.ts). Static checks enforce this boundary.
import "server-only";

import { sql } from "drizzle-orm";
import { eq, and } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import { text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

import type {
  ExtensionDependency,
  ExtensionKind,
  ExtensionLifecycleStatus,
  ExtensionOwnerLevel,
  ExtensionSource,
  InstalledExtension,
} from "./canonical-types";
import { PLATFORM_OWNER_SENTINEL } from "./canonical-types";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const canonicalSchema = pgSchema(schemaName);

// Drizzle table definition for `installed_extension`. Schema DDL lives in
// src/lib/drizzle-store.ts (the canonical place for migrations).
export const installedExtensionTable = canonicalSchema.table("installed_extension", {
  id: text("id").primaryKey(),
  packageName: text("package_name").notNull(),
  ownerLevel: text("owner_level").notNull(),
  ownerId: text("owner_id"),
  organizationId: text("organization_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  source: jsonb("source").notNull(),
  requiredInProd: boolean("required_in_prod").notNull().default(false),
  dependencies: jsonb("dependencies").notNull().default(sql`'[]'::jsonb`),
  manifestHash: text("manifest_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InstalledExtensionRow = typeof installedExtensionTable.$inferSelect;

function rowToCanonical(row: InstalledExtensionRow): InstalledExtension {
  return {
    id: row.id,
    packageName: row.packageName,
    ownerLevel: row.ownerLevel as ExtensionOwnerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    kind: row.kind as ExtensionKind,
    status: row.status as ExtensionLifecycleStatus,
    source: row.source as ExtensionSource,
    requiredInProd: row.requiredInProd,
    dependencies: (row.dependencies as ExtensionDependency[] | null) ?? [],
    manifestHash: row.manifestHash ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Lazy pool + drizzle bootstrap. Pool is created on first use (not at module
// import) so `next build` page-data collection — and any other import-time
// evaluation without SUPABASE_DB_URL — does not throw. Mirrors the pattern
// in packages/workflows/src/db.ts (the lazy-pool invariant guarded
// by src/lib/__tests__/db-pool-lazy-init.test.ts).
type CanonicalDb = ReturnType<typeof createCanonicalDb>;

declare global {
  // eslint-disable-next-line no-var
  var __cinatraCanonicalManifestPool: import("pg").Pool | undefined;
}

let canonicalPoolInstance: import("pg").Pool | undefined;
async function getCanonicalPool(): Promise<import("pg").Pool> {
  if (canonicalPoolInstance) return canonicalPoolInstance;
  if (globalThis.__cinatraCanonicalManifestPool) {
    return (canonicalPoolInstance = globalThis.__cinatraCanonicalManifestPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for canonical installed_extension store");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extensions/canonical-store] pg pool idle error:", err.message);
    });
  }
  canonicalPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraCanonicalManifestPool = pool;
  }
  return pool;
}

function createCanonicalDb(pool: import("pg").Pool) {
  // Dynamic import keeps drizzle out of the type-eager path so this module
  // can be referenced from static checks and unit tests without a live DB.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
  return drizzle(pool, { schema: { installedExtensionTable } });
}

let canonicalDbInstance: CanonicalDb | undefined;
async function getDb(): Promise<CanonicalDb> {
  if (canonicalDbInstance) return canonicalDbInstance;
  const pool = await getCanonicalPool();
  return (canonicalDbInstance ??= createCanonicalDb(pool));
}

export type CanonicalIdentity = {
  organizationId: string | null;
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  packageName: string;
};

function platformizeOwnerId(ownerLevel: ExtensionOwnerLevel, ownerId: string | null): string {
  return ownerLevel === "platform" ? PLATFORM_OWNER_SENTINEL : (ownerId ?? PLATFORM_OWNER_SENTINEL);
}

export async function readInstalledExtensionById(id: string): Promise<InstalledExtension | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(eq(installedExtensionTable.id, id))
    .limit(1);
  return rows[0] ? rowToCanonical(rows[0]) : null;
}

export async function readInstalledExtensionByIdentity(
  identity: CanonicalIdentity,
): Promise<InstalledExtension | null> {
  const db = await getDb();
  const ownerId = platformizeOwnerId(identity.ownerLevel, identity.ownerId);
  const orgClause = identity.organizationId
    ? eq(installedExtensionTable.organizationId, identity.organizationId)
    : sql`${installedExtensionTable.organizationId} IS NULL`;
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(
      and(
        orgClause,
        eq(installedExtensionTable.ownerLevel, identity.ownerLevel),
        eq(installedExtensionTable.ownerId, ownerId),
        eq(installedExtensionTable.packageName, identity.packageName),
      ),
    )
    .limit(1);
  return rows[0] ? rowToCanonical(rows[0]) : null;
}

export async function readInstalledExtensionsByPackageName(
  packageName: string,
): Promise<InstalledExtension[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(eq(installedExtensionTable.packageName, packageName));
  return rows.map(rowToCanonical);
}

/**
 * Batch reader: all canonical install rows for a SET of package names, grouped by
 * package name, in ONE query. Used by the connector-card index (cinatra#658) to
 * resolve the actor-scoped installed set without firing one read per catalog
 * entry (codex-converged: a single consistent read, not N reads + N outage logs).
 * A package name absent from the result has no rows (the caller treats that as
 * the bundled fallback). Returns the full canonical rows so the caller can apply
 * the SAME pure scope/status predicate (`pickActiveInstallId` /
 * `isInstallRowAddressableByActor`) the per-package path uses.
 */
export async function readInstalledExtensionsByPackageNames(
  packageNames: readonly string[],
): Promise<Map<string, InstalledExtension[]>> {
  const out = new Map<string, InstalledExtension[]>();
  if (packageNames.length === 0) return out;
  const db = await getDb();
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(inArray(installedExtensionTable.packageName, [...packageNames]));
  for (const row of rows) {
    const canonical = rowToCanonical(row);
    const bucket = out.get(canonical.packageName);
    if (bucket) bucket.push(canonical);
    else out.set(canonical.packageName, [canonical]);
  }
  return out;
}

/**
 * Package-name effective-status reader (fail-safe aggregate).
 *
 * Used by `checkDependents` (uninstall-blocking) where only the package name is
 * available (AgentTemplateRecord does not expose owner_level/owner_id). The
 * aggregate errs toward "live" — a package is "active" if ANY canonical row is
 * `active` or `locked`, and "archived" only when it HAS rows and ALL are
 * archived. This is the SAFE direction for a dependency block (over-block, never
 * under-block). An absent package is not in the map → caller defaults to
 * "active" (fail-safe default).
 *
 * The marketplace readers in @cinatra-ai/agents use an EXACT-identity raw read
 * (org_id, owner_level, owner_id, package_name) instead — see
 * readEffectiveExtensionStatusByIdentity in packages/agents/src/store.ts — to
 * avoid status-bleed across scopes in listings.
 */
export async function readEffectiveStatusByPackageNames(
  packageNames: string[],
): Promise<Map<string, "active" | "archived">> {
  if (packageNames.length === 0) return new Map();
  const db = await getDb();
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      packageName: installedExtensionTable.packageName,
      status: installedExtensionTable.status,
    })
    .from(installedExtensionTable)
    .where(inArray(installedExtensionTable.packageName, packageNames));
  return aggregateEffectiveStatusByPackageName(rows);
}

/**
 * The PURE aggregation half of `readEffectiveStatusByPackageNames` (same
 * live-wins semantics, documented above), factored out so lifecycle-correctness
 * tests can chain primitive → aggregate → loader gate without a DB.
 */
export function aggregateEffectiveStatusByPackageName(
  rows: ReadonlyArray<{ packageName: string; status: string }>,
): Map<string, "active" | "archived"> {
  const result = new Map<string, "active" | "archived">();
  for (const row of rows) {
    const live = row.status === "active" || row.status === "locked";
    if (live) result.set(row.packageName, "active");
    else if (result.get(row.packageName) === undefined) result.set(row.packageName, "archived");
  }
  return result;
}

export async function listInstalledExtensions(filters: {
  kind?: ExtensionKind;
  status?: ExtensionLifecycleStatus;
  organizationId?: string | null;
} = {}): Promise<InstalledExtension[]> {
  const db = await getDb();
  const clauses = [] as ReturnType<typeof eq>[];
  if (filters.kind) clauses.push(eq(installedExtensionTable.kind, filters.kind));
  if (filters.status) clauses.push(eq(installedExtensionTable.status, filters.status));
  if (filters.organizationId !== undefined) {
    clauses.push(
      filters.organizationId === null
        ? (sql`${installedExtensionTable.organizationId} IS NULL` as unknown as ReturnType<typeof eq>)
        : eq(installedExtensionTable.organizationId, filters.organizationId),
    );
  }
  const where = clauses.length === 0 ? undefined : and(...clauses);
  const query = db.select().from(installedExtensionTable);
  const rows = where ? await query.where(where) : await query;
  return rows.map(rowToCanonical);
}

// Internal — used only by the lifecycle primitive. Static checks prevent
// other callers from importing these functions.
export async function _internalInsertInstalledExtension(
  row: Omit<InstalledExtension, "createdAt" | "updatedAt">,
): Promise<InstalledExtension> {
  const db = await getDb();
  const ownerId = platformizeOwnerId(row.ownerLevel, row.ownerId);
  const result = await db
    .insert(installedExtensionTable)
    .values({
      id: row.id,
      packageName: row.packageName,
      ownerLevel: row.ownerLevel,
      ownerId,
      organizationId: row.organizationId,
      kind: row.kind,
      status: row.status,
      source: row.source as unknown,
      requiredInProd: row.requiredInProd,
      dependencies: row.dependencies as unknown,
      manifestHash: row.manifestHash,
    })
    .returning();
  if (!result[0]) throw new Error("installed_extension insert returned no row");
  return rowToCanonical(result[0]);
}

export async function _internalUpdateInstalledExtensionStatus(
  id: string,
  status: ExtensionLifecycleStatus,
): Promise<InstalledExtension> {
  const db = await getDb();
  const result = await db
    .update(installedExtensionTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(installedExtensionTable.id, id))
    .returning();
  if (!result[0]) throw new Error(`installed_extension ${id} not found for status update`);
  return rowToCanonical(result[0]);
}

export async function _internalUpdateInstalledExtensionSource(
  id: string,
  source: ExtensionSource,
): Promise<InstalledExtension> {
  const db = await getDb();
  const result = await db
    .update(installedExtensionTable)
    .set({ source: source as unknown, updatedAt: new Date() })
    .where(eq(installedExtensionTable.id, id))
    .returning();
  if (!result[0]) throw new Error(`installed_extension ${id} not found for source update`);
  return rowToCanonical(result[0]);
}

export async function _internalUpdateInstalledExtensionMetadata(
  id: string,
  patch: {
    dependencies?: ExtensionDependency[];
    requiredInProd?: boolean;
    manifestHash?: string | null;
  },
): Promise<InstalledExtension> {
  const db = await getDb();
  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.dependencies !== undefined) setClause.dependencies = patch.dependencies;
  if (patch.requiredInProd !== undefined) setClause.requiredInProd = patch.requiredInProd;
  if (patch.manifestHash !== undefined) setClause.manifestHash = patch.manifestHash;
  const result = await db
    .update(installedExtensionTable)
    .set(setClause)
    .where(eq(installedExtensionTable.id, id))
    .returning();
  if (!result[0]) throw new Error(`installed_extension ${id} not found for metadata update`);
  return rowToCanonical(result[0]);
}

export async function _internalDeleteInstalledExtension(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(installedExtensionTable).where(eq(installedExtensionTable.id, id));
}
