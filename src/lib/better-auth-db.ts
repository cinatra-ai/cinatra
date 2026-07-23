import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import {
  withAssistantNamespaceLock,
  nextFreeSuffixedCandidate,
} from "@/lib/assistant-namespace-lock";
import { ASSISTANT_AUDIENCE_SUBJECT_KINDS } from "@/lib/assistant-registry-schema";
import { toPgTextArrayLiteral } from "@/lib/pg-array";
import { projectsDb, projects } from "@/lib/projects-store";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, pgSchema, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { Pool } from "pg";

declare global {
  var __cinatraBetterAuthPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
//
// The idle-error listener (registered at pool creation) keeps the process alive
// when Supabase drops idle connections: pg.Pool emits 'error' on an unexpected
// backend disconnect, which Node.js otherwise treats as an uncaught exception.
let betterAuthPoolInstance: Pool | undefined;
function getBetterAuthPool(): Pool {
  if (betterAuthPoolInstance) return betterAuthPoolInstance;
  if (globalThis.__cinatraBetterAuthPool) {
    return (betterAuthPoolInstance = globalThis.__cinatraBetterAuthPool);
  }
  const databaseUrl = process.env.SUPABASE_DB_URL;
  if (!databaseUrl) {
    throw new Error("Missing SUPABASE_DB_URL. Better Auth requires the Postgres database connection.");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[better-auth] pg pool idle client error:", err.message);
    });
  }
  betterAuthPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraBetterAuthPool = pool;
  }
  return pool;
}

function createBetterAuthDb() {
  return drizzle(getBetterAuthPool());
}
let betterAuthDbInstance: ReturnType<typeof createBetterAuthDb> | undefined;
function getBetterAuthDb(): ReturnType<typeof createBetterAuthDb> {
  return (betterAuthDbInstance ??= createBetterAuthDb());
}

// `betterAuthPool` is passed to `betterAuth({ database })`, whose adapter
// detection shape-checks the value (instanceof / `"query" in` / `constructor`).
// This lazy proxy answers those shape checks from `Pool.prototype` WITHOUT
// creating the pool — so importing this module, and constructing the Better
// Auth instance at build time, never reads SUPABASE_DB_URL. The real pool is
// created only when a method is actually invoked (first query), at which point
// the idle-error listener and global cache are wired up.
export const betterAuthPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    if (prop === "constructor") return Pool;
    const target: any = getBetterAuthPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(_t, prop) {
    return prop === "constructor" || prop in Pool.prototype;
  },
  getPrototypeOf() {
    return Pool.prototype;
  },
});

// `betterAuthDb` is only used for direct drizzle queries (never passed to an
// adapter), so a get-trap proxy that binds methods to the real db suffices.
export const betterAuthDb: ReturnType<typeof createBetterAuthDb> = new Proxy(
  {} as ReturnType<typeof createBetterAuthDb>,
  {
    get(_t, prop) {
      const target: any = getBetterAuthDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

export const betterAuthUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  username: text("username"),
  role: text("role"),
  image: text("image"),
  userType: text("userType"),
  clientId: text("clientId"),
  accentColor: text("accent_color"),
});

// ---------------------------------------------------------------------------
// Assistant handle registry (cinatra#1037 P1.2 / P5.1 substrate).
//
// `assistant_handles` is a CORE-STORE table (created by the bootstrap DDL
// `assistantHandleSchemaQueries` + migration core__0046), so it lives in the core
// schema (SUPABASE_SCHEMA, default "cinatra") — NOT the Better Auth `public`
// schema that owns `user`. Both are in the SAME database (Better Auth and the
// core store share SUPABASE_DB_URL), so `betterAuthDb` — bound to that one
// connection — reaches the registry via a schema-qualified drizzle table. The
// schema name is read from the environment INLINE (this module deliberately reads
// SUPABASE_DB_URL directly rather than importing @/lib/postgres-config; mirroring
// that keeps the import graph unchanged). Evaluated at import: with no env it
// falls back to "cinatra" and constructs no connection (safe for `next build`).
const CORE_STORE_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const coreStoreSchema = pgSchema(CORE_STORE_SCHEMA);

/** The platform-unique assistant handle registry (schema-qualified to the core
 * store). One row per assistant principal; `handle` is UNIQUE. */
export const assistantHandles = coreStoreSchema.table("assistant_handles", {
  assistantUserId: text("assistant_user_id").primaryKey(),
  handle: text("handle").notNull(),
  isOverride: boolean("is_override").notNull().default(false),
  // cinatra#1874 W1: origin ('extension'|'standalone') distinguishes an
  // extension-adopted principal from a boot-seeded/standalone one;
  // packageName links the handle to the owning package (nullable).
  origin: text("origin").notNull().default("standalone"),
  packageName: text("package_name"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
});

/** Platform-global flat-token alias registry (cinatra#1874 W1). `alias` is the
 *  PK (normalized flat token); every write flows through the namespace primitive
 *  under the advisory lock. */
export const assistantTagAlias = coreStoreSchema.table("assistant_tag_alias", {
  alias: text("alias").primaryKey(),
  packageName: text("package_name").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
});

/** Install-time audience grants (cinatra#1874 W1). One row per granted subject;
 *  subject_kind ∈ CONNECTOR_ACCESS_SCOPES∖user; subject_id NULL for the global
 *  kinds (workspace/admin). */
export const assistantAudience = coreStoreSchema.table("assistant_audience", {
  id: text("id"),
  packageName: text("package_name").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: text("subject_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
});

/** Installation-wide assistant PAUSE (cinatra#1880 W5). One row per PAUSED
 *  assistant principal (`assistant_user_id` PK — the SAME axis f9f70d26a keys the
 *  builtin host on, so a handle/alias rename never loses or retargets a pause).
 *  Presence == paused; a paused principal drops out of the audience-filtered
 *  registry reader (fail-closed, enforced across every W2 surface). */
export const assistantPause = coreStoreSchema.table("assistant_pause", {
  assistantUserId: text("assistant_user_id").primaryKey(),
  pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
  pausedBy: text("paused_by"),
});

/**
 * Normalize a raw string into a mention handle: lowercase, spaces→`_`, strip any
 * char outside [a-z0-9_-], trim leading/trailing `[_-]`. Returns `null` when
 * nothing survives (an all-symbol/empty source has no valid handle). This is the
 * SINGLE normalizer for the registry — it supersedes the ad-hoc `toHandle` slug
 * that `/api/assistants/list` derived on the fly, and it is the one normalizer
 * both the boot backfill and the create-time mint route through, so every handle
 * for a given username is derived identically.
 */
export function normalizeAssistantHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const h = raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+|[_-]+$/g, "");
  return h.length > 0 ? h : null;
}

export type AssistantHandleOrigin = "extension" | "standalone";

/** Collision error thrown by the exact-token claim paths (aliases /
 *  preferredTag): the requested token is already owned in the namespace. The
 *  standalone-mint path suffixes instead of throwing. */
export class AssistantNamespaceCollisionError extends Error {
  constructor(
    public readonly token: string,
    public readonly ownedBy: "handle" | "alias",
  ) {
    super(`[assistant-namespace] token "${token}" is already claimed as a ${ownedBy}`);
    this.name = "AssistantNamespaceCollisionError";
  }
}

// A structural view of the drizzle tx we need for the namespace reads/writes —
// avoids naming the heavy drizzle transaction type.
type NamespaceTx = Pick<typeof betterAuthDb, "select" | "insert" | "update" | "delete">;

/** Is `token` free across BOTH namespace tables? Must run inside the advisory
 *  lock (the caller holds it) so the read is race-free. Returns the owning table
 *  when taken, else null. */
async function tokenOwner(tx: NamespaceTx, token: string): Promise<"handle" | "alias" | null> {
  const handleHit = await tx
    .select({ token: assistantHandles.handle })
    .from(assistantHandles)
    .where(eq(assistantHandles.handle, token))
    .limit(1);
  if (handleHit[0]) return "handle";
  const aliasHit = await tx
    .select({ token: assistantTagAlias.alias })
    .from(assistantTagAlias)
    .where(eq(assistantTagAlias.alias, token))
    .limit(1);
  if (aliasHit[0]) return "alias";
  return null;
}

/**
 * Register (mint) a platform-unique handle for an assistant principal, idempotent
 * and collision-safe — routed through the ONE advisory-locked namespace primitive
 * (cinatra#1874 W1) so the mint checks BOTH the handles and the alias tables and
 * serializes against every other flat-token write. If the principal already has a
 * handle, returns it unchanged. Otherwise normalizes `desired` (or `override`)
 * into a base and claims the first free candidate in the deterministic sequence
 * `base`, `base-2`, `base-3`, …, skipping any candidate taken by another handle
 * OR an alias (cross-table-correct). Returns the claimed handle, or `null` when
 * `desired` normalizes to nothing. `origin` (default 'standalone') + `packageName`
 * are persisted on the row.
 */
export async function registerAssistantHandle(
  assistantUserId: string,
  opts: {
    desired: string | null | undefined;
    override?: boolean;
    origin?: AssistantHandleOrigin;
    packageName?: string | null;
  },
): Promise<string | null> {
  const base = normalizeAssistantHandle(opts.desired);
  const override = opts.override ?? false;
  const origin: AssistantHandleOrigin = opts.origin ?? "standalone";
  const packageName = opts.packageName ?? null;

  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    // Idempotent: a principal keeps its first handle.
    const existing = await tx
      .select({ handle: assistantHandles.handle })
      .from(assistantHandles)
      .where(eq(assistantHandles.assistantUserId, assistantUserId))
      .limit(1);
    if (existing[0]) return existing[0].handle;
    if (!base) return null;

    // Gather the taken tokens in the candidate space (base, base-2 … base-1000)
    // across BOTH tables, then pick the first free suffix (pure).
    const candidates: string[] = [base];
    for (let i = 1; i < 1000; i++) candidates.push(`${base}-${i + 1}`);
    const takenHandles = await tx
      .select({ token: assistantHandles.handle })
      .from(assistantHandles)
      .where(inArray(assistantHandles.handle, candidates));
    const takenAliases = await tx
      .select({ token: assistantTagAlias.alias })
      .from(assistantTagAlias)
      .where(inArray(assistantTagAlias.alias, candidates));
    const taken = new Set<string>([...takenHandles, ...takenAliases].map((r) => r.token));

    const candidate = nextFreeSuffixedCandidate(base, taken);
    if (!candidate) return null;

    await tx.insert(assistantHandles).values({
      assistantUserId,
      handle: candidate,
      isOverride: override,
      origin,
      packageName,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return candidate;
  });
}

/**
 * Rename a principal's handle by its STABLE primary key (assistant_user_id) —
 * `UPDATE … WHERE assistant_user_id=` under the namespace lock, collision-checked
 * against BOTH tables (cinatra#1874 W1: the handle is mutable, the PK stable;
 * `registerAssistantHandle` cannot rename). The desired handle is normalized;
 * a collision (another handle OR an alias owns it) throws
 * {@link AssistantNamespaceCollisionError}. Returns the new handle, or `null`
 * when the principal has no row or `desired` normalizes to nothing.
 */
export async function renameAssistantHandleByPrincipal(
  assistantUserId: string,
  desired: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeAssistantHandle(desired);
  if (!normalized) return null;
  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    const current = await tx
      .select({ handle: assistantHandles.handle })
      .from(assistantHandles)
      .where(eq(assistantHandles.assistantUserId, assistantUserId))
      .limit(1);
    if (!current[0]) return null;
    if (current[0].handle === normalized) return normalized; // no-op rename
    const owner = await tokenOwner(tx, normalized);
    if (owner) throw new AssistantNamespaceCollisionError(normalized, owner);
    await tx
      .update(assistantHandles)
      .set({ handle: normalized, isOverride: true, updatedAt: new Date() })
      .where(eq(assistantHandles.assistantUserId, assistantUserId));
    return normalized;
  });
}

/**
 * Claim / relocate a platform-global tag alias (cinatra#1874 W1) under the
 * namespace lock, checking BOTH tables. Inline-fails on a collision with a
 * handle or a DIFFERENT-package alias; a builtin alias is immutable (never
 * relocated). `alias` must already be a normalized flat token.
 */
export async function claimAssistantAlias(
  alias: string,
  packageName: string,
  source: "manifest" | "admin",
): Promise<void> {
  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    const existing = await tx
      .select({ packageName: assistantTagAlias.packageName, source: assistantTagAlias.source })
      .from(assistantTagAlias)
      .where(eq(assistantTagAlias.alias, alias))
      .limit(1);
    if (existing[0]) {
      if (existing[0].source === "builtin") {
        throw new AssistantNamespaceCollisionError(alias, "alias");
      }
      // Re-point an existing (non-builtin) alias to the requested package.
      await tx
        .update(assistantTagAlias)
        .set({ packageName, source, updatedAt: new Date() })
        .where(eq(assistantTagAlias.alias, alias));
      return;
    }
    // Free in the alias table — but must also be free of any handle.
    const handleRow = await tx
      .select({ handle: assistantHandles.handle })
      .from(assistantHandles)
      .where(eq(assistantHandles.handle, alias))
      .limit(1);
    if (handleRow[0]) throw new AssistantNamespaceCollisionError(alias, "handle");
    await tx
      .insert(assistantTagAlias)
      .values({ alias, packageName, source, createdAt: new Date(), updatedAt: new Date() });
  });
}

/**
 * EXCLUSIVE admin alias claim (cinatra#1880 W5 AC#1) — the strict counterpart of
 * `claimAssistantAlias` for the admin editor's "add tag" path. It NEVER silently
 * relocates a token another package owns: under the namespace lock it
 *   - throws {@link AssistantNamespaceCollisionError} (naming the owning table) if
 *     the token is a builtin alias, a DIFFERENT package's alias, or a handle;
 *   - is an idempotent no-op if THIS package already owns the alias;
 *   - inserts a fresh `source='admin'` row when the token is free.
 * `alias` must already be a normalized flat token. (The relocate-tolerant
 * `claimAssistantAlias` stays for the W1 manifest install path — unchanged.)
 */
export async function claimAssistantAliasExclusive(
  alias: string,
  packageName: string,
): Promise<void> {
  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    const existing = await tx
      .select({ packageName: assistantTagAlias.packageName, source: assistantTagAlias.source })
      .from(assistantTagAlias)
      .where(eq(assistantTagAlias.alias, alias))
      .limit(1);
    if (existing[0]) {
      // Builtin or a different package owns it → conflict (no silent steal).
      if (existing[0].source === "builtin" || existing[0].packageName !== packageName) {
        throw new AssistantNamespaceCollisionError(alias, "alias");
      }
      return; // this package already owns it → idempotent
    }
    const handleRow = await tx
      .select({ handle: assistantHandles.handle })
      .from(assistantHandles)
      .where(eq(assistantHandles.handle, alias))
      .limit(1);
    if (handleRow[0]) throw new AssistantNamespaceCollisionError(alias, "handle");
    await tx
      .insert(assistantTagAlias)
      .values({ alias, packageName, source: "admin", createdAt: new Date(), updatedAt: new Date() });
  });
}

/** Remove a non-builtin alias under the lock. A builtin alias is immutable. When
 *  `packageName` is supplied the delete is SCOPED to that owning package
 *  (cinatra#1880 W5) — a defense-in-depth check so one assistant's editor can
 *  never remove another package's alias. */
export async function removeAssistantAlias(alias: string, packageName?: string): Promise<void> {
  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    const where = packageName
      ? and(
          eq(assistantTagAlias.alias, alias),
          ne(assistantTagAlias.source, "builtin"),
          eq(assistantTagAlias.packageName, packageName),
        )
      : and(eq(assistantTagAlias.alias, alias), ne(assistantTagAlias.source, "builtin"));
    await tx.delete(assistantTagAlias).where(where);
  });
}

/**
 * Atomically RENAME an admin alias (cinatra#1880 W5 AC#1): free `oldAlias` and
 * claim `newAlias` for `packageName` in ONE namespace-lock transaction, so the
 * rename is race-free and never leaves a half-applied gap. A builtin alias is
 * immutable — renaming FROM a builtin throws (its row is source='builtin'). The
 * destination is collision-checked against BOTH tables: a handle or a different
 * package's alias owning `newAlias` throws {@link AssistantNamespaceCollisionError}
 * (naming the conflicting table) and the whole transaction rolls back, so
 * `oldAlias` survives. A no-op rename (old == new) returns without touching rows.
 * Both tokens must already be normalized flat tokens (the caller validates).
 */
export async function renameAssistantAlias(
  oldAlias: string,
  newAlias: string,
  packageName: string,
): Promise<void> {
  return withAssistantNamespaceLock(betterAuthDb, async (tx) => {
    const existing = await tx
      .select({ packageName: assistantTagAlias.packageName, source: assistantTagAlias.source })
      .from(assistantTagAlias)
      .where(eq(assistantTagAlias.alias, oldAlias))
      .limit(1);
    if (!existing[0]) throw new Error(`[assistant-namespace] alias "${oldAlias}" does not exist`);
    if (existing[0].source === "builtin") {
      // The builtin alias is immutable — never renamed.
      throw new AssistantNamespaceCollisionError(oldAlias, "alias");
    }
    // Defense-in-depth (cinatra#1880 W5): the rename may only re-key an alias the
    // SUPPLIED package owns — one assistant's editor can never retarget another
    // package's alias.
    if (existing[0].packageName !== packageName) {
      throw new AssistantNamespaceCollisionError(oldAlias, "alias");
    }
    if (oldAlias === newAlias) return; // no-op
    // Destination must be free across BOTH tables.
    const owner = await tokenOwner(tx, newAlias);
    if (owner) throw new AssistantNamespaceCollisionError(newAlias, owner);
    await tx.delete(assistantTagAlias).where(eq(assistantTagAlias.alias, oldAlias));
    await tx
      .insert(assistantTagAlias)
      .values({ alias: newAlias, packageName, source: "admin", createdAt: new Date(), updatedAt: new Date() });
  });
}

// ---------------------------------------------------------------------------
// Audience grant writers (cinatra#1880 W5 — the audience editor). The W1 reader
// (`readAssistantRegistryForActor`) is the SINGLE consumer/enforcement point, so
// an added/removed grant takes effect on the NEXT authorization decision across
// every W2 surface (browser routing, MCP entry/continuation, widget broker) with
// no second enforcement path to keep in sync. Fail-CLOSED by construction: an
// unknown subject kind is rejected at the writer (never persisted), and removing
// the last grant leaves the assistant invisible to everyone (the matcher denies
// an empty grant set) — except the always-visible builtin.
// ---------------------------------------------------------------------------

/** The audience subject kinds that carry NO subject id (global grants). */
const GLOBAL_AUDIENCE_KINDS: ReadonlySet<string> = new Set(["workspace", "admin"]);

/** Advisory-lock CLASS id for the package-scoped audience set-replace lock
 *  (`pg_advisory_xact_lock(class, hashtext(package))`). A two-int key in its own
 *  class, distinct from the single-key assistant namespace lock's space. */
const ASSISTANT_AUDIENCE_LOCK_CLASS = 0x41554449; // "AUDI"

/** Validate + normalize an audience grant tuple, throwing on an unknown kind or a
 *  missing/extra subject id (fail-closed — a malformed grant is never persisted). */
function validateAudienceGrant(
  subjectKind: string,
  subjectId: string | null | undefined,
): { subjectKind: string; subjectId: string | null } {
  if (!ASSISTANT_AUDIENCE_SUBJECT_KINDS.includes(subjectKind as never)) {
    throw new Error(`[assistant-audience] unknown subject kind: ${subjectKind}`);
  }
  const isGlobal = GLOBAL_AUDIENCE_KINDS.has(subjectKind);
  const id = typeof subjectId === "string" ? subjectId.trim() : "";
  if (isGlobal) {
    // workspace/admin carry no id — a stray id is dropped (normalized to null).
    return { subjectKind, subjectId: null };
  }
  if (!id) {
    throw new Error(`[assistant-audience] subject kind "${subjectKind}" requires a subject id`);
  }
  return { subjectKind, subjectId: id };
}

/** Add an audience grant `(package, kind, id?)`. Idempotent (ON CONFLICT DO
 *  NOTHING against the grant-uniqueness index). Validated fail-closed. */
export async function addAssistantAudienceGrant(
  packageName: string,
  subjectKind: string,
  subjectId?: string | null,
): Promise<void> {
  const g = validateAudienceGrant(subjectKind, subjectId);
  await betterAuthDb
    .insert(assistantAudience)
    .values({ packageName, subjectKind: g.subjectKind, subjectId: g.subjectId, createdAt: new Date() })
    .onConflictDoNothing();
}

/** Remove an audience grant `(package, kind, id?)`. A global kind matches the
 *  NULL-id row; a scoped kind matches its exact id. */
export async function removeAssistantAudienceGrant(
  packageName: string,
  subjectKind: string,
  subjectId?: string | null,
): Promise<void> {
  const g = validateAudienceGrant(subjectKind, subjectId);
  await betterAuthDb
    .delete(assistantAudience)
    .where(
      and(
        eq(assistantAudience.packageName, packageName),
        eq(assistantAudience.subjectKind, g.subjectKind),
        g.subjectId === null
          ? isNull(assistantAudience.subjectId)
          : eq(assistantAudience.subjectId, g.subjectId),
      ),
    );
}

/** List an assistant package's audience grants (for the editor display). */
export async function listAssistantAudienceGrants(
  packageName: string,
): Promise<Array<{ subjectKind: string; subjectId: string | null }>> {
  const rows = await betterAuthDb
    .select({ subjectKind: assistantAudience.subjectKind, subjectId: assistantAudience.subjectId })
    .from(assistantAudience)
    .where(eq(assistantAudience.packageName, packageName));
  return rows;
}

/**
 * ATOMIC replace of a package's audience grant SET (cinatra#1880 W5 rework — owner
 * ruling 2026-07-23 (groganz): the audience editor is the shipped access picker,
 * which submits the full selection as a set). Every desired grant is validated
 * fail-closed FIRST (an unknown kind / missing subject id aborts the whole replace
 * — nothing is deleted, nothing inserted); then, in ONE transaction, the package's
 * current grants are deleted and the desired set inserted. So a multi-grant edit is
 * all-or-nothing — a mid-write failure rolls back rather than leaving a partial /
 * fail-open ACL — and it takes effect on the next reader decision through the ONE
 * audience truth. An EMPTY `grants` set clears the audience (visible to no one —
 * fail-closed). Idempotent on the grant-uniqueness index.
 */
export async function replaceAssistantAudienceGrants(
  packageName: string,
  grants: ReadonlyArray<{ subjectKind: string; subjectId?: string | null }>,
): Promise<void> {
  // Validate BEFORE opening the transaction: one malformed grant refuses the
  // entire replace (the current grant set is left untouched).
  const validated = grants.map((g) => validateAudienceGrant(g.subjectKind, g.subjectId));
  await betterAuthDb.transaction(async (tx) => {
    // Serialize concurrent replaces for the SAME package: a PACKAGE-scoped advisory
    // xact lock (its own two-int lock class, so it never collides with the
    // single-key namespace lock, and different packages never block each other),
    // released automatically on commit/rollback. Without it, two simultaneous
    // delete-all→insert replaces could interleave under READ COMMITTED into a union
    // of both desired sets or a fail-open ACL (a concurrent narrow/empty replace
    // missing the other's just-inserted rows). Mirrors `acquireAssistantNamespaceLock`.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ASSISTANT_AUDIENCE_LOCK_CLASS}, hashtext(${packageName}))`,
    );
    await tx.delete(assistantAudience).where(eq(assistantAudience.packageName, packageName));
    for (const g of validated) {
      await tx
        .insert(assistantAudience)
        .values({ packageName, subjectKind: g.subjectKind, subjectId: g.subjectId, createdAt: new Date() })
        .onConflictDoNothing();
    }
  });
}

// ---------------------------------------------------------------------------
// Assistant PAUSE writers/readers (cinatra#1880 W5 — the pause control). Keyed by
// the assistant PRINCIPAL (`assistant_user_id`) — the SAME axis f9f70d26a keys the
// builtin host on, so a handle/alias rename never loses or retargets a pause.
// A paused principal drops out of the registry reader (fail-closed) → unaddressable
// on every W2 surface. The builtin is refused here (defense-in-depth; the reader
// also never drops it).
// ---------------------------------------------------------------------------

/** Pause an assistant principal (installation-wide). Idempotent — re-pausing
 *  refreshes `paused_at`/`paused_by`. */
export async function pauseAssistant(assistantUserId: string, pausedBy?: string | null): Promise<void> {
  await betterAuthDb
    .insert(assistantPause)
    .values({ assistantUserId, pausedAt: new Date(), pausedBy: pausedBy ?? null })
    .onConflictDoUpdate({
      target: assistantPause.assistantUserId,
      set: { pausedAt: new Date(), pausedBy: pausedBy ?? null },
    });
}

/** Resume (un-pause) an assistant principal. Idempotent. */
export async function resumeAssistant(assistantUserId: string): Promise<void> {
  await betterAuthDb.delete(assistantPause).where(eq(assistantPause.assistantUserId, assistantUserId));
}

/** The set of PAUSED assistant principal ids among `ids` (empty input → empty
 *  set). Used by the registry reader to fail-close paused principals. */
export async function listPausedAssistantIds(ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => !!id))];
  if (unique.length === 0) return new Set();
  const rows = await betterAuthDb
    .select({ id: assistantPause.assistantUserId })
    .from(assistantPause)
    .where(inArray(assistantPause.assistantUserId, unique));
  return new Set(rows.map((r) => r.id));
}

/**
 * Resolve mention handles → assistant principal ids via the registry. Returns a
 * `handle → assistantUserId` map for the subset that resolve (case-insensitive:
 * handles are stored already-normalized/lowercased). This is the authoritative
 * resolver — the registry only ever holds assistant principals, so a hit IS a
 * mentionable assistant (no separate userType filter needed).
 */
export async function resolveAssistantHandles(
  handles: string[],
): Promise<Map<string, string>> {
  if (handles.length === 0) return new Map();
  const wanted = Array.from(new Set(handles.map((h) => h.toLowerCase())));
  const rows = await betterAuthDb
    .select({ handle: assistantHandles.handle, id: assistantHandles.assistantUserId })
    .from(assistantHandles)
    .where(inArray(assistantHandles.handle, wanted));
  return new Map(rows.map((r) => [r.handle, r.id]));
}

/**
 * Reverse lookup: assistant principal ids → their registry handles. Returns an
 * `assistantUserId → handle` map for the subset registered.
 */
export async function lookupAssistantHandlesByIds(
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const wanted = Array.from(new Set(ids));
  const rows = await betterAuthDb
    .select({ handle: assistantHandles.handle, id: assistantHandles.assistantUserId })
    .from(assistantHandles)
    .where(inArray(assistantHandles.assistantUserId, wanted));
  return new Map(rows.map((r) => [r.id, r.handle]));
}

/**
 * Self-healing boot backfill: the SOLE handle populator (the migration is
 * structural). Mints a registry handle for every assistant principal that lacks
 * one (a LEFT JOIN of `public."user"` against the core-schema registry on the
 * shared connection) and PRUNES orphan rows whose principal no longer exists as
 * an assistant. Idempotent — a principal that already has a handle is skipped.
 *
 * This is where the built-in @cinatra handle is registered (the principal is
 * seeded AFTER migrations run). Minting is deterministic: principals are ordered
 * by their stable id so a shared normalized base always suffixes in the same
 * order (first-run-wins, then idempotent), and `registerAssistantHandle`'s
 * collision loop is cross-base-correct (it skips any suffixed candidate already
 * taken by another principal — the case a single-pass SQL backfill could not).
 * Returns the count minted. Called from `ensureAssistantBootstrap`. */
export async function backfillMissingAssistantHandles(): Promise<number> {
  // Prune orphan handles first (principal deleted, or no longer an assistant) so
  // the resolver never returns a dead principal id and a freed handle can be
  // reclaimed.
  const liveAssistantIds = betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.userType, "assistant"));
  await betterAuthDb
    .delete(assistantHandles)
    .where(notInArray(assistantHandles.assistantUserId, liveAssistantIds));

  const missing = await betterAuthDb
    .select({ id: betterAuthUsers.id, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .leftJoin(assistantHandles, eq(assistantHandles.assistantUserId, betterAuthUsers.id))
    .where(and(eq(betterAuthUsers.userType, "assistant"), isNull(assistantHandles.assistantUserId)))
    .orderBy(betterAuthUsers.id);

  let minted = 0;
  for (const u of missing) {
    const handle = await registerAssistantHandle(u.id, { desired: u.username });
    if (handle) minted++;
  }
  return minted;
}

export const betterAuthAccounts = pgTable("account", {
  id: text("id").primaryKey(),
  providerId: text("providerId"),
  userId: text("userId"),
  idToken: text("idToken"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

export const betterAuthSessions = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  activeOrganizationId: text("activeOrganizationId"),
  // Better Auth teams mode has always provisioned this column; the mirror
  // catches up for cinatra#1937 (the session guard trigger validates it).
  activeTeamId: text("activeTeamId"),
});

export const betterAuthOrganizations = pgTable("organization", {
  id: text("id").primaryKey(),
  // NOT NULL since core__0053 (cinatra#1737 Stage C); fresh installs get the
  // same shape from Better Auth's canonical model (name is required there).
  name: text("name").notNull(),
  slug: text("slug"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
  // cinatra#1937 (archive S1): NULL = active. Written only by the (gate-off
  // until S6) archive transaction; declared in cinatraOrganizationOptions
  // additionalFields so getMigrations() owns the column.
  archivedAt: timestamp("archivedAt", { withTimezone: true, mode: "date" }),
  // cinatra#1938 (archive S2): epoch bumped per archive/unarchive transition;
  // NULL (pre-migration rows) reads as 0 in the kernel. Same additionalFields
  // ownership as archivedAt.
  archiveEpoch: integer("archiveEpoch"),
});

// The live Better Auth `member` table has organizationId and userId declared
// NOT NULL. Without notNull() in the Drizzle declaration, Drizzle infers
// `string | null` for those columns, every consumer must coalesce, and filters
// like eq(betterAuthMembers.organizationId, x) can silently fold null
// comparisons in some Drizzle versions and fall through. Aligning the Drizzle
// types to the live schema removes the laxity. `role` stays nullable because
// Better Auth permits NULL there (default is no extra role beyond org
// membership).
export const betterAuthMembers = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId").notNull(),
  userId: text("userId").notNull(),
  role: text("role"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

// ---------------------------------------------------------------------------
// Better Auth team plugin Drizzle bridge.
// teamMember has id/teamId/userId/createdAt — NO organizationId. To get a
// user's teams scoped to an org, INNER JOIN team and filter by
// team.organizationId.
//
// `role` ('member' | 'admin') is APP-OWNED, not Better Auth's: the library has
// no per-team-member role and its schema builder ignores `teamMember`
// additionalFields (maintainer-endorsed workaround per better-auth
// discussion#2130; native support pending in better-auth#7628/#7886), so the
// column is provisioned by the
// guarded post-step in `scripts/better-auth-migrate.mts` (cinatra#1566). On a
// deployment that has not re-run `pnpm auth:migrate` the column is ABSENT —
// every read of it must go through the `teamMemberRoleColumnExists()` guard
// below (the accent_color precedent) and degrade to roleless membership.
// ---------------------------------------------------------------------------

export const betterAuthTeams = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // `slug` is NOT NULL in the live `public.team` table (CHECK-constrained,
  // unique per org); the binding must carry it or writes that omit it fail.
  slug: text("slug").notNull(),
  organizationId: text("organizationId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" }),
});

export const betterAuthTeamMembers = pgTable("teamMember", {
  id: text("id").primaryKey(),
  teamId: text("teamId").notNull(),
  userId: text("userId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
  // Live column is NOT NULL DEFAULT 'member' once provisioned; declared
  // nullable here because it may be ABSENT on not-yet-migrated deployments —
  // only guarded queries (see teamMemberRoleColumnExists) may select it.
  role: text("role"),
});

/**
 * Process-memoised guard: does `public."teamMember"."role"` exist in the live
 * DB? App-owned column, provisioned by `scripts/better-auth-migrate.mts`
 * (cinatra#1566); a deployment that predates it and has not re-run
 * `pnpm auth:migrate` still lacks the column, and selecting it there would
 * fail with 42703 on every session resolution. Mirrors the accent_color
 * existence guard (`src/lib/accent-color-store.ts`) with ONE difference:
 * only a POSITIVE result is memoised. Column presence is monotonic (nothing
 * drops it), but a long-lived process may probe `false` BEFORE `auth:migrate`
 * provisions the column — caching that `false` would freeze the process on
 * the roleless path forever. `false` (and probe failure) therefore clears the
 * memo so the next call re-probes.
 */
let teamMemberRoleColumnPresent: Promise<boolean> | null = null;

const TEAM_MEMBER_ROLE_COLUMN_PROBE = `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'teamMember'
           AND column_name = 'role'
       ) AS exists`;

export function teamMemberRoleColumnExists(): Promise<boolean> {
  if (teamMemberRoleColumnPresent) return teamMemberRoleColumnPresent;
  const probe: Promise<boolean> = betterAuthPool
    .query<{ exists: boolean }>(TEAM_MEMBER_ROLE_COLUMN_PROBE)
    .then((result) => {
      const exists = Boolean(result.rows[0]?.exists);
      if (!exists && teamMemberRoleColumnPresent === probe) {
        teamMemberRoleColumnPresent = null;
      }
      return exists;
    })
    .catch(() => {
      // Transient DB failure: clear the memo (only if we're still the current
      // probe) so the next call retries; treat this call as "absent" —
      // fail-soft to roleless membership (never over-grants).
      if (teamMemberRoleColumnPresent === probe) {
        teamMemberRoleColumnPresent = null;
      }
      return false;
    });
  teamMemberRoleColumnPresent = probe;
  return probe;
}

/**
 * STRICT probe variant for INVARIANT GUARDS (cinatra#1686). The fail-soft
 * `teamMemberRoleColumnExists` above treats a transient probe FAILURE as
 * "roleless" — right for feature degrade (never over-grants), wrong for a
 * guard: the last-admin check would be silently skipped while the mutation
 * itself still succeeds. This variant REJECTS on probe failure so the caller
 * aborts its mutation (fail closed) instead of proceeding unguarded. A
 * memoised TRUE is reused (presence is monotonic); anything else re-probes.
 */
export async function teamMemberRoleColumnExistsStrict(): Promise<boolean> {
  if (teamMemberRoleColumnPresent) {
    // The memo only persists while TRUE (absence/failure self-clear) and its
    // promise never rejects — a resolved true is authoritative, anything
    // else falls through to a fresh, failure-propagating probe.
    if (await teamMemberRoleColumnPresent) return true;
  }
  const result = await betterAuthPool.query<{ exists: boolean }>(
    TEAM_MEMBER_ROLE_COLUMN_PROBE,
  );
  const exists = Boolean(result.rows[0]?.exists);
  if (exists) teamMemberRoleColumnPresent = Promise.resolve(true);
  return exists;
}

/** A team membership row as seen by `readTeamsForUser`. `role` is `undefined`
 *  when the role column is not provisioned on this deployment (degrade =
 *  roleless membership), else `'admin' | 'member'` (`null` only for an
 *  unexpected out-of-vocabulary value — treated as 'member' downstream). */
export type TeamMembershipRow = {
  id: string;
  name: string;
  role?: "admin" | "member" | null;
};

/**
 * Return the teams a user belongs to within a specific org.
 * INNER JOIN is required because public."teamMember" has no organizationId
 * column.
 *
 * When the app-owned `role` column is provisioned, each row also carries the
 * caller's per-team role — same single query, no extra read. Consumers map
 * `'admin'` to the kernel's `team_admin` at the read boundary
 * (`src/lib/auth-session.ts`).
 */
export async function readTeamsForUser(
  userId: string,
  orgId: string,
): Promise<TeamMembershipRow[]> {
  const membershipFilter = and(
    eq(betterAuthTeamMembers.userId, userId),
    eq(betterAuthTeams.organizationId, orgId),
  );
  if (!(await teamMemberRoleColumnExists())) {
    return betterAuthDb
      .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
      .from(betterAuthTeamMembers)
      .innerJoin(
        betterAuthTeams,
        eq(betterAuthTeamMembers.teamId, betterAuthTeams.id),
      )
      .where(membershipFilter);
  }
  const rows = await betterAuthDb
    .select({
      id: betterAuthTeams.id,
      name: betterAuthTeams.name,
      role: betterAuthTeamMembers.role,
    })
    .from(betterAuthTeamMembers)
    .innerJoin(
      betterAuthTeams,
      eq(betterAuthTeamMembers.teamId, betterAuthTeams.id),
    )
    .where(membershipFilter);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role === "admin" || row.role === "member" ? row.role : null,
  }));
}

/**
 * Return EVERY team in an org (no membership filter).
 *
 * Admin-widening source for the teams dashboard visibility resolver:
 * `org_admin` / `org_owner` actors see every team in the active org, not
 * just direct memberships (`packages/dashboards/src/auth/team-visibility.ts`).
 * Callers MUST gate this behind a role check — it deliberately ignores the
 * caller's memberships. Named `listTeamsForOrg` (not `readTeamsForOrg`) to
 * avoid a near-collision with the singular `readTeamForOrg` below.
 */
export async function listTeamsForOrg(
  orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await betterAuthDb
    .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
    .from(betterAuthTeams)
    .where(eq(betterAuthTeams.organizationId, orgId))
    // Deterministic helper output (name, then id as tiebreaker) — the cube
    // applies its own ordering, but stable output keeps tests and debugging
    // sane.
    .orderBy(betterAuthTeams.name, betterAuthTeams.id);
  return rows;
}

/**
 * Return every `organization.id` the user is a member of.
 * Used by `buildSecurityContextWithAccessibleOrgIds` to widen the cube
 * access predicate from active-org-only to multi-org membership.
 *
 * Returns an empty array if the user has no memberships (defensive — the
 * caller fails closed to active-org-only in that case).
 */
export async function listAccessibleOrgIdsForUser(userId: string): Promise<string[]> {
  const rows = await betterAuthDb
    .select({ orgId: betterAuthMembers.organizationId })
    .from(betterAuthMembers)
    .where(eq(betterAuthMembers.userId, userId));
  return rows.map((r) => r.orgId);
}

/**
 * Return all orgs the user belongs to, each with the teams they are a member
 * of within that org.
 *
 * Implementation notes:
 *  - INNER JOIN member → organization to get org id + name.
 *  - For each org, INNER JOIN teamMember → team (team.organizationId) to get
 *    teams. The teamMember table has NO organizationId column; the org filter
 *    comes from team.organizationId.
 *  - Orgs sorted case-insensitively by name; teams within each org sorted by
 *    name ascending.
 *  - Returns [] when the user has no memberships.
 */
export async function readOrgsWithTeamsForUser(
  userId: string,
): Promise<Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>> {
  // Step 1 — fetch all orgs the user belongs to.
  const memberRows = await betterAuthDb
    .select({
      orgId: betterAuthOrganizations.id,
      orgName: betterAuthOrganizations.name,
    })
    .from(betterAuthMembers)
    .innerJoin(
      betterAuthOrganizations,
      eq(betterAuthMembers.organizationId, betterAuthOrganizations.id),
    )
    .where(eq(betterAuthMembers.userId, userId));

  if (memberRows.length === 0) return [];

  // Step 2 — for each org, fetch teams the user belongs to via JOIN onto team.organizationId.
  const orgIds = memberRows.map((r) => r.orgId);
  const teamRows = await betterAuthDb
    .select({
      orgId: betterAuthTeams.organizationId,
      teamId: betterAuthTeams.id,
      teamName: betterAuthTeams.name,
    })
    .from(betterAuthTeamMembers)
    .innerJoin(
      betterAuthTeams,
      eq(betterAuthTeamMembers.teamId, betterAuthTeams.id),
    )
    .where(
      and(
        eq(betterAuthTeamMembers.userId, userId),
        // Filter to only teams in orgs the user is a member of.
        // inArray is not imported here; use a subquery-free approach:
        // we do a JS-side filter after the join since orgIds is small.
      ),
    );

  // Build a map: orgId → teams[]
  const teamsByOrg = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of teamRows) {
    if (!orgIds.includes(row.orgId)) continue;
    const existing = teamsByOrg.get(row.orgId) ?? [];
    existing.push({ id: row.teamId, name: row.teamName });
    teamsByOrg.set(row.orgId, existing);
  }

  // Step 3 — compose result, sort orgs and teams.
  const result = memberRows
    .map((r) => ({
      id: r.orgId,
      name: r.orgName ?? "",
      teams: (teamsByOrg.get(r.orgId) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  return result;
}

export async function readTeamCreatableOrganizationsForUser(
  userId: string,
  userRole?: string | null,
): Promise<Array<{ id: string; name: string }>> {
  const isPlatformAdmin = String(userRole ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes("admin");

  const rows = await betterAuthDb
    .select({
      id: betterAuthOrganizations.id,
      name: betterAuthOrganizations.name,
      role: betterAuthMembers.role,
    })
    .from(betterAuthMembers)
    .innerJoin(
      betterAuthOrganizations,
      eq(betterAuthMembers.organizationId, betterAuthOrganizations.id),
    )
    .where(eq(betterAuthMembers.userId, userId));

  return rows
    .filter((row) => isPlatformAdmin || row.role === "owner" || row.role === "admin")
    .map((row) => ({ id: row.id, name: row.name ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function userCanCreateTeams(
  userId: string,
  userRole?: string | null,
): Promise<boolean> {
  const organizations = await readTeamCreatableOrganizationsForUser(userId, userRole);
  return organizations.length > 0;
}

/**
 * Multi-org projects-by-membership read. Mirrors src/app/projects/page.tsx —
 * visibility by ownership union across ALL orgs the user belongs to:
 *   own (owner_level='user' AND owner_id=userId)
 *   ∪ team-owned (owner_level='team' AND owner_id IN user's team IDs across all orgs)
 *   ∪ org-owned (owner_level='organization' AND owner_id IN user's org IDs)
 */
export async function readProjectsForUser(
  userId: string,
  _orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const [teamRows, orgRows] = await Promise.all([
    betterAuthDb.execute<{ teamId: string }>(sql`
      SELECT tm."teamId" AS "teamId"
      FROM public."teamMember" tm
      WHERE tm."userId" = ${userId}
    `),
    betterAuthDb.execute<{ organizationId: string }>(sql`
      SELECT m."organizationId" AS "organizationId"
      FROM public.member m
      WHERE m."userId" = ${userId}
    `),
  ]);
  const teamIds = teamRows.rows.map((r) => r.teamId);
  const orgIds = orgRows.rows.map((r) => r.organizationId);

  const ownClause = and(
    eq(projects.ownerLevel, "user"),
    eq(projects.ownerId, userId),
  );
  const teamClause = teamIds.length > 0
    ? and(eq(projects.ownerLevel, "team"), inArray(projects.ownerId, teamIds))
    : undefined;
  const orgClause = orgIds.length > 0
    ? and(eq(projects.ownerLevel, "organization"), inArray(projects.ownerId, orgIds))
    : undefined;

  const rows = await projectsDb
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      or(
        ownClause,
        ...(teamClause ? [teamClause] : []),
        ...(orgClause ? [orgClause] : []),
      ),
    )
    .orderBy(projects.name);
  return rows;
}

// ---------------------------------------------------------------------------
// Probe whether a userId corresponds to a real human user row in the Better
// Auth users table. Used by the WayFlow callback actor resolution path in
// packages/agent-builder/src/mcp/handlers.ts.
// ---------------------------------------------------------------------------
export async function readUserById(userId: string): Promise<{ id: string } | null> {
  const rows = await betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Case-insensitive email → user resolution (cinatra#1501 guest invites). Email
// uniqueness in Better Auth is effectively case-insensitive (sign-in
// normalizes), so lower(email) is the correct join key here.
// ---------------------------------------------------------------------------
export async function readUserByEmail(
  email: string,
): Promise<{ id: string; name: string | null; email: string | null } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
    })
    .from(betterAuthUsers)
    .where(sql`lower(${betterAuthUsers.email}) = ${normalized}`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Is `userId` a member of `organizationId`? Guest invites (cinatra#1501) must
 * never relabel a member of the TARGET project's org as a guest — the
 * classification rejects with "already-member" instead. Scoped to that org
 * deliberately: membership in some OTHER organization does not disqualify an
 * external collaborator (and must not leak to project admins).
 */
export async function readUserIsOrgMember(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const rows = await betterAuthDb
    .select({ id: betterAuthMembers.id })
    .from(betterAuthMembers)
    .where(
      and(
        eq(betterAuthMembers.userId, userId),
        eq(betterAuthMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolve display rows (name/email) for a set of user ids — the Guests list
 * shows people, not raw ids. Returns only the ids that exist.
 */
export async function readUsersByIds(
  userIds: string[],
): Promise<Array<{ id: string; name: string | null; email: string | null }>> {
  if (userIds.length === 0) return [];
  return betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
    })
    .from(betterAuthUsers)
    .where(inArray(betterAuthUsers.id, userIds));
}

/**
 * Look up whether `userId` is a platform admin, reading Better Auth's
 * `user.role` column directly. Better Auth's admin plugin stores roles as a
 * comma-separated string ("user,admin"), so we apply the same comma-split
 * test used by `src/lib/auth-session.ts:isPlatformAdmin`.
 *
 * Used by the MCP cube-tools transport: the MCP identity chain carries only
 * `{userId, organizationId}` (no role), so the `llm_usage` cube's
 * platform-admin visibility gate needs this explicit by-userId lookup.
 * Returns `false` on any error or missing row (fail-closed).
 */
export async function readUserIsPlatformAdmin(userId: string): Promise<boolean> {
  try {
    const rows = await betterAuthDb
      .select({ role: betterAuthUsers.role })
      .from(betterAuthUsers)
      .where(eq(betterAuthUsers.id, userId))
      .limit(1);
    return String(rows[0]?.role ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes("admin");
  } catch {
    return false;
  }
}

/**
 * Count platform admins OTHER than `excludeUserId` — i.e. how many distinct
 * users (besides the given one) carry the global `admin` platform role.
 *
 * Used by the agent-creation approval flow (issue #392) to decide whether a
 * `platform_admin` approving their OWN authored proposal is the *only* possible
 * reviewer (single-admin instance → no segregation-of-duties available, so the
 * self-approval guard must yield) or whether another admin could review it
 * instead (multi-admin org → keep the guard, preserve SoD).
 *
 * The `user.role` column is GLOBAL (Better Auth's admin plugin has no org
 * dimension on it), so this count is instance-wide, matching the scope of
 * `isPlatformAdmin` / `readUserIsPlatformAdmin`. Roles are stored as a
 * comma-separated string ("user,admin"), so candidate rows are filtered with
 * the SAME comma-split token test rather than a LIKE (which would false-match
 * a hypothetical "nonadmin"). Returns a conservative HIGH count on error
 * (fail-closed: on a read failure we KEEP the self-approval guard rather than
 * silently bypass it).
 */
export async function countOtherPlatformAdmins(excludeUserId: string): Promise<number> {
  try {
    const rows = await betterAuthDb
      .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
      .from(betterAuthUsers)
      .where(and(ne(betterAuthUsers.id, excludeUserId), sql`${betterAuthUsers.role} IS NOT NULL`));
    return rows.filter((row) =>
      String(row.role ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .includes("admin"),
    ).length;
  } catch {
    // Fail-closed: pretend another reviewer exists so the SoD guard stays on.
    return 1;
  }
}

/**
 * Tenant-membership existence check for installRegistryPackageAtScope.
 *
 * Returns the team row if a team with `teamId` exists AND belongs to the
 * given organization. Returns null otherwise (including when the team
 * exists in a DIFFERENT org — caller treats both as "not accessible" with
 * the same 403 to avoid existence-leakage about cross-org teams).
 *
 * Used by assertTargetBelongsToActiveOrg in packages/agents/src/actions.ts.
 * platform_admin installs at team scope still need to confirm the team
 * exists in the active org (defence-in-depth before the install runs).
 */
// ===========================================================================
// Canonical project-grant resolver (UNION + role-by-authority)
//
// Replaces every user-owned-only `projectIds` producer with ONE resolver
// computing `owned ∪ accessed` with role-BY-AUTHORITY (never a blanket
// "owner"), active-org-anchored explicit access, max-not-last-wins merge.
//
// Relies on project_access generated columns, a same-org trigger, implicit
// owner access without project_access rows, and the invariant that project_id
// refines access but is never an ownership tier. `accessSource` is a SOURCE
// label, not an `OwnerLevel`.
//
// I/O is composed from injectable row-readers (default params = the real
// SQL). The unit test `src/lib/__tests__/authz-project-grants.test.ts`
// drives the full role-by-authority + merge + stale-guard logic with no live
// Postgres — same dependency-composition pattern as
// `src/lib/authz/build-actor-context-from-run.ts`.
// ===========================================================================

import type {
  ProjectGrant,
  ProjectRole,
  ProjectAccessSource,
} from "@/lib/authz/actor-context";

export type { ProjectGrant } from "@/lib/authz/actor-context";

/**
 * Resolver hints — the caller-resolved membership context. `teamRoles` /
 * `orgRole` are single/active-org-scoped (Better Auth resolves the role for
 * the actor's active org only). When a hint is unavailable the implicit role
 * degrades to `read` (safe — never over-grants).
 */
export type ProjectGrantHints = {
  teamIds?: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  orgRole?: "org_owner" | "org_admin" | "member";
};

/** Row shapes returned by the (injectable) source readers. */
export type ImplicitOwnedProjectRow = {
  projectId: string;
  ownerLevel: string; // 'user' | 'team' | 'organization' | (legacy/workspace)
  ownerId: string;
};
export type ProjectAccessRow = {
  projectId: string;
  role: "read" | "write" | "admin"; // LITERAL row role — never capped
  principalLevel: "user" | "team" | "organization" | "workspace";
};
export type ProjectCoOwnerRow = { projectId: string };

/**
 * Injectable I/O seam. Defaults (below) are the real SQL readers; tests
 * supply fakes. Keeping the resolver in this module keeps it unit-testable
 * without a live DB.
 */
export type ProjectGrantResolverDeps = {
  /**
   * Source 1 — implicit ownership. Multi-org owned uses the same predicate as
   * the legacy `readProjectsForUser` union, but the SELECT is widened to also
   * return owner_level/owner_id so role-by-authority can be computed.
   * Self-anchors via the owner clauses → unaffected by the stale-membership
   * guard.
   */
  readImplicitOwnedProjectRows: (
    userId: string,
  ) => Promise<ImplicitOwnedProjectRow[]>;
  /**
   * Source 2 — explicit project_access, ACTIVE-ORG-ANCHORED. UNION ALL over
   * the generated-column indexes + the workspace partial index. No `OR NULL`
   * (org-null projects only admit workspace — fail-closed).
   */
  readProjectAccessRows: (
    userId: string,
    actorOrgId: string,
    teamIds: string[],
  ) => Promise<ProjectAccessRow[]>;
  /**
   * Source 3 — back-compat project_co_owners, ACTIVE-ORG-ANCHORED (JOIN
   * projects WHERE organization_id = actorOrgId). Co-owner == admin.
   */
  readProjectCoOwnerRows: (
    userId: string,
    actorOrgId: string,
  ) => Promise<ProjectCoOwnerRow[]>;
  /** Current org memberships — the stale-membership guard. */
  listAccessibleOrgIdsForUser: (userId: string) => Promise<string[]>;
};

const ROLE_RANK: Record<ProjectRole, number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};
const SOURCE_RANK: Record<ProjectAccessSource, number> = {
  owner: 0,
  user: 1,
  team: 2,
  organization: 3,
  workspace: 4,
};

/**
 * Source 1 role BY AUTHORITY (pure; exported for direct unit testing).
 *
 * - user-owned                         → {owner, owner}
 * - team-owned + team_admin            → {admin, team}; else/degrade → {read, team}
 * - org-owned, owner_id === actorOrgId → org_owner {owner} · org_admin {admin} · else {read} (source=organization)
 * - org-owned, owner_id !== actorOrgId → CAP {read, organization} because
 *   orgRole is single/active-org — an org_owner of A who is merely a member of
 *   B must NOT get `owner` on a B-owned project; the project still appears so
 *   binary projectIds back-compat is preserved
 *
 * Any other owner_level (legacy/workspace-tier owned project) → null; access
 * to it flows via Source 2/3 if granted.
 */
export function deriveImplicitOwnedRole(
  row: ImplicitOwnedProjectRow,
  userId: string,
  actorOrgId: string,
  hints: ProjectGrantHints,
): ProjectGrant | null {
  if (row.ownerLevel === "user" && row.ownerId === userId) {
    return { projectId: row.projectId, effectiveRole: "owner", accessSource: "owner" };
  }
  if (row.ownerLevel === "team") {
    const isTeamAdmin = hints.teamRoles?.[row.ownerId] === "team_admin";
    return {
      projectId: row.projectId,
      effectiveRole: isTeamAdmin ? "admin" : "read",
      accessSource: "team",
    };
  }
  if (row.ownerLevel === "organization") {
    if (row.ownerId !== actorOrgId) {
      // Non-active-org owned project (user is merely a member of that org).
      return { projectId: row.projectId, effectiveRole: "read", accessSource: "organization" };
    }
    const role: ProjectRole =
      hints.orgRole === "org_owner"
        ? "owner"
        : hints.orgRole === "org_admin"
          ? "admin"
          : "read";
    return { projectId: row.projectId, effectiveRole: role, accessSource: "organization" };
  }
  return null;
}

/**
 * Merge by projectId (pure; exported for direct unit testing).
 * `effectiveRole = max(owner>admin>write>read)`. On role tie, `accessSource`
 * by `owner>user>team>organization>workspace`. Never last-wins, never raises
 * a role beyond any contributing source. Sorted by projectId (deterministic).
 */
export function mergeProjectGrants(grants: ProjectGrant[]): ProjectGrant[] {
  const byProject = new Map<string, ProjectGrant>();
  for (const g of grants) {
    const cur = byProject.get(g.projectId);
    if (!cur) {
      byProject.set(g.projectId, g);
      continue;
    }
    const higherRole = ROLE_RANK[g.effectiveRole] > ROLE_RANK[cur.effectiveRole];
    const sameRole = ROLE_RANK[g.effectiveRole] === ROLE_RANK[cur.effectiveRole];
    if (higherRole) {
      byProject.set(g.projectId, g);
    } else if (
      sameRole &&
      SOURCE_RANK[g.accessSource] < SOURCE_RANK[cur.accessSource]
    ) {
      // Same role, more-authoritative source label → adopt the source but
      // keep the (identical) role.
      byProject.set(g.projectId, { ...cur, accessSource: g.accessSource });
    }
  }
  return [...byProject.values()].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
}

// ---- default real SQL readers (Source 1/2/3 + membership) ----

/**
 * Source 1 default reader. Predicate is byte-identical to the legacy
 * `readProjectsForUser` multi-org union (own ∪ team-owned ∪ org-owned across
 * ALL the user's orgs/teams); the SELECT additionally returns owner_level/
 * owner_id so role-by-authority can be computed.
 */
async function readImplicitOwnedProjectRowsSql(
  userId: string,
): Promise<ImplicitOwnedProjectRow[]> {
  const [teamRows, orgRows] = await Promise.all([
    betterAuthDb.execute<{ teamId: string }>(sql`
      SELECT tm."teamId" AS "teamId"
      FROM public."teamMember" tm
      WHERE tm."userId" = ${userId}
    `),
    betterAuthDb.execute<{ organizationId: string }>(sql`
      SELECT m."organizationId" AS "organizationId"
      FROM public.member m
      WHERE m."userId" = ${userId}
    `),
  ]);
  const teamIds = teamRows.rows.map((r) => r.teamId);
  const orgIds = orgRows.rows.map((r) => r.organizationId);

  const ownClause = and(
    eq(projects.ownerLevel, "user"),
    eq(projects.ownerId, userId),
  );
  const teamClause =
    teamIds.length > 0
      ? and(eq(projects.ownerLevel, "team"), inArray(projects.ownerId, teamIds))
      : undefined;
  const orgClause =
    orgIds.length > 0
      ? and(
          eq(projects.ownerLevel, "organization"),
          inArray(projects.ownerId, orgIds),
        )
      : undefined;

  const rows = await projectsDb
    .select({
      projectId: projects.id,
      ownerLevel: projects.ownerLevel,
      ownerId: projects.ownerId,
    })
    .from(projects)
    .where(
      or(
        ownClause,
        ...(teamClause ? [teamClause] : []),
        ...(orgClause ? [orgClause] : []),
      ),
    )
    .orderBy(projects.id);
  return rows;
}

/**
 * Source 2 default reader — UNION ALL over the generated-column indexes
 * because a `(principal_level,principal_id)` predicate would NOT use the
 * partial indexes. Also includes the workspace partial index. Active-org
 * anchored on `projects.organization_id = $actorOrgId`. No `OR NULL` — an
 * org-null project only admits the workspace principal.
 *
 * Raw SQL (cross-schema reference into the cinatra schema's project_access).
 * `projectsDb` is bound to the cinatra schema pool.
 */
async function readProjectAccessRowsSql(
  userId: string,
  actorOrgId: string,
  teamIds: string[],
): Promise<ProjectAccessRow[]> {
  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll(
    '"',
    '""',
  );
  // Drizzle's `sql` tag binds JS arrays via pg-node's parameter serializer.
  // Sending a single-element empty-string array makes pg-node stringify it to
  // `''` (a plain string, not a `text[]`), and Postgres rejects that with
  // "malformed array literal" 22P02 inside `ANY($3)`. Skip the team-id UNION
  // branch entirely when the actor is in no teams — it would match zero rows
  // anyway, so it's not just safer but strictly equivalent.
  const teamBranch = teamIds.length > 0
    ? sql`
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_team_id = ANY(${toPgTextArrayLiteral(teamIds)}::text[])
       AND p.organization_id = ${actorOrgId}`
    : sql``;
  const result = await projectsDb.execute<{
    project_id: string;
    role: "read" | "write" | "admin";
    principal_level: "user" | "team" | "organization" | "workspace";
  }>(sql`
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_user_id = ${userId}
       AND p.organization_id = ${actorOrgId}${teamBranch}
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_org_id = ${actorOrgId}
       AND p.organization_id = ${actorOrgId}
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_level = 'workspace'
       AND pa.principal_id = '__workspace__'
       AND p.organization_id IS NULL
  `);
  return result.rows.map((r) => ({
    projectId: r.project_id,
    role: r.role,
    principalLevel: r.principal_level,
  }));
}

/**
 * Source 3 default reader — back-compat project_co_owners, active-org
 * anchored (JOIN projects WHERE organization_id = $actorOrgId). Co-owner ==
 * admin (preserves the co-owner semantic).
 */
async function readProjectCoOwnerRowsSql(
  userId: string,
  actorOrgId: string,
): Promise<ProjectCoOwnerRow[]> {
  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll(
    '"',
    '""',
  );
  const result = await projectsDb.execute<{ project_id: string }>(sql`
    SELECT co.project_id
      FROM "${sql.raw(schema)}"."project_co_owners" co
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = co.project_id
     WHERE co.user_id = ${userId}
       AND p.organization_id = ${actorOrgId}
  `);
  return result.rows.map((r) => ({ projectId: r.project_id }));
}

const DEFAULT_PROJECT_GRANT_DEPS: ProjectGrantResolverDeps = {
  readImplicitOwnedProjectRows: readImplicitOwnedProjectRowsSql,
  readProjectAccessRows: readProjectAccessRowsSql,
  readProjectCoOwnerRows: readProjectCoOwnerRowsSql,
  listAccessibleOrgIdsForUser,
};

/**
 * THE canonical project-grant resolver. Every `projectIds` producer routes
 * through this — owned ∪ accessed, role-by-authority, active-org-anchored
 * explicit access, max-not-last-wins merge.
 *
 * Sources 2+3 are gated on `actorOrgId ∈ listAccessibleOrgIdsForUser`
 * stale-membership guard: the same-org trigger only validates at GRANT time,
 * not after the principal is removed from the org. If `actorOrgId` is no
 * longer a current membership (session still carries a stale
 * activeOrganizationId), Sources 2+3 yield nothing and we do NOT even issue
 * their queries (fail-closed, no wasted round-trip). Source 1 (implicit owned)
 * is unaffected — it self-anchors via the owner clauses.
 *
 * @param hints caller-resolved membership context (single/active-org-scoped;
 *   missing teamRoles/orgRole → implicit role degrades to `read`, safe).
 * @param deps injectable I/O seam (defaults = real SQL).
 */
export async function readProjectGrantsForUser(
  userId: string,
  actorOrgId: string,
  hints: ProjectGrantHints,
  deps: ProjectGrantResolverDeps = DEFAULT_PROJECT_GRANT_DEPS,
): Promise<ProjectGrant[]> {
  const teamIds = hints.teamIds ?? [];

  // Source 1 — implicit owned (multi-org; role by authority). Self-anchored.
  const ownedRows = await deps.readImplicitOwnedProjectRows(userId);
  const collected: ProjectGrant[] = [];
  for (const row of ownedRows) {
    const g = deriveImplicitOwnedRole(row, userId, actorOrgId, hints);
    if (g) collected.push(g);
  }

  // Stale-membership guard. Sources 2+3 are anchored to `actorOrgId`; only
  // honor them when actorOrgId is a CURRENT membership.
  const accessibleOrgIds = await deps.listAccessibleOrgIdsForUser(userId);
  if (accessibleOrgIds.includes(actorOrgId)) {
    // Source 2 — explicit project_access (literal row role, active-org
    // anchored). NOT capped by org/team role.
    const accessRows = await deps.readProjectAccessRows(
      userId,
      actorOrgId,
      teamIds,
    );
    for (const r of accessRows) {
      collected.push({
        projectId: r.projectId,
        effectiveRole: r.role as ProjectRole,
        accessSource: r.principalLevel as ProjectAccessSource,
      });
    }
    // Source 3 — back-compat co-owner == admin (active-org anchored).
    const coOwnerRows = await deps.readProjectCoOwnerRows(userId, actorOrgId);
    for (const r of coOwnerRows) {
      collected.push({
        projectId: r.projectId,
        effectiveRole: "admin",
        accessSource: "user",
      });
    }
  }

  return mergeProjectGrants(collected);
}

export async function readTeamForOrg(
  teamId: string,
  organizationId: string,
): Promise<{ id: string; organizationId: string } | null> {
  const rows = await betterAuthDb
    .select({
      id: betterAuthTeams.id,
      organizationId: betterAuthTeams.organizationId,
    })
    .from(betterAuthTeams)
    .where(
      and(
        eq(betterAuthTeams.id, teamId),
        eq(betterAuthTeams.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batched name resolution for a CLOSED set of team ids, bounded by one
 * organization (cinatra#1509 §4.1 / codex F5 — the #1508 selection hydration).
 *
 * The query is doubly bounded: only ids in `teamIds` AND only teams whose
 * `organizationId` matches are returned. Ids outside the org (or pointing at
 * deleted teams) are simply absent from the result, so callers fall back to
 * the explicit "Unknown team" label instead of leaking anything.
 *
 * SECURITY: callers must derive `teamIds` from server-side state only (e.g.
 * a project's stored access expression + its project_access rows) — this is
 * NOT a client-supplied-id → name oracle and must never be exposed as one.
 *
 * One batched query per call (no N+1 — §3.5). Ordered by name, then id, for
 * deterministic output like `listTeamsForOrg`.
 */
export async function readTeamsByIdsForOrg(
  teamIds: string[],
  organizationId: string,
): Promise<Array<{ id: string; name: string }>> {
  if (teamIds.length === 0) return [];
  const rows = await betterAuthDb
    .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
    .from(betterAuthTeams)
    .where(
      and(
        inArray(betterAuthTeams.id, teamIds),
        eq(betterAuthTeams.organizationId, organizationId),
      ),
    )
    .orderBy(betterAuthTeams.name, betterAuthTeams.id);
  return rows;
}
