import "server-only";
import { Pool, type PoolConfig } from "pg";

/**
 * Shared async pooled-DB scaffold (#303).
 *
 * Request-time stores have historically reached for the synchronous Postgres
 * bridge (`runPostgresQueriesSync` — a worker-thread + `Atomics.wait`). The
 * architecture track migrates request-time persistence onto an *async*,
 * lazily-pooled `pg.Pool` instead, leaving the sync bridge as the exceptional
 * sync-leaf escape hatch.
 *
 * Across the codebase ~two dozen stores already do exactly this, each
 * hand-rolling the *identical* lazy-pool boilerplate:
 *   - the pool is created on FIRST USE (not at module import) so `next build`
 *     page-data collection — and any other import-time evaluation without
 *     `SUPABASE_DB_URL` — does not throw. `new Pool()` never opens a connection
 *     until the first query, so deferring creation is free.
 *   - a single idle-error listener is registered at pool creation. `pg.Pool`
 *     emits `'error'` on an unexpected backend disconnect (e.g. Supabase
 *     dropping an idle connection), which Node.js otherwise treats as an
 *     uncaught exception that would crash the process.
 *   - in non-production, the pool is cached on a per-module `globalThis` key so
 *     Next.js/Turbopack module re-evaluation (HMR, route re-compile) reuses the
 *     same pool instead of leaking a new one on every reload.
 *
 * This module is the single source of that boilerplate. Each caller supplies a
 * unique `name` (used for the dev `globalThis` cache key, the idle-error log
 * prefix, and the missing-connection-string error message) and gets back a
 * lazily-created, shared `pg.Pool`.
 */

declare global {
  var __cinatraPooledDb: Map<string, Pool> | undefined;
}

/**
 * Resolve the Postgres connection string for a pooled DB.
 *
 * The default resolver requires `SUPABASE_DB_URL` and throws (with the pool's
 * `name`) when it is missing — the behavior the overwhelming majority of pool
 * sites already have. A handful of sites (authz scope resolvers) deliberately
 * fail OPEN to a local placeholder so import-time evaluation never throws even
 * outside a configured environment; those sites pass `failOpenLocalhost` to
 * preserve that exact behavior rather than silently changing it.
 */
export type ConnectionStringResolver = (name: string) => string;

const defaultResolver: ConnectionStringResolver = (name) => {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(`SUPABASE_DB_URL is required for ${name}`);
  }
  return connectionString;
};

/**
 * Fail-open resolver: returns `SUPABASE_DB_URL` when set, otherwise a local
 * placeholder DSN. Use ONLY for sites that historically did
 * `process.env.SUPABASE_DB_URL ?? "postgres://localhost"` so import-time
 * evaluation never throws (the connection is still lazy and never opened until
 * the first query). Never the default — a request-time store should fail
 * CLOSED on a missing connection string, not silently target localhost.
 */
export const failOpenLocalhost: ConnectionStringResolver = () =>
  process.env.SUPABASE_DB_URL ?? "postgres://localhost";

export type GetPooledDbOptions = {
  /**
   * Unique, stable identifier for this logical pool. Used as the dev
   * `globalThis` cache key, the idle-error log prefix, and the
   * missing-connection-string error message. MUST be unique per logical store
   * so two stores never share (or clobber) each other's pool.
   */
  name: string;
  /**
   * Connection-string resolver. Defaults to the throw-if-missing resolver.
   * Pass {@link failOpenLocalhost} to preserve a fail-open site's behavior, or
   * a custom resolver (e.g. one that delegates to `getPostgresConnectionString`).
   */
  connectionString?: ConnectionStringResolver;
  /**
   * Extra `pg.Pool` config merged onto `{ connectionString }`. Lets a site keep
   * its bespoke pool tuning (max, timeouts, etc.) while still sharing the lazy
   * creation + idle-error + dev-cache plumbing.
   */
  poolConfig?: Omit<PoolConfig, "connectionString">;
};

function devCache(): Map<string, Pool> {
  return (globalThis.__cinatraPooledDb ??= new Map<string, Pool>());
}

const localInstances = new Map<string, Pool>();

// A stable fingerprint of the options a `name` was FIRST created with. A second
// caller reusing the same `name` with a DIFFERENT resolved connection string or
// pool config is a programming error (it would silently get the first caller's
// pool and ignore its own config) — we throw instead of papering over it.
const ownerFingerprints = new Map<string, string>();

function fingerprint(connectionString: string, poolConfig: unknown): string {
  // The connection string can carry credentials; hash-free is fine here because
  // this map never leaves the process and is only string-compared, but keep the
  // value short and non-logged. We compare the resolved DSN + a stable config
  // shape so two genuinely-identical call sites match.
  return `${connectionString}::${poolConfig ? JSON.stringify(poolConfig) : ""}`;
}

function assertSameOwner(name: string, fp: string): void {
  const prior = ownerFingerprints.get(name);
  if (prior !== undefined && prior !== fp) {
    throw new Error(
      `getPooledDb: pool name "${name}" is already registered with different options. ` +
        "Each logical pool must use a unique `name`; a name collision would silently " +
        "reuse the first pool and ignore the second caller's connection string / config.",
    );
  }
  ownerFingerprints.set(name, fp);
}

/**
 * Get the shared, lazily-created `pg.Pool` for `name`, creating it on first use.
 *
 * Behavior preserved from the hand-rolled sites:
 *   - lazy first-use creation (no connection at module import),
 *   - exactly-once idle-error listener registration,
 *   - dev-only `globalThis` cache (keyed by `name`) for HMR reuse.
 *
 * In production the pool is module-scoped (`localInstances`); in non-production
 * it is additionally registered on `globalThis` so Turbopack re-evaluation
 * reuses it.
 */
export function getPooledDb(options: GetPooledDbOptions): Pool {
  const { name, connectionString = defaultResolver, poolConfig } = options;
  if (!name || typeof name !== "string") {
    throw new Error("getPooledDb requires a non-empty string `name`");
  }

  // Resolve the DSN up front (lazy — never opens a connection) so a cache hit
  // can verify the caller is the same logical owner, not a name collision.
  const resolvedConnectionString = connectionString(name);
  const fp = fingerprint(resolvedConnectionString, poolConfig);

  const existing = localInstances.get(name);
  if (existing) {
    assertSameOwner(name, fp);
    return existing;
  }

  if (process.env.NODE_ENV !== "production") {
    const cached = devCache().get(name);
    if (cached) {
      assertSameOwner(name, fp);
      localInstances.set(name, cached);
      return cached;
    }
  }

  assertSameOwner(name, fp);
  // `new Pool()` never opens a connection until the first query, so creating it
  // here (on first use) keeps import-time evaluation connection-free even though
  // `Pool` is imported statically — mirroring every existing pool site.
  const pool: Pool = new Pool({ connectionString: resolvedConnectionString, ...poolConfig });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err: Error) => {
      console.error(`[${name}] pg pool idle client error:`, err.message);
    });
  }

  localInstances.set(name, pool);
  if (process.env.NODE_ENV !== "production") {
    devCache().set(name, pool);
  }
  return pool;
}

/**
 * Test-only: drop the cached pool(s) so a subsequent {@link getPooledDb} builds
 * a fresh one. Does NOT end the underlying pool — callers that need that should
 * `await pool.end()` themselves. Pass a `name` to reset one pool, or omit to
 * reset all.
 */
export function __resetPooledDbForTests(name?: string): void {
  if (name) {
    localInstances.delete(name);
    ownerFingerprints.delete(name);
    globalThis.__cinatraPooledDb?.delete(name);
    return;
  }
  localInstances.clear();
  ownerFingerprints.clear();
  globalThis.__cinatraPooledDb?.clear();
}
