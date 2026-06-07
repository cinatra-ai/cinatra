import "server-only";
import { and, eq, notInArray, sql } from "drizzle-orm";
import {
  anthropicSkillSync,
  anthropicSkillSyncDb,
} from "@/lib/anthropic-skill-sync-store";

/**
 * Namespace-scoped DAO for `cinatra.anthropic_skill_sync`.
 *
 * EVERY operation is scoped to a single (apiKeyFingerprint, environment)
 * namespace. There is NO remote-deletion path here: the only mutating ops are
 * upsert + mark-stale; staleness is a purely local boolean. Remote GC is
 * reference-counted and lease-aware.
 */

export type SyncRowDao = {
  catalogSkillId: string;
  anthropicSkillId: string;
  anthropicVersion: string;
  contentHash: string;
  stale: boolean;
};

export async function readSyncRow(
  apiKeyFingerprint: string,
  environment: string,
  catalogSkillId: string,
): Promise<SyncRowDao | null> {
  const rows = await anthropicSkillSyncDb
    .select()
    .from(anthropicSkillSync)
    .where(
      and(
        eq(anthropicSkillSync.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillSync.environment, environment),
        eq(anthropicSkillSync.catalogSkillId, catalogSkillId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    catalogSkillId: r.catalogSkillId,
    anthropicSkillId: r.anthropicSkillId,
    anthropicVersion: r.anthropicVersion,
    contentHash: r.contentHash,
    stale: r.stale,
  };
}

export async function upsertSyncRow(
  apiKeyFingerprint: string,
  environment: string,
  row: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    contentHash: string;
  },
): Promise<void> {
  await anthropicSkillSyncDb
    .insert(anthropicSkillSync)
    .values({
      apiKeyFingerprint,
      environment,
      catalogSkillId: row.catalogSkillId,
      anthropicSkillId: row.anthropicSkillId,
      anthropicVersion: row.anthropicVersion,
      contentHash: row.contentHash,
      stale: false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        anthropicSkillSync.apiKeyFingerprint,
        anthropicSkillSync.environment,
        anthropicSkillSync.catalogSkillId,
      ],
      set: {
        anthropicSkillId: row.anthropicSkillId,
        anthropicVersion: row.anthropicVersion,
        contentHash: row.contentHash,
        stale: false,
        updatedAt: new Date(),
      },
    });
}

export async function markSyncRowStale(
  apiKeyFingerprint: string,
  environment: string,
  catalogSkillId: string,
): Promise<void> {
  await anthropicSkillSyncDb
    .update(anthropicSkillSync)
    .set({
      stale: true,
      // Stamp stale_at on the false->true transition ONLY: the GC grace clock
      // must not reset when mark-stale re-runs on an already-stale row.
      // COALESCE keeps an existing stale_at; sets now() only when null.
      staleAt: sql`coalesce(${anthropicSkillSync.staleAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(anthropicSkillSync.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillSync.environment, environment),
        eq(anthropicSkillSync.catalogSkillId, catalogSkillId),
      ),
    );
}

/**
 * Mark stale every row in THIS namespace whose catalog_skill_id is no longer
 * in the catalog. Namespace-scoped, never global. NO remote deletion.
 */
export async function markStaleForRemovedCatalogSkills(
  apiKeyFingerprint: string,
  environment: string,
  currentCatalogIds: string[],
): Promise<void> {
  const namespace = and(
    eq(anthropicSkillSync.apiKeyFingerprint, apiKeyFingerprint),
    eq(anthropicSkillSync.environment, environment),
  );
  // Same false->true-only stale_at stamp as markSyncRowStale.
  const staleSet = {
    stale: true,
    staleAt: sql`coalesce(${anthropicSkillSync.staleAt}, now())`,
    updatedAt: new Date(),
  };
  if (currentCatalogIds.length === 0) {
    // Empty catalog ⇒ every row in this namespace is removed.
    await anthropicSkillSyncDb
      .update(anthropicSkillSync)
      .set(staleSet)
      .where(namespace);
    return;
  }
  await anthropicSkillSyncDb
    .update(anthropicSkillSync)
    .set(staleSet)
    .where(
      and(
        namespace,
        notInArray(anthropicSkillSync.catalogSkillId, currentCatalogIds),
      ),
    );
}

/**
 * Serialize concurrent admin-save/setup syncs per namespace via a
 * transaction-scoped Postgres advisory lock so two racing saves don't both
 * detect drift and create duplicate immutable remote versions. The callback
 * runs inside the locked transaction; the lock auto-releases at COMMIT.
 */
export async function withNamespaceSyncLock<T>(
  apiKeyFingerprint: string,
  environment: string,
  fn: () => Promise<T>,
): Promise<T> {
  return anthropicSkillSyncDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${apiKeyFingerprint + "" + environment}))`,
    );
    return fn();
  });
}

// ---------------------------------------------------------------------------
// GC sync-row accounting (namespace-scoped)
// ---------------------------------------------------------------------------

export type GcSyncRowDao = {
  catalogSkillId: string;
  anthropicSkillId: string;
  anthropicVersion: string;
  stale: boolean;
  /** ms epoch, or null when GC must fail closed. */
  staleAtMs: number | null;
};

/** List EVERY sync row in this namespace (the GC engine groups by skill id). */
export async function listAllSyncRows(
  apiKeyFingerprint: string,
  environment: string,
): Promise<GcSyncRowDao[]> {
  const rows = await anthropicSkillSyncDb
    .select()
    .from(anthropicSkillSync)
    .where(
      and(
        eq(anthropicSkillSync.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillSync.environment, environment),
      ),
    );
  return rows.map((r) => ({
    catalogSkillId: r.catalogSkillId,
    anthropicSkillId: r.anthropicSkillId,
    anthropicVersion: r.anthropicVersion,
    stale: r.stale,
    staleAtMs: r.staleAt ? r.staleAt.getTime() : null,
  }));
}

/**
 * Reconcile-away the locally-stale rows for an anthropic skill AFTER it was
 * remotely reclaimed. Explicitly filters (fp, env, anthropic_skill_id)
 * -- never relies on remote-id global uniqueness (one Anthropic key is shared
 * across multiple runtime environments).
 */
export async function deleteSyncRowsForAnthropicSkill(
  apiKeyFingerprint: string,
  environment: string,
  anthropicSkillId: string,
): Promise<void> {
  await anthropicSkillSyncDb
    .delete(anthropicSkillSync)
    .where(
      and(
        eq(anthropicSkillSync.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillSync.environment, environment),
        eq(anthropicSkillSync.anthropicSkillId, anthropicSkillId),
      ),
    );
}
