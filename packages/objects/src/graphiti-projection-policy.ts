import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

// ---------------------------------------------------------------------------
// Projection-policy epoch bookkeeping — the SHARED half both the projector
// (stale-epoch fencing in the outbox worker) and the rebuild driver consume
// (cinatra#1427 AC-4, epic #1424 projection decision). Kept out of
// graphiti-projector.ts / graphiti-rebuild.ts so the two never import each
// other (the rebuild driver imports the projector's worker for the composite
// cycle; the projector needs the epoch read for fencing).
//
// Epoch model: ONE integer epoch per org-group (`cinatra-org-<id>` /
// `cinatra-default`), stored in `graphiti_projection_policy`. A group with no
// row is implicitly at epoch 1. Epochs only move FORWARD (a rollback is a new
// fenced rebuild at a new epoch — see graphiti-rebuild.ts); outbox items
// enqueued by a rebuild replay are stamped with their target epoch and the
// worker DISCARDS any stamped item whose epoch is older than the group's
// current epoch (stale-epoch work is fenced out, never projected).
// ---------------------------------------------------------------------------

/** The rebuild-journal phase vocabulary — mirrors the DDL CHECK
 * `graphiti_rebuild_journal_phase_check` in
 * src/lib/graphiti-projection-policy-schema.ts (the rebuild unit test asserts
 * the two stay in sync). */
export const REBUILD_JOURNAL_PHASES = ["clearing", "replaying", "verifying", "done"] as const;
export type RebuildJournalPhase = (typeof REBUILD_JOURNAL_PHASES)[number];

/** Org-group derivation — the projector's group naming, shared. */
export function deriveProjectionGroupId(orgId: string | null): string {
  return orgId ? `cinatra-org-${orgId}` : "cinatra-default";
}

/** Inverse of deriveProjectionGroupId (the rebuild driver stores org_id on
 * the journal; explicit rollback entry points only have the group id). */
export function orgIdFromProjectionGroupId(groupId: string): string | null {
  return groupId === "cinatra-default"
    ? null
    : groupId.startsWith("cinatra-org-")
      ? groupId.slice("cinatra-org-".length)
      : null;
}

/**
 * Current projection-policy epoch for a set of groups (one query). A group
 * with no policy row is at the implicit initial epoch 1.
 */
export function readProjectionEpochs(groupIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (groupIds.length === 0) return out;
  for (const g of groupIds) out.set(g, 1);
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT group_id, epoch FROM "${schema}"."graphiti_projection_policy" WHERE group_id = ANY($1::text[])`,
        values: [Array.from(groupIds)],
      },
    ],
  });
  for (const row of (result?.rows ?? []) as Array<{ group_id: string; epoch: number }>) {
    out.set(String(row.group_id), Number(row.epoch));
  }
  return out;
}
