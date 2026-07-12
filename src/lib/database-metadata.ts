import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  buildCompareAndSwapMetadataQuery,
  buildDeleteMetadataByPrefixQuery,
  buildDeleteMetadataQuery,
  buildInsertMetadataIfAbsentQuery,
  buildReadMetadataQuery,
  buildSelectJsonRowsQuery,
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

// INSERT-IF-ABSENT: seed a metadata row ONLY when no row exists yet. Unlike
// `writeMetadataValueInternal` (unconditional upsert) this can NEVER clobber a
// concurrent writer's value — the lease-bootstrap path depends on that
// (cinatra#1364): two racing bootstrappers both attempt the seed, one no-ops,
// and the CAS that follows elects exactly one lease winner.
export function writeMetadataValueIfAbsentInternal(key: string, value: unknown) {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [buildInsertMetadataIfAbsentQuery(postgresSchema, key, JSON.stringify(value))],
  });
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

/**
 * GUARDED metadata upsert (cinatra#1364 completeness fence): writes `writeKey`
 * in the SAME single statement that validates `guardKey` still carries
 * `guardToken` (`value::jsonb->>'token'`). Statement-atomic in Postgres, so it
 * closes the check-then-write TOCTOU where a lease holder validates ownership,
 * stalls past its TTL, and then stamps its fence over a stealer's: a stealer
 * whose CAS committed before this statement's snapshot makes the guard fail
 * (no write); one committing after simply overwrites LATER with newer truth.
 * Returns true iff the write landed.
 */
export function writeMetadataValueIfGuardTokenHeldInternal(
  writeKey: string,
  value: unknown,
  guardKey: string,
  guardToken: string,
): boolean {
  ensurePostgresSchema();
  const table = `"${postgresSchema.replaceAll('"', '""')}"."metadata"`;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `INSERT INTO ${table} (key, value) ` +
          `SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM ${table} WHERE key = $3 AND (value::jsonb ->> 'token') = $4) ` +
          `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value ` +
          `RETURNING key`,
        values: [writeKey, JSON.stringify(value), guardKey, guardToken],
      },
    ],
  });
  return (result?.rows?.length ?? 0) > 0;
}

export type SkillCatalogRowsFencedRead = {
  data: { skillPackages: Array<Record<string, unknown>>; skills: Array<Record<string, unknown>> };
  token: string | null;
  /** True when the token was stable across the whole read (safe to cache). */
  fenced: boolean;
};

/**
 * FENCED full catalog read (cinatra#1364): one sequential batch on one
 * connection reads token → skill_packages → skills → token and retries when
 * the two token reads differ. Every catalog writer bumps the token in its own
 * transaction, so a stable token PROVES no writer committed between the two
 * row reads — the caller can never observe a torn {old packages, new skills}
 * mix. After the retry budget (pathological write storm) the last read is
 * returned with `fenced: false` so the caller serves it WITHOUT caching.
 */
export function readSkillCatalogRowsFencedInternal(): SkillCatalogRowsFencedRead {
  ensurePostgresSchema();
  const parseRows = (result: { rows?: unknown[] } | undefined) =>
    ((result?.rows ?? []) as Array<{ payload: string }>)
      .map((row) => safeParseJson<Record<string, unknown> | null>(row.payload, null))
      .filter(Boolean) as Array<Record<string, unknown>>;
  const tokenOf = (result: { rows?: unknown[] } | undefined) =>
    ((result?.rows?.[0] as { value?: string } | undefined)?.value ?? null);

  let last: SkillCatalogRowsFencedRead | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [t0, pkgs, skills, t1] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        buildReadMetadataQuery(postgresSchema, SKILL_CATALOG_GENERATION_METADATA_KEY),
        buildSelectJsonRowsQuery(postgresSchema, "skill_packages"),
        buildSelectJsonRowsQuery(postgresSchema, "skills"),
        buildReadMetadataQuery(postgresSchema, SKILL_CATALOG_GENERATION_METADATA_KEY),
      ],
    });
    const tokenBefore = tokenOf(t0);
    const tokenAfter = tokenOf(t1);
    last = {
      data: { skillPackages: parseRows(pkgs), skills: parseRows(skills) },
      token: tokenAfter,
      fenced: tokenBefore === tokenAfter,
    };
    if (last.fenced) return last;
  }
  console.warn(
    "[database-metadata] skills-catalog fenced read exhausted retries under a write storm — serving the freshest read uncached.",
  );
  return last!;
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
