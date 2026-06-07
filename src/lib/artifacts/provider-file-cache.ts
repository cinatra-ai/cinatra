import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";

// Provider-file-ref cache store (app side, DB-backed). Keyed by
// (org, version, digest, provider). The llm adapters consume this
// via an injected port, so orchestration never imports @/lib directly. Holds
// provider refs only, NEVER bytes. Expiry-aware: a hit past `expires_at` is
// treated as a miss so the adapter re-uploads and refreshes the row.

export type ProviderCacheKey = {
  orgId: string;
  artifactId: string;
  // Aligns with the semantic Representation contract. SQL column stays
  // `representation_revision_id` until the provider-cache key is migrated.
  representationRevisionId: string;
  digest: string;
  provider: string;
};

export type ProviderCacheHit = {
  providerFileId: string;
  mime: string;
  sizeBytes: number;
  expiresAt: string | null;
};

/** Live (non-expired) provider file id for this key, else null (miss). */
export function getCachedProviderFile(
  key: ProviderCacheKey,
): ProviderCacheHit | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT provider_file_id, mime, size_bytes, expires_at
FROM "${schema}"."artifact_provider_cache"
WHERE org_id = $1 AND representation_revision_id = $2 AND digest = $3 AND provider = $4
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`,
        values: [key.orgId, key.representationRevisionId, key.digest, key.provider],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | {
        provider_file_id: string;
        mime: string;
        size_bytes: string | number;
        expires_at: string | null;
      }
    | undefined;
  if (!row) return null;
  // Touch last_used_at (best-effort; not on the hot read path's critical
  // section - a separate cheap statement).
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."artifact_provider_cache" SET last_used_at = now()
WHERE org_id = $1 AND representation_revision_id = $2 AND digest = $3 AND provider = $4`,
        values: [key.orgId, key.representationRevisionId, key.digest, key.provider],
      },
    ],
  });
  return {
    providerFileId: row.provider_file_id,
    mime: row.mime,
    sizeBytes:
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : Number(row.size_bytes),
    expiresAt: row.expires_at,
  };
}

/** Upsert a provider file ref after a (re)upload. */
export function putCachedProviderFile(
  key: ProviderCacheKey,
  value: {
    providerFileId: string;
    mime: string;
    sizeBytes: number;
    ttlMs?: number;
  },
): void {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const expiresAt =
    typeof value.ttlMs === "number"
      ? new Date(Date.now() + value.ttlMs).toISOString()
      : null;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `INSERT INTO "${schema}"."artifact_provider_cache"
  (id, org_id, artifact_id, representation_revision_id, digest, provider, provider_file_id, mime, size_bytes, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (org_id, representation_revision_id, digest, provider) DO UPDATE SET
  provider_file_id = EXCLUDED.provider_file_id,
  mime             = EXCLUDED.mime,
  size_bytes       = EXCLUDED.size_bytes,
  expires_at       = EXCLUDED.expires_at,
  last_used_at     = now()`,
        values: [
          randomUUID(),
          key.orgId,
          key.artifactId,
          key.representationRevisionId,
          key.digest,
          key.provider,
          value.providerFileId,
          value.mime,
          value.sizeBytes,
          expiresAt,
        ],
      },
    ],
  });
}

/**
 * GC: reap expired rows for a provider, calling `deleteRemote` best-effort
 * for each provider file id, then deleting the rows. Returns count reaped.
 * `deleteRemote` is injected so this store never imports a provider SDK.
 */
export async function evictExpiredProviderFiles(input: {
  // GC MUST be tenant-scoped: a sweep without org_id would reap provider refs
  // across orgs, violating the tenant/ownership invariant. orgId is required.
  orgId: string;
  provider: string;
  deleteRemote: (providerFileId: string) => Promise<void>;
  limit?: number;
}): Promise<{ reaped: number; remoteDeleteFailures: number }> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, provider_file_id
FROM "${schema}"."artifact_provider_cache"
WHERE org_id = $1 AND provider = $2
  AND expires_at IS NOT NULL AND expires_at <= now()
LIMIT ${limit}`,
        values: [input.orgId, input.provider],
      },
    ],
  });
  const rows = (res?.rows ?? []) as Array<{
    id: string;
    provider_file_id: string;
  }>;
  let reaped = 0;
  let remoteDeleteFailures = 0;
  for (const row of rows) {
    // Count remote-delete failures explicitly so the scheduler can WARN when
    // every remote delete is broken (a misconfigured SDK route, expired creds,
    // etc.). DB reaping stays best-effort so a single failing remote delete
    // still cleans up the ref row.
    try {
      await input.deleteRemote(row.provider_file_id);
    } catch {
      remoteDeleteFailures += 1;
    }
    // Recheck staleness + identity on the DELETE. A concurrent cache refresh
    // writes via `ON CONFLICT DO UPDATE` preserving the same `id` but rewriting
    // `provider_file_id` + `expires_at`; if our DELETE matched on `id` alone,
    // we could orphan the freshly-uploaded provider file AND remove a live cache
    // entry. The 4-predicate WHERE makes the delete idempotent against any
    // refresh that landed since the SELECT.
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `DELETE FROM "${schema}"."artifact_provider_cache"
WHERE id = $1
  AND org_id = $2
  AND provider = $3
  AND provider_file_id = $4
  AND expires_at IS NOT NULL AND expires_at <= now()`,
          values: [row.id, input.orgId, input.provider, row.provider_file_id],
        },
      ],
    });
    reaped += 1;
  }
  return { reaped, remoteDeleteFailures };
}

/**
 * List distinct (org_id, provider) pairs that currently have at least one
 * expired row in the cache. Used by the `ARTIFACT_PROVIDER_CACHE_EVICT`
 * scheduled job to drive `evictExpiredProviderFiles` per pair (the function
 * itself is tenant+provider-scoped by design; this helper produces the loop).
 *
 * Returns an empty array when no pair has expired rows.
 */
export function listOrgProvidersWithExpiredCache(): Array<{
  orgId: string;
  provider: string;
}> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT DISTINCT org_id, provider
FROM "${schema}"."artifact_provider_cache"
WHERE expires_at IS NOT NULL AND expires_at <= now()
ORDER BY org_id, provider`,
        values: [],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => {
    const row = r as { org_id: string; provider: string };
    return { orgId: row.org_id, provider: row.provider };
  });
}
