/**
 * Locked org lifecycle-state read — cinatra#1938 (archive epic S2).
 *
 * One FOR SHARE read under the org write lock feeds both the capability ruling
 * and the permit's epoch binding. `archiveEpoch` is the S2 organization
 * additionalField (integer, default 0, never client-settable — the S1
 * archivedAt precedent); COALESCE covers rows created before the migration.
 */
import { sql } from "drizzle-orm";
import type { OrgWriteTx } from "./locks";

export interface OrgWriteState {
  readonly archivedAt: Date | string | null;
  readonly archiveEpoch: number;
}

/** Tolerate both node-postgres result shapes ({ rows } or bare arrays). */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (
    result !== null &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/** Returns null when the organization does not exist (caller refuses). */
export async function readOrgWriteState(
  tx: OrgWriteTx,
  orgId: string,
): Promise<OrgWriteState | null> {
  const result = await tx.execute(
    sql`SELECT "archivedAt", COALESCE("archiveEpoch", 0)::int AS "archiveEpoch" FROM public."organization" WHERE id = ${orgId} FOR SHARE`,
  );
  const rows = rowsOf(result);
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    archivedAt: (row.archivedAt ?? null) as Date | string | null,
    archiveEpoch: Number(row.archiveEpoch ?? 0),
  };
}

/** Trusted-identifier fence for the caller-supplied app schema name (the
 *  kernel cannot import host config; the resolvers pass the schema once). */
export function assertSafeSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`org-write-kernel: unsafe schema name ${JSON.stringify(schema)}`);
  }
}
