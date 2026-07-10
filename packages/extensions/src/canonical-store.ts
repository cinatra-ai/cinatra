// Canonical installed_extension store.
// CRUD for the single source of truth manifest row.
//
// IMPORTANT: callers MUST NOT use this store to write `status` directly —
// every status mutation goes through `transitionExtensionLifecycle`
// (lifecycle-primitive.ts). Static checks enforce this boundary.
import "server-only";

import { sql } from "drizzle-orm";
import { eq, and, inArray, asc } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import { text, timestamp, jsonb, boolean, integer } from "drizzle-orm/pg-core";

import type {
  DependencyEdgeType,
  DependencyRequirement,
  ExtensionDependency,
  ExtensionKind,
  ExtensionLifecycleStatus,
  ExtensionOwnerLevel,
  ExtensionSource,
  InstalledExtension,
  ResolvedDependencyEdge,
  VersionConstraint,
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
  // Version identity (cinatra#1040 S1). `version` is NOT NULL in the DB (the
  // core__0022 backfill floors legacy github/local rows to '0.0.0'); `is_default`
  // marks the version that owns the package's unversioned global name. Schema DDL
  // lives in src/lib/extension-grant-schema.ts (versionIdentitySchemaQueries) +
  // migrations/core/core__0022.
  version: text("version").notNull(),
  isDefault: boolean("is_default").notNull().default(true),
  requiredInProd: boolean("required_in_prod").notNull().default(false),
  // NOTE (cinatra#1040 S2): the legacy `dependencies` jsonb column was dropped
  // by core__0025 — edges live in `extension_dependency_edge` (below) and are
  // hydrated onto every canonical read.
  manifestHash: text("manifest_hash"),
  // Resolved connector access declaration (cinatra#951) — cached at
  // registration/materialize; NULL for non-connector kinds / legacy rows.
  accessDeclaration: jsonb("access_declaration"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Drizzle table definition for `extension_dependency_edge` (cinatra#1040 S2):
// one row per DECLARED manifest edge of an installed row, plus the write-time
// RESOLUTION (which installed row satisfied it, and why). Declared order is
// preserved via `declared_index` (unique per dependent). Schema DDL lives in
// src/lib/extension-grant-schema.ts (dependencyEdgeSchemaQueries) +
// migrations/core/core__0025.
export const extensionDependencyEdgeTable = canonicalSchema.table("extension_dependency_edge", {
  id: text("id").primaryKey(),
  dependentInstallId: text("dependent_install_id").notNull(),
  declaredPackageName: text("declared_package_name").notNull(),
  declaredKind: text("declared_kind"),
  edgeType: text("edge_type").notNull(),
  requirement: text("requirement").notNull(),
  versionConstraint: jsonb("version_constraint").notNull(),
  declaredIndex: integer("declared_index").notNull().default(0),
  resolvedInstallId: text("resolved_install_id"),
  resolutionReason: text("resolution_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InstalledExtensionRow = typeof installedExtensionTable.$inferSelect;
export type ExtensionDependencyEdgeRow = typeof extensionDependencyEdgeTable.$inferSelect;

function edgeRowToResolved(row: ExtensionDependencyEdgeRow): ResolvedDependencyEdge {
  return {
    packageName: row.declaredPackageName,
    ...(row.declaredKind ? { kind: row.declaredKind as ExtensionKind } : {}),
    edgeType: row.edgeType as DependencyEdgeType,
    versionConstraint: row.versionConstraint as VersionConstraint,
    requirement: row.requirement as DependencyRequirement,
    resolvedInstallId: row.resolvedInstallId,
    resolutionReason: row.resolutionReason,
  };
}

function rowToCanonical(
  row: InstalledExtensionRow,
  edges: readonly ResolvedDependencyEdge[],
): InstalledExtension {
  return {
    id: row.id,
    packageName: row.packageName,
    ownerLevel: row.ownerLevel as ExtensionOwnerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    kind: row.kind as ExtensionKind,
    status: row.status as ExtensionLifecycleStatus,
    source: row.source as ExtensionSource,
    version: row.version,
    isDefault: row.isDefault,
    requiredInProd: row.requiredInProd,
    // `dependencies` is the DECLARED projection of the hydrated edges — every
    // pre-#1040-S2 consumer keeps reading the exact shape it always did.
    dependencies: edges.map(
      ({ resolvedInstallId: _r, resolutionReason: _w, ...declared }) => declared,
    ),
    dependencyEdges: [...edges],
    manifestHash: row.manifestHash ?? null,
    accessDeclaration:
      (row.accessDeclaration as InstalledExtension["accessDeclaration"]) ?? null,
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
  return drizzle(pool, { schema: { installedExtensionTable, extensionDependencyEdgeTable } });
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

// The drizzle handle both the module-level db and a transaction expose.
type CanonicalDbLike = Pick<CanonicalDb, "select" | "insert" | "update" | "delete">;

/**
 * Hydrate canonical rows with their persisted dependency edges (cinatra#1040
 * S2) — ONE batched IN query per read call, grouped by dependent, declared
 * order. EVERY reader and EVERY mutation return flows through here so a
 * canonical `InstalledExtension` always carries `dependencyEdges` + the
 * derived `dependencies` projection.
 */
async function hydrateInstalledRows(
  db: CanonicalDbLike,
  rows: InstalledExtensionRow[],
): Promise<InstalledExtension[]> {
  if (rows.length === 0) return [];
  const edgeRows = await db
    .select()
    .from(extensionDependencyEdgeTable)
    .where(
      inArray(
        extensionDependencyEdgeTable.dependentInstallId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(
      asc(extensionDependencyEdgeTable.declaredIndex),
      asc(extensionDependencyEdgeTable.id),
    );
  const byDependent = new Map<string, ResolvedDependencyEdge[]>();
  for (const e of edgeRows) {
    const bucket = byDependent.get(e.dependentInstallId);
    const resolved = edgeRowToResolved(e);
    if (bucket) bucket.push(resolved);
    else byDependent.set(e.dependentInstallId, [resolved]);
  }
  return rows.map((r) => rowToCanonical(r, byDependent.get(r.id) ?? []));
}

async function hydrateSingleRow(
  db: CanonicalDbLike,
  row: InstalledExtensionRow,
): Promise<InstalledExtension> {
  const [hydrated] = await hydrateInstalledRows(db, [row]);
  return hydrated!;
}

/**
 * Resolve declared edges against the CURRENT live rows for persistence
 * (cinatra#1040 S2) — the single write-time resolution rule, mirrored by the
 * core__0025 backfill and by the closure engine's name-lookup fallback:
 * the DECLARING row's own-org live (active|locked) row first, then the
 * platform row (a platform-scoped dependent binds only platform rows);
 * within a scope prefer the DEFAULT version, then deterministic id order.
 * A missing target persists unresolved (`resolvedInstallId: null`) — the
 * closure gates' name-fallback keeps "dependency installed later heals the
 * closure" semantics.
 */
async function resolveDeclaredEdges(
  db: CanonicalDbLike,
  dependencies: readonly ExtensionDependency[],
  organizationId: string | null,
): Promise<ResolvedDependencyEdge[]> {
  const names = [...new Set(dependencies.map((d) => d.packageName))];
  if (names.length === 0) return [];
  const candidates = await db
    .select()
    .from(installedExtensionTable)
    .where(
      and(
        inArray(installedExtensionTable.packageName, names),
        inArray(installedExtensionTable.status, ["active", "locked"]),
      ),
    );
  const pickInScope = (name: string, scopeOrg: string | null) => {
    const inScope = candidates
      .filter(
        (c) =>
          c.packageName === name &&
          (scopeOrg === null ? c.organizationId === null : c.organizationId === scopeOrg),
      )
      .sort((a, b) =>
        a.isDefault === b.isDefault ? (a.id < b.id ? -1 : 1) : a.isDefault ? -1 : 1,
      );
    return inScope[0];
  };
  return dependencies.map((dep) => {
    const orgPick = organizationId != null ? pickInScope(dep.packageName, organizationId) : undefined;
    const pick = orgPick ?? pickInScope(dep.packageName, null);
    return {
      ...dep,
      resolvedInstallId: pick?.id ?? null,
      resolutionReason: pick ? (orgPick ? "scoped:org" : "scoped:platform") : null,
    };
  });
}

function newEdgeId(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return `iede_${randomUUID()}`;
}

/**
 * REPLACE a dependent's persisted edges (delete + insert, declared order),
 * re-resolving each declared edge at write time. Runs INSIDE the caller's
 * transaction; the CALLER must already hold the dependent's ROW LOCK (both
 * callers do: the insert path created the row in this transaction, the
 * metadata path UPDATEd it first), which serializes concurrent replaces for
 * one row and makes row write + edge replacement + hydrated return ONE atomic
 * unit (a failed edge write can never leave a committed row without its
 * declared edges). Deliberately NO extra `FOR UPDATE` here: upgrading the
 * caller's ordinary (non-key) UPDATE lock to the strongest row lock would
 * CONFLICT with the FK `KEY SHARE` locks concurrent edge inserts take on
 * their resolution targets — two mutually-dependent replaces could deadlock
 * (codex round-2). The non-key lock the callers already hold is compatible
 * with `KEY SHARE`.
 */
async function replaceDependencyEdgesInTx(
  tx: CanonicalDbLike,
  dependentId: string,
  dependencies: readonly ExtensionDependency[],
  organizationId: string | null,
): Promise<void> {
  const resolved = await resolveDeclaredEdges(tx, dependencies, organizationId);
  await tx
    .delete(extensionDependencyEdgeTable)
    .where(eq(extensionDependencyEdgeTable.dependentInstallId, dependentId));
  if (resolved.length > 0) {
    await tx.insert(extensionDependencyEdgeTable).values(
      resolved.map((edge, index) => ({
        id: newEdgeId(),
        dependentInstallId: dependentId,
        declaredPackageName: edge.packageName,
        declaredKind: edge.kind ?? null,
        edgeType: edge.edgeType,
        requirement: edge.requirement,
        versionConstraint: edge.versionConstraint as unknown,
        declaredIndex: index,
        resolvedInstallId: edge.resolvedInstallId,
        resolutionReason: edge.resolutionReason,
      })),
    );
  }
}

export async function readInstalledExtensionById(id: string): Promise<InstalledExtension | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(eq(installedExtensionTable.id, id))
    .limit(1);
  return rows[0] ? hydrateSingleRow(db, rows[0]) : null;
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
  return rows[0] ? hydrateSingleRow(db, rows[0]) : null;
}

export async function readInstalledExtensionsByPackageName(
  packageName: string,
): Promise<InstalledExtension[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(eq(installedExtensionTable.packageName, packageName));
  return hydrateInstalledRows(db, rows);
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
  const rows = await db
    .select()
    .from(installedExtensionTable)
    .where(inArray(installedExtensionTable.packageName, [...packageNames]));
  for (const canonical of await hydrateInstalledRows(db, rows)) {
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
  return hydrateInstalledRows(db, rows);
}

/**
 * Derive the storage `version` from a source when the writer did not supply one
 * (cinatra#1040 S1). Mirrors the core__0022 backfill: verdaccio / bundled
 * sources carry `version`; github / local sources carry none, so they floor to
 * `0.0.0`. Keeping the derivation here means existing install-row writers do NOT
 * have to thread version through — the version-aware write path (a writer that
 * chooses version + default explicitly) is a later slice.
 */
function deriveVersionFromSource(source: ExtensionSource): string {
  const v = (source as { version?: unknown }).version;
  return typeof v === "string" && v.length > 0 ? v : "0.0.0";
}

// Internal — used only by the lifecycle primitive. Static checks prevent
// other callers from importing these functions.
export async function _internalInsertInstalledExtension(
  // version / isDefault are OPTIONAL on the input (cinatra#1040 S1): the store
  // derives version from the source and defaults isDefault to true, matching the
  // DB column defaults, so no existing install-row writer has to supply them.
  row: Omit<
    InstalledExtension,
    "createdAt" | "updatedAt" | "version" | "isDefault" | "dependencyEdges"
  > & {
    version?: string;
    isDefault?: boolean;
  },
): Promise<InstalledExtension> {
  const db = await getDb();
  const ownerId = platformizeOwnerId(row.ownerLevel, row.ownerId);
  // ONE transaction for row + edges + hydrated return (cinatra#1040 S2): a
  // failed edge write rolls the row back too, and the returned shape can never
  // interleave with a concurrent replace.
  return db.transaction(async (tx) => {
    const result = await tx
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
        version: row.version ?? deriveVersionFromSource(row.source),
        isDefault: row.isDefault ?? true,
        requiredInProd: row.requiredInProd,
        manifestHash: row.manifestHash,
      })
      .returning();
    if (!result[0]) throw new Error("installed_extension insert returned no row");
    // Dependency edges are FIRST-CLASS rows since cinatra#1040 S2. Most install
    // writers seed `dependencies: []` (the finalize seam records the real edges
    // via recordExtensionDependencies); a writer that DOES carry edges persists
    // them here with write-time resolution.
    if (row.dependencies.length > 0) {
      await replaceDependencyEdgesInTx(tx, result[0].id, row.dependencies, result[0].organizationId);
    }
    return hydrateSingleRow(tx, result[0]);
  });
}

export async function _internalUpdateInstalledExtensionStatus(
  id: string,
  status: ExtensionLifecycleStatus,
): Promise<InstalledExtension> {
  const db = await getDb();
  // Update + hydration in one transaction: the returned edges are the ones
  // consistent with this write, never a concurrent replace's intermediate.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(installedExtensionTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(installedExtensionTable.id, id))
      .returning();
    if (!result[0]) throw new Error(`installed_extension ${id} not found for status update`);
    return hydrateSingleRow(tx, result[0]);
  });
}

export async function _internalUpdateInstalledExtensionSource(
  id: string,
  source: ExtensionSource,
): Promise<InstalledExtension> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const result = await tx
      .update(installedExtensionTable)
      .set({ source: source as unknown, updatedAt: new Date() })
      .where(eq(installedExtensionTable.id, id))
      .returning();
    if (!result[0]) throw new Error(`installed_extension ${id} not found for source update`);
    return hydrateSingleRow(tx, result[0]);
  });
}

export async function _internalUpdateInstalledExtensionMetadata(
  id: string,
  patch: {
    dependencies?: ExtensionDependency[];
    requiredInProd?: boolean;
    manifestHash?: string | null;
    accessDeclaration?: InstalledExtension["accessDeclaration"];
  },
): Promise<InstalledExtension> {
  const db = await getDb();
  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.requiredInProd !== undefined) setClause.requiredInProd = patch.requiredInProd;
  if (patch.manifestHash !== undefined) setClause.manifestHash = patch.manifestHash;
  if (patch.accessDeclaration !== undefined) setClause.accessDeclaration = patch.accessDeclaration;
  // ONE transaction for the row patch + edge replacement + hydrated return
  // (cinatra#1040 S2): a failed edge write rolls the metadata patch back too.
  return db.transaction(async (tx) => {
    const result = await tx
      .update(installedExtensionTable)
      .set(setClause)
      .where(eq(installedExtensionTable.id, id))
      .returning();
    if (!result[0]) throw new Error(`installed_extension ${id} not found for metadata update`);
    // A dependencies patch REPLACES the persisted edge rows (declared order,
    // write-time resolution) — cinatra#1040 S2.
    if (patch.dependencies !== undefined) {
      await replaceDependencyEdgesInTx(tx, id, patch.dependencies, result[0].organizationId);
    }
    return hydrateSingleRow(tx, result[0]);
  });
}

export async function _internalDeleteInstalledExtension(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(installedExtensionTable).where(eq(installedExtensionTable.id, id));
}
