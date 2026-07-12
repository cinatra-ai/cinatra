import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  buildCompareAndSwapMetadataQuery,
  buildDeleteMetadataByPrefixQuery,
  buildDeleteMetadataQuery,
  buildReadMetadataQuery,
  buildWriteMetadataQuery,
} from "@/lib/drizzle-store";

// ---------------------------------------------------------------------------
// Core-store key/value metadata primitives (extracted from database.ts, #303).
//
// These are the low-level synchronous readers/writers over the single-row
// `metadata` table. They remain on the synchronous Postgres bridge
// (`runPostgresQueriesSync`) deliberately: this is BOOT-TIME / settings state
// (startup dataset, connector/agent config, LLM provider pins) read on cold
// paths, NOT a per-request hot store — see the #303 sync-bridge inventory
// (`docs/architecture/postgres-sync-inventory.json`), where they are classified
// `migratable-background-setup`. They live in their own module so `database.ts`
// stays focused on the higher-level store surface that imports them.
// ---------------------------------------------------------------------------

export function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readMetadataValueInternal<T>(key: string, fallback: T): T {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildReadMetadataQuery(postgresSchema, key)],
  });

  const row = result?.rows?.[0] as { value?: string } | undefined;
  if (!row?.value) {
    return fallback;
  }

  return safeParseJson(row.value, fallback);
}

export function writeMetadataValueInternal(key: string, value: unknown) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildWriteMetadataQuery(postgresSchema, key, JSON.stringify(value))],
  });
}

// Read the RAW stored `value` string for a metadata key (no parse/normalize),
// or null when the row is absent. Used to capture a byte-accurate snapshot for
// the connector-config seal-on-read compare-and-swap.
export function readRawMetadataStringInternal(key: string): string | null {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildReadMetadataQuery(postgresSchema, key)],
  });
  const row = result?.rows?.[0] as { value?: string } | undefined;
  return row?.value ?? null;
}

// Atomically update a metadata row's value to `newValue` ONLY when the stored
// value is byte-equal to `expectedRaw`. Returns true when the swap landed (a
// row was affected). A concurrent write that changed the stored value makes the
// swap a no-op (returns false) so the caller's stale value is never persisted.
export function compareAndSwapMetadataValueInternal(
  key: string,
  newValue: string,
  expectedRaw: string,
): boolean {
  ensurePostgresSchema();
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildCompareAndSwapMetadataQuery(postgresSchema, key, newValue, expectedRaw)],
  });
  return (result?.rows?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Skills-catalog generation token (cinatra#1364, lifecycle A4).
//
// CROSS-PROCESS cache invalidation for the skills catalog: every catalog
// writer bumps this metadata row to a fresh opaque token IN THE SAME
// TRANSACTION as its row writes, and `readSkillCatalogFromDatabase` keys its
// in-process cache on the token instead of a process-local counter. A write
// from ANY process (web, BullMQ worker) therefore invalidates every other
// process's cache on its next read. A fresh-random token (instead of an
// increment) keeps the bump a single blind UPSERT — no read-modify-write.
// ---------------------------------------------------------------------------

export const SKILL_CATALOG_GENERATION_METADATA_KEY = "skills_catalog_generation";

/** Raw stored token string (byte-opaque), or null when never bumped. */
export function readSkillCatalogGenerationTokenInternal(): string | null {
  return readRawMetadataStringInternal(SKILL_CATALOG_GENERATION_METADATA_KEY);
}

/**
 * Query fragment that bumps the generation token to a fresh random value.
 * Appended by every skills-catalog writer to ITS OWN query batch so the bump
 * commits atomically with the row writes (fencing: a reader can never observe
 * new rows under an old token committed separately, or vice versa).
 */
export function buildBumpSkillCatalogGenerationQuery(schema: string) {
  return buildWriteMetadataQuery(
    schema,
    SKILL_CATALOG_GENERATION_METADATA_KEY,
    JSON.stringify(randomUUID()),
  );
}

export function deleteMetadataValueInternal(key: string) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildDeleteMetadataQuery(postgresSchema, key)],
  });
}

export function deleteMetadataByPrefixInternal(prefix: string) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildDeleteMetadataByPrefixQuery(postgresSchema, prefix)],
  });
}
