/**
 * Derived-store ownership helpers.
 *
 * Derived data stores (objects, graphiti_projection_outbox, embedding rows,
 * cached previews) carry the canonical ownership tuple — organization_id,
 * owner_type, owner_id, visibility — mirroring the source resource.
 * Visibility filtering uses these columns in WHERE clauses; this module supplies:
 *
 *   - buildOwnershipFilter(actor): parameterised SQL fragment safe to splice
 *     into a raw pg WHERE clause. Returns positional ($1, $2, ...) placeholders
 *     starting at 1 — callers using a higher base must remap.
 *
 *   - lazyBackfillOwnershipOnRead(row, sourceLookup, persist): for legacy rows
 *     written before this migration, look up the canonical ownership from the
 *     source resource on read, fire-and-forget a persist UPDATE, and return the
 *     enriched row in-memory.
 */

import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DerivedStoreOwnership = {
  organizationId: string | null;
  ownerType: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: string;
};

export type OwnershipFilterFragment = {
  /** Parameterised SQL fragment, no leading WHERE. */
  sql: string;
  /** Positional parameter values matching $1..$N in `sql`. */
  params: unknown[];
};

// ---------------------------------------------------------------------------
// buildOwnershipFilter
// ---------------------------------------------------------------------------

/**
 * Build a parameterised SQL fragment that filters derived-store rows visible
 * to the given actor. Visibility kinds covered:
 *
 *   - owner: owner_id = principalId
 *   - org: visibility = 'org' AND organization_id = actor.organizationId
 *   - team:<id>: visibility LIKE 'team:%' AND substring(visibility, 6) = ANY(actor.teamIds)
 *   - project:<id>: visibility LIKE 'project:%' AND substring(visibility, 9) = ANY(actor.projectIds)
 *   - workspace: visibility = 'workspace' (anyone in the platform)
 *   - admin: visibility = 'admin' (only when actor.platformRole === 'platform_admin')
 *
 * The clauses are OR-joined and wrapped in parentheses so callers can splice
 * the result directly: `WHERE ${frag.sql} AND ...`.
 */
export function buildOwnershipFilter(actor: ActorContext): OwnershipFilterFragment {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const ph = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Owner — direct principal match.
  clauses.push(`owner_id = ${ph(actor.principalId)}`);

  // Org — visibility = 'org' AND org_id matches actor.organizationId.
  // The canonical column on objects + graphiti_projection_outbox is `org_id`
  // (not `organization_id` — see drizzle-store.ts buildCreateStoreSchemaQueries).
  // Always emit the param even when actor.organizationId is undefined so the
  // positional sequence stays predictable; pg treats `= NULL` as never-match.
  clauses.push(`(visibility = 'org' AND org_id = ${ph(actor.organizationId ?? null)})`);

  // Team — visibility LIKE 'team:%' AND the suffix is in actor.teamIds.
  const teamIds = actor.teamIds ?? [];
  clauses.push(
    `(visibility LIKE 'team:%' AND substring(visibility from 6) = ANY(${ph(teamIds)}::text[]))`,
  );

  // Project — visibility LIKE 'project:%' AND suffix in actor.projectIds.
  const projectIds = actor.projectIds ?? [];
  clauses.push(
    `(visibility LIKE 'project:%' AND substring(visibility from 9) = ANY(${ph(projectIds)}::text[]))`,
  );

  // Workspace visibility must be scoped to the owning org. Matching every
  // row regardless of actor org/membership would let synthesized loopback
  // contexts or undefined-org contexts leak workspace-visibility rows across
  // orgs. Require either (a) the row's org_id matches the actor's organizationId,
  // or (b) the actor is a platform admin. This makes workspace-visibility mean
  // "visible to anyone in the OWNING org" — multi-tenant safe.
  if (actor.platformRole === "platform_admin") {
    clauses.push(`visibility = 'workspace'`);
  } else {
    // Load-bearing fail-closed invariant: when actor.organizationId is
    // undefined this becomes `org_id = NULL`, which never matches in
    // Postgres SQL — a non-admin actor with no org claim sees zero rows.
    // Do NOT swap `=` for `IS NOT DISTINCT FROM` here; that would let
    // null-org actors read every workspace-visible row across all orgs.
    clauses.push(
      `(visibility = 'workspace' AND org_id = ${ph(actor.organizationId ?? null)})`,
    );
  }

  // Admin — only platform admins.
  if (actor.platformRole === "platform_admin") {
    clauses.push(`visibility = 'admin'`);
  }

  return {
    sql: `(${clauses.join(" OR ")})`,
    params,
  };
}

// ---------------------------------------------------------------------------
// lazyBackfillOwnershipOnRead
// ---------------------------------------------------------------------------

type MaybeOwnedRow = {
  ownerType?: string | null;
  ownerId?: string | null;
  visibility?: string | null;
  organizationId?: string | null;
};

/**
 * For a legacy row missing ownership columns, fetch the canonical tuple from
 * the source resource via `sourceLookup`, fire-and-forget the `persist` UPDATE,
 * and return the row enriched in-memory.
 *
 * Behaviour:
 *   - If the row already has ownerType populated, returns the row untouched
 *     and never invokes lookup/persist.
 *   - If sourceLookup returns null (orphan row), returns the row untouched
 *     and skips persist.
 *   - persist() is invoked synchronously with the resolved tuple — the caller
 *     decides whether to await or fire-and-forget.
 */
export async function lazyBackfillOwnershipOnRead<T extends MaybeOwnedRow>(
  row: T,
  sourceLookup: () => Promise<DerivedStoreOwnership | null>,
  persist: (o: DerivedStoreOwnership) => void,
): Promise<T> {
  if (row.ownerType) {
    return row;
  }
  const resolved = await sourceLookup();
  if (!resolved) {
    return row;
  }
  persist(resolved);
  return {
    ...row,
    organizationId: resolved.organizationId,
    ownerType: resolved.ownerType,
    ownerId: resolved.ownerId,
    visibility: resolved.visibility,
  } as T;
}
