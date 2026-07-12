import "server-only";
import { getPooledDb } from "@/lib/db/pooled";
import {
  readUpdateModelForInstalled,
  type ExtensionUpdateEntry,
  type ExtensionUpdateReadModelStore,
  type InstalledUpdateReadout,
} from "@cinatra-ai/registries/src/update-read-model";

// DB-backed adapter for the cached "update read model" (cinatra#1041 outcome
// 3). The PORT + in-memory reference store live in the registries package
// (@cinatra-ai/registries/src/update-read-model, deep-path so the leaf never
// enters a locked route's barrel graph); this is the host-side PERSISTENT
// implementation the port declared out of scope.
//
// The backing table `extension_update_read_model` is a purely ADDITIVE new
// table, so it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts)
// — NO numbered core migration. Per migrations/README.md the bootstrap covers
// additive evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors `widget_stream_tokens` (cinatra#220), another
// new column-table added via the bootstrap with no migration.
//
// Mirrors extension-install-batch-ops.ts: an injected query (unit-testable
// without a DB), a lazy pooled connection, and a schema-qualified table.

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

const TABLE = "extension_update_read_model";

/**
 * Read-model freshness window. The read model is refreshed per-package by the
 * hourly marketplace catalog-sync loop; an entry older than this reads STALE
 * (→ fail-quiet, no chip) so a neglected/stopped sync never surfaces a wrong
 * "update available" verdict. Lenient (a full day) so a single missed hourly
 * sweep does not blank every chip.
 */
export const UPDATE_READ_MODEL_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateReadModelQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type UpdateReadModelStoreDeps = {
  query?: UpdateReadModelQuery;
  schema?: string;
};

async function getPool(): Promise<import("pg").Pool> {
  return getPooledDb({ name: "extension-update-read-model" });
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

type UpdateRow = {
  package_name: string;
  latest_version: string | null;
  latest_sdk_abi_range: string | null;
  refreshed_at: string | Date;
};

/** timestamptz comes back as a `Date` from pg; normalise to the port's ISO string. */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * DB-backed `ExtensionUpdateReadModelStore`. `read` returns only the requested
 * names (absent names → "never synced" → the reader treats them as stale);
 * `upsert` is insert-or-replace keyed by `package_name`.
 */
export class DbExtensionUpdateReadModelStore implements ExtensionUpdateReadModelStore {
  private readonly query: UpdateReadModelQuery;
  private readonly schema: string;

  constructor(deps?: UpdateReadModelStoreDeps) {
    this.query = deps?.query ?? defaultQuery;
    this.schema = deps?.schema ?? schemaName;
  }

  private table(): string {
    // schemaName / SUPABASE_SCHEMA is operator config, never user input; quote
    // defensively all the same (mirrors the store's `"schema"."table"` form).
    return `"${this.schema.replaceAll('"', '""')}"."${TABLE}"`;
  }

  async read(packageNames: string[]): Promise<Map<string, ExtensionUpdateEntry>> {
    const out = new Map<string, ExtensionUpdateEntry>();
    if (packageNames.length === 0) return out;
    const rows = await this.query<UpdateRow>(
      `SELECT package_name, latest_version, latest_sdk_abi_range, refreshed_at
         FROM ${this.table()}
        WHERE package_name = ANY($1::text[])`,
      [packageNames],
    );
    for (const row of rows) {
      out.set(row.package_name, {
        packageName: row.package_name,
        latestVersion: row.latest_version,
        latestSdkAbiRange: row.latest_sdk_abi_range,
        refreshedAt: toIso(row.refreshed_at),
      });
    }
    return out;
  }

  async upsert(entries: ExtensionUpdateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // Multi-row insert via parallel arrays (unnest) so an arbitrary-N upsert is
    // a single round-trip; null latest_version / latest_sdk_abi_range are
    // preserved as SQL NULLs.
    await this.query(
      `INSERT INTO ${this.table()}
         (package_name, latest_version, latest_sdk_abi_range, refreshed_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
       ON CONFLICT (package_name) DO UPDATE SET
         latest_version = EXCLUDED.latest_version,
         latest_sdk_abi_range = EXCLUDED.latest_sdk_abi_range,
         refreshed_at = EXCLUDED.refreshed_at`,
      [
        entries.map((e) => e.packageName),
        entries.map((e) => e.latestVersion),
        entries.map((e) => e.latestSdkAbiRange),
        entries.map((e) => e.refreshedAt),
      ],
    );
  }
}

let cachedStore: DbExtensionUpdateReadModelStore | null = null;

/** Process-cached DB-backed store (the default host adapter). */
export function getExtensionUpdateReadModelStore(): DbExtensionUpdateReadModelStore {
  if (cachedStore === null) {
    cachedStore = new DbExtensionUpdateReadModelStore();
  }
  return cachedStore;
}

/**
 * Convenience read used by the §III installed-extensions screen: resolve the
 * cached update readout (entry + staleness) for the given installed package
 * names in one place, applying the standard now/TTL so every reader agrees on
 * freshness. Best-effort by contract of the caller — the screen degrades to
 * "no chips" on any read failure (fail-quiet).
 */
export async function readInstalledUpdateReadouts(
  installedPackageNames: string[],
  opts?: { store?: ExtensionUpdateReadModelStore; now?: Date; ttlMs?: number },
): Promise<InstalledUpdateReadout[]> {
  const store = opts?.store ?? getExtensionUpdateReadModelStore();
  return readUpdateModelForInstalled(store, installedPackageNames, {
    now: opts?.now ?? new Date(),
    ttlMs: opts?.ttlMs ?? UPDATE_READ_MODEL_TTL_MS,
  });
}
