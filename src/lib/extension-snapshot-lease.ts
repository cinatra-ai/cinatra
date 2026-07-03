import "server-only";

// Snapshot-lease store for the runtime extension package store (the
// installer). A lease pins a digest dir as IN-USE so the GC reaper cannot delete
// it out from under an in-flight run that has `file://`-imported it.
//
// ESM-cache-safe update, restated: updates land at a NEW <digest> dir (never
// overwritten in place); the loader imports per-digest `file://` URLs, so a new
// digest is a distinct module URL = a fresh module graph (no cache bust needed).
// The old digest dir keeps serving live runs until their leases lapse, then the
// reaper reclaims it. See `extension-store-gc.ts` for the pure selector.
//
// Reads/writes go through an INJECTED query so the store is unit-testable
// without a DB. The default path is a lazy, globalThis-cached `pg.Pool` (NEVER a
// top-level pool — that would break `next build` page-data collection).

import {
  digestKey,
  selectGcEligibleDigests,
  type OnDiskDigest,
} from "@/lib/extension-store-gc";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** Minimal async query surface (injected → unit-testable without a DB). */
export type SnapshotLeaseQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type SnapshotLeaseDeps = {
  query: SnapshotLeaseQuery;
  /** The host schema leases live in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraSnapshotLeasePool: import("pg").Pool | undefined;
}

let snapshotLeasePoolInstance: import("pg").Pool | undefined;
async function getSnapshotLeasePool(): Promise<import("pg").Pool> {
  if (snapshotLeasePoolInstance) return snapshotLeasePoolInstance;
  if (globalThis.__cinatraSnapshotLeasePool) {
    return (snapshotLeasePoolInstance = globalThis.__cinatraSnapshotLeasePool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-snapshot-lease");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-snapshot-lease] pg pool idle client error:", err.message);
    });
  }
  snapshotLeasePoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraSnapshotLeasePool = pool;
  }
  return pool;
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getSnapshotLeasePool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function resolveDeps(deps?: SnapshotLeaseDeps): Promise<{
  query: SnapshotLeaseQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? defaultQuery,
    schema: deps?.schema ?? schemaName,
  };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_snapshot_lease"`;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type LeaseRow = {
  id: string;
  package_name: string;
  digest: string;
  lease_holder: string;
  acquired_at: string;
  expires_at: string;
};

export type SnapshotLease = {
  id: string;
  packageName: string;
  digest: string;
  leaseHolder: string;
  acquiredAt: string;
  expiresAt: string;
};

function rowToLease(row: LeaseRow): SnapshotLease {
  return {
    id: row.id,
    packageName: row.package_name,
    digest: row.digest,
    leaseHolder: row.lease_holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

const SELECT_COLUMNS = "id, package_name, digest, lease_holder, acquired_at, expires_at";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type AcquireLeaseInput = {
  packageName: string;
  digest: string;
  /** Identifies the holder (e.g. a runId) for diagnostics + manual release. */
  leaseHolder: string;
  /** Lease lifetime in ms; expires_at = now() + ttl. A lapsed lease stops protecting the dir. */
  ttlMs: number;
};

/**
 * Acquire a snapshot lease pinning `<packageName>@<digest>` as in-use for
 * `ttlMs`. Returns the new lease id. `expires_at` is computed in SQL (server
 * clock) so callers and the reaper agree on "now".
 */
export async function acquireLease(
  input: AcquireLeaseInput,
  deps?: SnapshotLeaseDeps,
): Promise<string> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const intervalMs = Math.max(0, Math.floor(input.ttlMs));
  const rows = await query<{ id: string }>(
    `INSERT INTO ${table} (package_name, digest, lease_holder, expires_at)
       VALUES ($1, $2, $3, now() + ($4::bigint * interval '1 millisecond'))
     RETURNING id`,
    [input.packageName, input.digest, input.leaseHolder, intervalMs],
  );
  if (!rows[0]) throw new Error("extension_snapshot_lease insert returned no row");
  return rows[0].id;
}

/** Release a lease by id (idempotent: releasing an unknown id is a no-op). */
export async function releaseLease(id: string, deps?: SnapshotLeaseDeps): Promise<void> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

export type ListActiveLeasesInput = {
  /** Override "now" (ISO) for testing; defaults to the DB server clock. */
  now?: string;
};

/**
 * List LIVE leases — `expires_at > now`. An expired lease (expires_at <= now)
 * is excluded, so a crashed holder cannot strand a digest dir forever.
 */
export async function listActiveLeases(
  input: ListActiveLeasesInput = {},
  deps?: SnapshotLeaseDeps,
): Promise<SnapshotLease[]> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const rows =
    input.now !== undefined
      ? await query<LeaseRow>(
          `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE expires_at > $1`,
          [input.now],
        )
      : await query<LeaseRow>(`SELECT ${SELECT_COLUMNS} FROM ${table} WHERE expires_at > now()`);
  return rows.map(rowToLease);
}

export type ReapStoreInput = {
  /** Enumerate every materialized digest dir on disk (injected → fs-free in tests). */
  listOnDiskDigests: () => Promise<OnDiskDigest[]>;
  /** The currently-activated digest per package, keyed `pkg@digest`. */
  activeDigests: ReadonlySet<string>;
  /** Delete a single digest dir (injected → fs-free in tests). */
  rmDir: (entry: OnDiskDigest) => Promise<void>;
  /** Override "now" (ISO) for the live-lease cut, forwarded to listActiveLeases. */
  now?: string;
};

export type ReapStoreResult = {
  /** Digest dirs actually deleted. */
  deleted: OnDiskDigest[];
  /**
   * Digest dirs that were GC-eligible at the initial lease snapshot but SKIPPED
   * because the immediate pre-delete re-check found a live lease (or the active
   * digest) — i.e. a lease raced in AFTER the snapshot. Surfaced for the
   * reaper's observability; empty in the common case.
   */
  skippedForRacedLease: OnDiskDigest[];
};

/**
 * Targeted liveness probe for ONE `pkg@digest`: is there a live (unexpired)
 * lease right now? Used by the reaper's per-entry TOCTOU re-check so it reads
 * the FRESH state immediately before each delete, not the initial snapshot.
 */
async function hasLiveLease(
  query: SnapshotLeaseQuery,
  table: string,
  packageName: string,
  digest: string,
  now?: string,
): Promise<boolean> {
  const rows =
    now !== undefined
      ? await query(
          `SELECT 1 AS live FROM ${table}
             WHERE package_name = $1 AND digest = $2 AND expires_at > $3 LIMIT 1`,
          [packageName, digest, now],
        )
      : await query(
          `SELECT 1 AS live FROM ${table}
             WHERE package_name = $1 AND digest = $2 AND expires_at > now() LIMIT 1`,
          [packageName, digest],
        );
  return rows.length > 0;
}

/**
 * Public per-`pkg@digest` live-lease probe (the same FRESH read `reapStore`
 * uses for its per-entry TOCTOU re-check), exported for the V2 retention-aware
 * reaper (`extension-store-reaper.ts`, cinatra#796) so its delete loop can
 * re-verify lease liveness immediately before each `rm`.
 */
export async function hasLiveSnapshotLease(
  packageName: string,
  digest: string,
  now?: string,
  deps?: SnapshotLeaseDeps,
): Promise<boolean> {
  const { query, schema } = await resolveDeps(deps);
  return hasLiveLease(query, qualifiedTable(schema), packageName, digest, now);
}

/**
 * The GC reaper: compose live leases + the pure GC selector + `rmDir` to delete
 * digest dirs that are neither the active digest nor under a live lease.
 * Injected `listOnDiskDigests` + `rmDir` keep it testable without fs; the
 * live-lease set is read through the (injectable) query.
 *
 * TOCTOU guard (cinatra#850): `acquireLease` is a plain INSERT with no
 * coordination, so a lease acquired AFTER the initial `listActiveLeases`
 * snapshot but BEFORE a given `rmDir` is absent from the snapshot — the old
 * loop would delete a store dir out from under a just-started run. We now
 * re-verify each candidate's lease liveness against a FRESH per-entry read
 * (`hasLiveLease`) immediately before deleting it, shrinking the unavoidable
 * window from "the whole delete loop" to the sub-millisecond check→`rmDir` gap.
 * (The active-digest pointer is a caller-supplied snapshot the reaper cannot
 * re-read, so activation races are out of scope here — see the residual below.)
 *
 * Residual (documented follow-up): fully closing the remaining check→`rmDir`
 * gap needs either a DB lock spanning the read+fs-deletes (not expressible
 * through the single-query injected surface without a connection/txn handle) or
 * an acquire-side "verify the dir still exists after the INSERT" guard in the
 * run that takes the lease. `reapStore`/`acquireLease` have no production caller
 * yet; that wiring should add the acquire-side guard.
 */
export async function reapStore(
  input: ReapStoreInput,
  deps?: SnapshotLeaseDeps,
): Promise<ReapStoreResult> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const onDisk = await input.listOnDiskDigests();
  const liveLeases = await listActiveLeases({ now: input.now }, deps);
  const leasedDigests = new Set<string>(
    liveLeases.map((lease) => digestKey(lease.packageName, lease.digest)),
  );
  const eligible = selectGcEligibleDigests({
    onDisk,
    activeDigests: input.activeDigests,
    leasedDigests,
  });
  const deleted: OnDiskDigest[] = [];
  const skippedForRacedLease: OnDiskDigest[] = [];
  for (const entry of eligible) {
    // Re-verify liveness against a FRESH read immediately before deleting: a
    // lease acquired after the snapshot above is absent from `leasedDigests`,
    // so without this the dir would be reaped out from under a just-started run.
    if (await hasLiveLease(query, table, entry.packageName, entry.digest, input.now)) {
      skippedForRacedLease.push(entry);
      continue;
    }
    await input.rmDir(entry);
    deleted.push(entry);
  }
  return { deleted, skippedForRacedLease };
}
