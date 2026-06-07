import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { objectSyncAdapterConfigs } from "../schema";

// ---------------------------------------------------------------------------
// ObjectSyncAdapterConfigRow is the public shape for config store results.
//
// The adapterId name disambiguates object sync adapters from transport
// "connector" packages.
// ---------------------------------------------------------------------------

export type ObjectSyncAdapterConfigRow = {
  id: string;
  objectType: string;
  adapterId: string;
  config: Record<string, unknown>;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Read all ACTIVE sync-adapter configs for a given object type. Used at
 * `objects_save` completion to dispatch export jobs.
 *
 * Uses the `WHERE is_active = true` partial index
 * `object_sync_adapter_configs_type_idx` defined in schema.ts.
 */
export async function readActiveObjectSyncAdapterConfigs(
  objectType: string,
): Promise<ObjectSyncAdapterConfigRow[]> {
  const rows = await db
    .select()
    .from(objectSyncAdapterConfigs)
    .where(
      and(
        eq(objectSyncAdapterConfigs.objectType, objectType),
        eq(objectSyncAdapterConfigs.isActive, true),
      ),
    );
  return rows.map(mapRow);
}

/** Read all sync-adapter configs for a given object type - used by admin UI. */
export async function readAllObjectSyncAdapterConfigs(
  objectType: string,
): Promise<ObjectSyncAdapterConfigRow[]> {
  const rows = await db
    .select()
    .from(objectSyncAdapterConfigs)
    .where(eq(objectSyncAdapterConfigs.objectType, objectType));
  return rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Upsert a per-type sync-adapter config atomically via INSERT ... ON CONFLICT DO UPDATE.
 * Replaces the prior SELECT-then-INSERT pattern that had a TOCTOU race: two concurrent
 * calls for the same (objectType, adapterId) pair could both observe no existing row
 * and both attempt INSERT, causing a unique constraint violation.
 * Key is (objectType, adapterId) - unique index defined in schema.ts.
 */
export async function upsertObjectSyncAdapterConfig(input: {
  objectType: string;
  adapterId: string;
  config: Record<string, unknown>;
  isActive: boolean;
  createdBy?: string | null;
}): Promise<ObjectSyncAdapterConfigRow> {
  const result = await db
    .insert(objectSyncAdapterConfigs)
    .values({
      id: randomUUID(),
      objectType: input.objectType,
      adapterId: input.adapterId,
      config: input.config,
      isActive: input.isActive,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [objectSyncAdapterConfigs.objectType, objectSyncAdapterConfigs.adapterId],
      set: {
        config: input.config,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return mapRow(result[0]);
}

// ---------------------------------------------------------------------------
// Internal mapper
// ---------------------------------------------------------------------------

function mapRow(r: typeof objectSyncAdapterConfigs.$inferSelect): ObjectSyncAdapterConfigRow {
  return {
    id: r.id,
    objectType: r.objectType,
    adapterId: r.adapterId,
    config: r.config as Record<string, unknown>,
    isActive: r.isActive,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
