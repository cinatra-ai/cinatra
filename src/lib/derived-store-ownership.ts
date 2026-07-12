/**
 * Derived-store ownership helpers — CANONICAL COLUMN VOCABULARY (cinatra#1428).
 *
 * The objects substrate carries ONE ownership vocabulary, the column model:
 *
 *   - owner_level ∈ 'user' | 'team' | 'organization' | 'workspace'  (owner axis)
 *   - owner_id    — the owning principal's id (user id / team id / org id)
 *   - visibility  ∈ 'private' | 'team' | 'organization' | 'public'  (share axis)
 *   - project_id  — nullable sealed-room refinement, NEVER a 5th ownership tier
 *
 * The legacy composite-string visibility vocabulary ('org', 'workspace',
 * 'team:<id>', 'user:<id>', 'project:<id>', 'owner', 'admin') is RETIRED:
 * migration core__0033 one-shot-normalized every stored row onto the column
 * model (fixed mapping ratified in cinatra#1428), and every writer emits
 * canonical values only. This module supplies:
 *
 *   - buildOwnershipFilter(actor): parameterised SQL fragment safe to splice
 *     into a raw pg WHERE clause over the `objects` columns. Returns positional
 *     ($1, $2, ...) placeholders starting at 1 — callers using a higher base
 *     must remap.
 *
 *   - normalizeOwnershipVocabulary(tuple): the runtime mirror of the
 *     core__0033 mapping. Write boundaries that replay HISTORICAL tuples
 *     (object-history restore snapshots recorded before the cutover) MUST pass
 *     them through this normalizer so composite values never re-enter the
 *     store after the one-shot migration.
 */

import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Canonical vocabulary
// ---------------------------------------------------------------------------

export const CANONICAL_OWNER_LEVELS = [
  "user",
  "team",
  "organization",
  "workspace",
] as const;
export type CanonicalOwnerLevel = (typeof CANONICAL_OWNER_LEVELS)[number];

export const CANONICAL_VISIBILITIES = [
  "private",
  "team",
  "organization",
  "public",
] as const;
export type CanonicalVisibility = (typeof CANONICAL_VISIBILITIES)[number];

const OWNER_LEVEL_SET: ReadonlySet<string> = new Set(CANONICAL_OWNER_LEVELS);
const VISIBILITY_SET: ReadonlySet<string> = new Set(CANONICAL_VISIBILITIES);

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
 * Build a parameterised SQL fragment that filters `objects` rows visible to
 * the given actor, evaluated over the CANONICAL columns
 * (owner_level, owner_id, visibility, project_id, org_id):
 *
 *   - user owner axis:  owner_level = 'user' AND owner_id = principalId
 *     (the owning user always sees their rows, any visibility)
 *   - team owner axis:  owner_level = 'team' AND owner_id ∈ actor.teamIds
 *     (team members see team-owned rows; visibility = 'team' rows are
 *     team-owned by construction, so this ONE clause covers both axes)
 *   - organization:     visibility = 'organization' AND org_id = actor org
 *   - public:           visibility = 'public' AND org_id = actor org —
 *     'public' means "anyone in the OWNING org" (multi-tenant fail-closed,
 *     same invariant the retired 'workspace' composite carried); platform
 *     admins read public rows across orgs
 *   - project axis:     project_id ∈ actor.projectIds — sealed-room
 *     membership admits project-tagged rows (the refinement shares the row
 *     with its room, mirroring the retired 'project:<id>' composite)
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

  // User owner axis — direct principal match on user-owned rows.
  clauses.push(
    `(owner_level = 'user' AND owner_id = ${ph(actor.principalId)})`,
  );

  // Team owner axis — team-owned rows of any team the actor belongs to.
  const teamIds = actor.teamIds ?? [];
  clauses.push(
    `(owner_level = 'team' AND owner_id = ANY(${ph(teamIds)}::text[]))`,
  );

  // Organization visibility — org members see org-visible rows. Always emit
  // the param even when actor.organizationId is undefined so the positional
  // sequence stays predictable; pg treats `= NULL` as never-match.
  clauses.push(
    `(visibility = 'organization' AND org_id = ${ph(actor.organizationId ?? null)})`,
  );

  // Public visibility must be scoped to the owning org. Matching every row
  // regardless of actor org/membership would let synthesized loopback
  // contexts or undefined-org contexts leak public-visibility rows across
  // orgs. Require either (a) the row's org_id matches the actor's
  // organizationId, or (b) the actor is a platform admin. This makes 'public'
  // mean "visible to anyone in the OWNING org" — multi-tenant safe (the same
  // load-bearing invariant the retired 'workspace' composite value carried).
  if (actor.platformRole === "platform_admin") {
    clauses.push(`visibility = 'public'`);
  } else {
    // Load-bearing fail-closed invariant: when actor.organizationId is
    // undefined this becomes `org_id = NULL`, which never matches in
    // Postgres SQL — a non-admin actor with no org claim sees zero rows.
    // Do NOT swap `=` for `IS NOT DISTINCT FROM` here; that would let
    // null-org actors read every public-visible row across all orgs.
    clauses.push(
      `(visibility = 'public' AND org_id = ${ph(actor.organizationId ?? null)})`,
    );
  }

  // Project axis — sealed-room membership. project_id is a refinement, not a
  // tier: a project-tagged row is shared with its room's members regardless
  // of the visibility axis (exactly what the retired 'project:<id>' composite
  // granted). Non-members reach a project-tagged row only through the owner
  // axes above.
  const projectIds = actor.projectIds ?? [];
  clauses.push(
    `(project_id IS NOT NULL AND project_id = ANY(${ph(projectIds)}::text[]))`,
  );

  const visibilitySql = `(${clauses.join(" OR ")})`;

  // OBO scope-ceiling narrowing (agent-run delegated actors ONLY). When the
  // actor carries an anchored-scope ceiling CHAIN (`actor.oboCeiling`), the row
  // must ALSO satisfy EVERY ceiling element (satisfy-all) — the ad-hoc-resolvable
  // adoption of the shared `resourceWithinCeiling` semantics, expressed in SQL.
  // It is AND-ed on top of the visibility OR-set, so it can only NARROW, never
  // widen: even the widened `public` clause a platform-admin invoker gets
  // above stays ceiling-bounded (the load-bearing ordering — the ceiling is
  // NOT written into the OR-set). Non-OBO actors (no oboCeiling) are unaffected.
  // Shared with objects-store.ts (intentional double-cover with the #1051 kernel
  // surface; conflicting edits to this function are not).
  const ceilingSql = buildCeilingClause(actor.oboCeiling, ph);
  return {
    sql: ceilingSql ? `(${visibilitySql} AND ${ceilingSql})` : visibilitySql,
    params,
  };
}

/**
 * Translate an OBO ceiling CHAIN into a satisfy-ALL SQL predicate over the
 * canonical ownership columns, mirroring `resourceWithinCeiling`
 * (@cinatra-ai/mcp-server/obo-ceiling) element-for-element:
 *
 *   - organization → `org_id = <id>`                 (tenancy floor)
 *   - user/team/workspace → `owner_level = <tier> AND owner_id = <id>`
 *                                                     (owner-axis anchor)
 *   - project → `project_id = <id>`                   (project refinement — the
 *                                                     canonical column, post
 *                                                     core__0033; the composite
 *                                                     'project:<id>' visibility
 *                                                     encoding is retired)
 *
 * Elements are AND-joined (a resource must satisfy every applicable ceiling).
 * Returns null when there is no ceiling so callers keep their exact pre-ceiling
 * SQL. `actor.oboCeiling`, when set, is a validated NON-EMPTY chain.
 */
function buildCeilingClause(
  chain: ActorContext["oboCeiling"],
  ph: (v: unknown) => string,
): string | null {
  if (!chain || chain.length === 0) return null;
  const parts: string[] = [];
  for (const c of chain) {
    if (c.tier === "organization") {
      parts.push(`org_id = ${ph(c.id)}`);
    } else if (c.tier === "project") {
      parts.push(`project_id = ${ph(c.id)}`);
    } else {
      // user | team | workspace — owner-axis anchor.
      parts.push(`(owner_level = ${ph(c.tier)} AND owner_id = ${ph(c.id)})`);
    }
  }
  return parts.length > 0 ? `(${parts.join(" AND ")})` : null;
}

// ---------------------------------------------------------------------------
// normalizeOwnershipVocabulary — runtime mirror of core__0033
// ---------------------------------------------------------------------------

export type OwnershipVocabularyTuple = {
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
};

export type NormalizeOwnershipInput = {
  ownerLevel?: string | null;
  ownerId?: string | null;
  visibility?: string | null;
  projectId?: string | null;
  /** The row's org id — the owner_id target for the 'org' composite mapping. */
  orgId?: string | null;
  /**
   * The retired legacy `owner_type` value from a PRE-cutover snapshot, when
   * the caller has one. Mirrors core__0033's pass 0: a bare-default
   * owner_level adopts a recorded canonical owner_type unless the composite
   * visibility mapping claims the row (the fixed mapping always wins).
   */
  ownerType?: string | null;
};

/**
 * Normalize ONE ownership tuple from the retired composite-string vocabulary
 * onto the canonical column model. This is the runtime MIRROR of migration
 * `core__0033_objects-ownership-vocabulary.mjs` (keep the two in lockstep —
 * same fixed mapping, ratified in cinatra#1428):
 *
 *   - 'org'          → owner_level='organization', owner_id=orgId,
 *                      visibility='organization'
 *   - 'workspace'    → owner_level='workspace',    visibility='public'
 *   - 'team:<id>'    → owner_level='team', owner_id=<id>, visibility='team'
 *   - 'user:<id>'    → owner_level='user', owner_id=<id>, visibility='private'
 *   - 'project:<id>' → project_id=<id> (kept if already set),
 *                      visibility='private' (owner axis untouched)
 *   - any other non-canonical value ('owner', 'admin', junk) → 'private'
 *     (fail-closed, mirrors the objects-side normalizeObjectVisibility)
 *   - pass 0 (when the caller supplies the snapshot's legacy `ownerType`):
 *     a bare-default owner_level adopts a recorded canonical owner_type
 *     unless a composite visibility form claims the row.
 *
 * Canonical visibility values and `null` (which callers COALESCE to their own
 * defaults) pass through untouched. A non-canonical ownerLevel passes through
 * unchanged unless the visibility mapping determines it — write boundaries
 * validate levels separately.
 *
 * Used by write boundaries that replay HISTORICAL tuples (object-history
 * restore snapshots recorded before the cutover). New writes never produce
 * composite values.
 */
export function normalizeOwnershipVocabulary(
  input: NormalizeOwnershipInput,
): OwnershipVocabularyTuple {
  let ownerLevel = input.ownerLevel ?? null;
  const ownerId = input.ownerId ?? null;
  const visibility = input.visibility ?? null;
  const projectId = input.projectId ?? null;

  // Pass 0 mirror (legacy lazy-backfill owner_type tuples): a bare-default
  // owner_level ('organization', or null which the write path COALESCEs to
  // 'organization') adopts a recorded canonical owner_type — unless one of
  // the five composite visibility forms below claims the row (the fixed
  // mapping wins, exactly like the migration's statement order).
  const ownerType = input.ownerType ?? null;
  if (
    ownerType !== null &&
    OWNER_LEVEL_SET.has(ownerType) &&
    ownerType !== ownerLevel &&
    (ownerLevel === null || ownerLevel === "organization") &&
    !isCompositeVisibilityForm(visibility)
  ) {
    ownerLevel = ownerType;
  }

  if (visibility === null || VISIBILITY_SET.has(visibility)) {
    return { ownerLevel, ownerId, visibility, projectId };
  }

  if (visibility === "org") {
    return {
      ownerLevel: "organization",
      ownerId: input.orgId ?? ownerId,
      visibility: "organization",
      projectId,
    };
  }
  if (visibility === "workspace") {
    return { ownerLevel: "workspace", ownerId, visibility: "public", projectId };
  }
  if (visibility.startsWith("team:") && visibility.length > "team:".length) {
    return {
      ownerLevel: "team",
      ownerId: visibility.slice("team:".length),
      visibility: "team",
      projectId,
    };
  }
  if (visibility.startsWith("user:") && visibility.length > "user:".length) {
    return {
      ownerLevel: "user",
      ownerId: visibility.slice("user:".length),
      visibility: "private",
      projectId,
    };
  }
  if (
    visibility.startsWith("project:") &&
    visibility.length > "project:".length
  ) {
    return {
      ownerLevel,
      ownerId,
      visibility: "private",
      projectId: projectId ?? visibility.slice("project:".length),
    };
  }

  // 'owner', 'admin', or junk → fail-closed private; owner axis untouched.
  return { ownerLevel, ownerId, visibility: "private", projectId };
}

/** One of the five retired composite visibility forms the fixed mapping claims. */
function isCompositeVisibilityForm(visibility: string | null): boolean {
  if (visibility === null) return false;
  if (visibility === "org" || visibility === "workspace") return true;
  return (
    (visibility.startsWith("team:") && visibility.length > "team:".length) ||
    (visibility.startsWith("user:") && visibility.length > "user:".length) ||
    (visibility.startsWith("project:") && visibility.length > "project:".length)
  );
}

/** True iff the value is a canonical visibility ('private'|'team'|'organization'|'public'). */
export function isCanonicalVisibility(
  value: unknown,
): value is CanonicalVisibility {
  return typeof value === "string" && VISIBILITY_SET.has(value);
}

/** True iff the value is a canonical owner level ('user'|'team'|'organization'|'workspace'). */
export function isCanonicalOwnerLevel(
  value: unknown,
): value is CanonicalOwnerLevel {
  return typeof value === "string" && OWNER_LEVEL_SET.has(value);
}
