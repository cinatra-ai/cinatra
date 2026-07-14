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

// ---------------------------------------------------------------------------
// Memory-scope projection lanes (cinatra#1379, epic #1373).
//
// `@cinatra-ai/memory:concept` rows NEST under the existing per-org lane
// (`deriveProjectionGroupId` above — unchanged for every non-memory type) so a
// concept's Graphiti lane is derived SERVER-SIDE from its canonical scope
// columns (owner_level / owner_id / visibility / project_id). There is NO
// client-supplied lane surface: a caller never names a lane; the projector and
// the recall handler both compute it here from persisted scope, so the two can
// never diverge.
//
// Derivation table (memory rows only) — mirrors buildOwnershipFilter's read
// axes so a row lands in a lane its authorized readers are actually entitled to:
//   visibility='public'                                     -> terminal skip
//   ownerLevel='user' AND visibility in {private,team}      -> <org-lane>-user-<ownerId>
//   ownerLevel='team'                                       -> <org-lane>-team-<ownerId>
//   visibility='organization' OR ownerLevel in {org,ws}     -> <org-lane>          (ambient)
// The team lane is gated on the OWNER axis (ownerLevel='team' + a real team
// ownerId), NOT on `visibility='team'` alone: buildOwnershipFilter admits a
// visibility='team' row ONLY through `owner_level='team' AND owner_id ∈ teamIds`
// ("visibility='team' rows are team-owned by construction"), so a visibility=
// 'team' row that is NOT team-owned is readable by no team — only by its owning
// principal via the owner axis. A user-owned such row therefore nests in the
// OWNING USER's lane (which deriveEntitledMemoryLanes actually names), never a
// phantom `-team-<userId>` lane no actor's entitlement set could ever reach.
// Project axis (orthogonal): any base lane for a row carrying project_id is
// suffixed `-proj-<projectId>`; rows without a project stay in the ambient base
// lane. Public is checked FIRST (a public row is never projected regardless of
// owner level); an unclassifiable scope fails CLOSED (skip, never broaden).
// ---------------------------------------------------------------------------

/** The canonical scope of a memory-concept row, read straight off the
 * `objects` row (no client input). */
export type MemoryConceptScope = {
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
};

/** Lane derivation outcome: a concrete lane, or a terminal skip (public /
 * unclassifiable — same shape the projector already uses for source-gate and
 * claim skips). */
export type MemoryLaneDerivation =
  | { kind: "lane"; groupId: string }
  | { kind: "skip"; reason: string };

/** Suffix a base lane with the project axis when a project_id is present. */
function withProjectAxis(baseLane: string, projectId: string | null): string {
  return projectId ? `${baseLane}-proj-${projectId}` : baseLane;
}

/**
 * Server-derive the Graphiti lane for a `@cinatra-ai/memory:concept` row from
 * its canonical scope. Nests under `deriveProjectionGroupId(orgId)` — it never
 * replaces the org lane, and non-memory types keep using the org lane directly.
 * Returns a terminal `skip` for `visibility='public'` (not projected in this
 * iteration) and for any scope that matches none of the classes (fail-closed:
 * an unclassifiable or ownerId-less user/team scope is never projected rather
 * than leaked into a wrong or malformed lane).
 */
export function deriveMemoryConceptLane(
  orgId: string | null,
  scope: MemoryConceptScope,
): MemoryLaneDerivation {
  // Public rows are terminal-skipped BEFORE any lane math — a public concept
  // is not projected in this iteration regardless of its owner level.
  if (scope.visibility === "public") {
    return { kind: "skip", reason: "memory concept visibility='public' is not projected in this iteration" };
  }
  const base = deriveProjectionGroupId(orgId);

  // user lane: a per-user lane. Requires a concrete ownerId (the user id).
  // Covers visibility='private' (the default save scope for human- and
  // agent-authored memory rows) AND a
  // user-owned visibility='team' row: buildOwnershipFilter reads a user-owned
  // row for the owning user regardless of its visibility axis, and the owning
  // user's entitlement includes exactly this `-user-<ownerId>` lane — whereas a
  // `-team-<userId>` lane would be unrecallable (no actor's teamIds names it).
  if (
    scope.ownerLevel === "user" &&
    (scope.visibility === "private" || scope.visibility === "team")
  ) {
    if (!scope.ownerId) {
      return { kind: "skip", reason: "user memory concept has no ownerId — cannot form a user lane" };
    }
    return { kind: "lane", groupId: withProjectAxis(`${base}-user-${scope.ownerId}`, scope.projectId) };
  }

  // team lane: gated on the OWNER axis alone (ownerLevel='team' + a real team
  // ownerId) — NOT `visibility==='team'`, which a user-owned row can carry
  // without being team-readable (see the derivation-table note above).
  if (scope.ownerLevel === "team") {
    if (!scope.ownerId) {
      return { kind: "skip", reason: "team memory concept has no ownerId — cannot form a team lane" };
    }
    return { kind: "lane", groupId: withProjectAxis(`${base}-team-${scope.ownerId}`, scope.projectId) };
  }

  // org / workspace: the ambient org lane (memory nests here alongside every
  // non-memory type's ambient projection).
  if (
    scope.visibility === "organization" ||
    scope.ownerLevel === "organization" ||
    scope.ownerLevel === "workspace"
  ) {
    return { kind: "lane", groupId: withProjectAxis(base, scope.projectId) };
  }

  // Fail-closed: a scope matching none of the classes (an unexpected
  // owner_level/visibility enum combination) is never projected.
  return {
    kind: "skip",
    reason: `unclassifiable memory concept scope (ownerLevel=${scope.ownerLevel}, visibility=${scope.visibility}) — not projected`,
  };
}

/** The actor's server-derived entitlement context for a memory recall. */
export type MemoryLaneEntitlement = {
  orgId: string | null;
  /** The actor's user id (null for a sessionless/system caller). */
  userId: string | null;
  /** Team ids the actor is a member of within `orgId` (server-resolved). */
  teamIds: readonly string[];
  /** The project in the call's context (null = ambient recall). */
  projectId: string | null;
};

/**
 * Server-derive the set of Graphiti lanes a caller is entitled to read for a
 * memory recall: the ambient org lane + the caller's own user lane + a team
 * lane for EVERY team the caller belongs to. When a projectId is in the call's
 * context, each entitled base lane is ALSO supplied in its `-proj-<id>` form so
 * project-scoped concepts surface alongside ambient ones. A lane the caller is
 * not entitled to (an unentitled team, an unentitled project) is never in the
 * result. Deterministic order; deduplicated.
 */
export function deriveEntitledMemoryLanes(entitlement: MemoryLaneEntitlement): string[] {
  const base = deriveProjectionGroupId(entitlement.orgId);
  const baseLanes: string[] = [base];
  if (entitlement.userId) baseLanes.push(`${base}-user-${entitlement.userId}`);
  for (const teamId of entitlement.teamIds) {
    if (teamId) baseLanes.push(`${base}-team-${teamId}`);
  }
  const lanes = new Set<string>(baseLanes);
  if (entitlement.projectId) {
    for (const lane of baseLanes) lanes.add(`${lane}-proj-${entitlement.projectId}`);
  }
  return [...lanes];
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
