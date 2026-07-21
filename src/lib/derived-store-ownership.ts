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
// Canonical ownership predicate — ONE source of truth, TWO projections
// (cinatra#1886 C2 / epic #1883 D11).
//
// The visibility rule that decides "does this ownership vantage admit this
// row" is expressed ONCE as an ordered list of CLAUSE descriptors
// (`OWNERSHIP_VISIBILITY_CLAUSES`). Each clause carries BOTH projections of
// the SAME rule:
//
//   - `sql(vantage, ph)`   → the parameterised SQL fragment the read filter
//                            (`buildOwnershipFilter`) OR-joins into a WHERE.
//   - `matches(vantage, row)` → the pure in-memory row predicate the
//                            row evaluator (`evaluateOwnershipVisibility`,
//                            and through it `scopeMaySeeRow`/`actorMaySeeRow`)
//                            OR-joins over.
//
// Neither projection can gain or lose a clause without the other: they iterate
// the identical array. A conformance test pins that the two stay in lockstep
// by running the SAME (vantage, row) corpus through BOTH the compiled SQL
// (against real Postgres) and the row predicate and asserting identical
// verdicts.
// ---------------------------------------------------------------------------

/**
 * The ownership AXES a canonical visibility decision reads — the shared
 * projection surface both `buildOwnershipFilter` and the row evaluator narrow
 * to. `buildOwnershipFilter` derives this from a full `ActorContext`
 * (`vantageFromActor`); `scopeMaySeeRow` derives it from an explicit
 * collection scope (`vantageFromScope`) — NEVER a synthesized fake actor: only
 * the axis the scope structurally represents is populated, and `isPlatformAdmin`
 * is never set from a scope (fail-closed — a scope is never a platform admin).
 */
export type OwnershipVantage = {
  /** User owner axis — the owning principal id (user-owned rows). */
  principalId?: string | null;
  /** Team owner axis — team ids whose team-owned rows are admitted. */
  teamIds: string[];
  /** Tenancy — admits organization- and (non-admin) public-visible rows. */
  organizationId?: string | null;
  /** Project axis — project ids whose project-refined rows are admitted. */
  projectIds: string[];
  /** Platform admin widens the public clause across orgs (read filter only). */
  isPlatformAdmin: boolean;
};

/**
 * A row projected onto the canonical ownership columns, the input the row
 * predicate evaluates. Mirrors the `objects` columns the SQL filter reads
 * (owner_level, owner_id, visibility, project_id, org_id).
 */
export type OwnershipEvalRow = {
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
  orgId: string | null;
};

/** Canonical clause ids — the fixed set both projections enumerate. */
export const OWNERSHIP_CLAUSE_IDS = [
  "user",
  "team",
  "organization",
  "public",
  "project",
] as const;
export type OwnershipClauseId = (typeof OWNERSHIP_CLAUSE_IDS)[number];

type OwnershipClause = {
  id: OwnershipClauseId;
  /** SQL projection — appends positional params via `ph`, returns the fragment. */
  sql: (vantage: OwnershipVantage, ph: (v: unknown) => string) => string;
  /** Row projection — the exact same rule as a pure predicate. */
  matches: (vantage: OwnershipVantage, row: OwnershipEvalRow) => boolean;
};

/**
 * SQL `=` semantics for a single scalar comparison: a NULL on EITHER side
 * never matches (Postgres `col = NULL` / `NULL = val` → NULL → false). The
 * row predicate uses this so it can never admit a row the SQL filter's
 * `= $param` would reject on a null operand.
 */
function sqlEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a != null && b != null && a === b;
}

/**
 * The canonical visibility clause list — see the block comment above. Order
 * is load-bearing for the SQL projection: it fixes the positional-parameter
 * sequence ($1 user, then team, org, public[member-only], project) that the
 * existing read-filter tests and callers depend on.
 */
const OWNERSHIP_VISIBILITY_CLAUSES: readonly OwnershipClause[] = [
  {
    // User owner axis — direct principal match on user-owned rows.
    id: "user",
    sql: (v, ph) =>
      `(owner_level = 'user' AND owner_id = ${ph(v.principalId ?? null)})`,
    matches: (v, r) => r.ownerLevel === "user" && sqlEq(r.ownerId, v.principalId),
  },
  {
    // Team owner axis — team-owned rows of any team the vantage belongs to.
    id: "team",
    sql: (v, ph) =>
      `(owner_level = 'team' AND owner_id = ANY(${ph(v.teamIds)}::text[]))`,
    matches: (v, r) =>
      r.ownerLevel === "team" && r.ownerId != null && v.teamIds.includes(r.ownerId),
  },
  {
    // Organization visibility — members see org-visible rows in their org.
    id: "organization",
    sql: (v, ph) =>
      `(visibility = 'organization' AND org_id = ${ph(v.organizationId ?? null)})`,
    matches: (v, r) =>
      r.visibility === "organization" && sqlEq(r.orgId, v.organizationId),
  },
  {
    // Public visibility — scoped to the owning org (multi-tenant fail-closed);
    // a platform_admin vantage reads public rows across orgs (read filter
    // only — `vantageFromScope` never sets isPlatformAdmin).
    id: "public",
    sql: (v, ph) =>
      v.isPlatformAdmin
        ? `visibility = 'public'`
        : `(visibility = 'public' AND org_id = ${ph(v.organizationId ?? null)})`,
    matches: (v, r) =>
      r.visibility === "public" &&
      (v.isPlatformAdmin || sqlEq(r.orgId, v.organizationId)),
  },
  {
    // Project axis — sealed-room membership admits project-tagged rows.
    id: "project",
    sql: (v, ph) =>
      `(project_id IS NOT NULL AND project_id = ANY(${ph(v.projectIds)}::text[]))`,
    matches: (v, r) => r.projectId != null && v.projectIds.includes(r.projectId),
  },
];

/**
 * Project a full `ActorContext` onto the shared ownership vantage — the read
 * filter's view. Every axis the SQL filter consults is carried through
 * verbatim (undefined team/project arrays collapse to empty, matching the
 * `?? []` the SQL builder used).
 */
export function vantageFromActor(actor: ActorContext): OwnershipVantage {
  return {
    principalId: actor.principalId,
    teamIds: actor.teamIds ?? [],
    organizationId: actor.organizationId,
    projectIds: actor.projectIds ?? [],
    isPlatformAdmin: actor.platformRole === "platform_admin",
  };
}

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
  const ph = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  // Emit the SQL projection of EVERY canonical clause, in list order. The
  // clause list (`OWNERSHIP_VISIBILITY_CLAUSES`) is the single source of truth
  // shared with the row evaluator (`evaluateOwnershipVisibility`); iterating it
  // here fixes the positional-parameter sequence ($1 user, team, org,
  // public[member-only], project) callers depend on. Load-bearing invariants
  // preserved from the hand-written form: the org/public clauses bind
  // `actor.organizationId ?? null` (a null-org non-admin sees zero rows —
  // `org_id = NULL` never matches; do NOT relax to `IS NOT DISTINCT FROM`),
  // and platform_admin widens `public` across orgs (its clause binds no param).
  const vantage = vantageFromActor(actor);
  const clauses = OWNERSHIP_VISIBILITY_CLAUSES.map((c) => c.sql(vantage, ph));

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

/**
 * Row-predicate MIRROR of `buildCeilingClause` — the same satisfy-ALL OBO
 * ceiling semantics as a pure boolean over an evaluated row. Element-for-element
 * identical to the SQL projection (organization → org_id; project → project_id;
 * user/team/workspace → owner_level+owner_id). Empty/absent chain ⇒ no
 * narrowing (true), mirroring the SQL builder returning null (clause omitted).
 */
function matchesCeiling(
  chain: ActorContext["oboCeiling"],
  row: OwnershipEvalRow,
): boolean {
  if (!chain || chain.length === 0) return true;
  for (const c of chain) {
    if (c.tier === "organization") {
      if (!sqlEq(row.orgId, c.id)) return false;
    } else if (c.tier === "project") {
      if (!sqlEq(row.projectId, c.id)) return false;
    } else {
      // user | team | workspace — owner-axis anchor.
      if (!(row.ownerLevel === c.tier && sqlEq(row.ownerId, c.id))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// evaluateOwnershipVisibility — the ROW projection of the canonical predicate
// ---------------------------------------------------------------------------

/**
 * Pure in-memory answer to "does this ownership vantage admit this row?" — the
 * row projection of the EXACT predicate `buildOwnershipFilter` compiles to SQL
 * (cinatra#1886 C2 / D11). A row is admitted iff it satisfies the OR-set of the
 * shared `OWNERSHIP_VISIBILITY_CLAUSES` AND (when the vantage carries one) every
 * element of the OBO ceiling chain — the same `(visibilitySql AND ceilingSql)`
 * composition `buildOwnershipFilter` emits.
 *
 * This is the single evaluator behind BOTH `actorMaySeeRow` (actor vantage +
 * the actor's ceiling) and `scopeMaySeeRow` (scope vantage, no ceiling). The
 * lockstep conformance test runs the same corpus through this and the compiled
 * SQL and asserts identical verdicts.
 */
export function evaluateOwnershipVisibility(
  vantage: OwnershipVantage,
  row: OwnershipEvalRow,
  ceiling?: ActorContext["oboCeiling"],
): boolean {
  const visible = OWNERSHIP_VISIBILITY_CLAUSES.some((c) => c.matches(vantage, row));
  if (!visible) return false;
  return matchesCeiling(ceiling, row);
}

/**
 * Does the ACTOR's own read vantage admit this row — the in-memory equivalent
 * of "would `buildOwnershipFilter(actor)` return this row". Carries the actor's
 * OBO ceiling so a delegated agent-run actor stays ceiling-bounded, exactly as
 * the SQL filter does. This is the `actor-may-see(row)` conjunct of the
 * collection-add contract (cinatra#1886).
 */
export function actorMaySeeRow(
  actor: ActorContext,
  row: OwnershipEvalRow,
): boolean {
  return evaluateOwnershipVisibility(
    vantageFromActor(actor),
    row,
    actor.oboCeiling,
  );
}

// ---------------------------------------------------------------------------
// scopeMaySeeRow — the SCOPE-vantage guard (cinatra#1886 C2 / D11)
// ---------------------------------------------------------------------------

/**
 * A collection SCOPE — the owning vantage of a scope's collection listing
 * (user/team/organization/workspace/project). `scopeMaySeeRow` answers "may a
 * GENERIC member positioned at exactly this scope already open this row" —
 * so a row can only be listed in a scope's collection when everyone in that
 * scope can see it (never silently widening; the promotion flow is the
 * recourse). The projection carries ONLY the axis the scope structurally
 * represents (see `vantageFromScope`), never a synthesized fake actor.
 */
export type CollectionScope =
  | { kind: "user"; userId: string; orgId?: string | null }
  | { kind: "team"; teamId: string; orgId: string }
  | { kind: "organization"; orgId: string }
  | { kind: "workspace"; orgId: string }
  | { kind: "project"; projectId: string; orgId: string };

/** The scope kinds — fixed roster, drives the per-kind test matrix. */
export const COLLECTION_SCOPE_KINDS = [
  "user",
  "team",
  "organization",
  "workspace",
  "project",
] as const;

/**
 * Project an explicit collection scope onto the shared ownership vantage —
 * NOT a synthesized actor (D11: "no synthesized fake actor"). Only the axis the
 * scope structurally represents is populated, plus the org tenancy floor so the
 * scope inherits org- and public-visible rows every member can open:
 *
 *   - user      → principalId = userId          (+ orgId when known)
 *   - team      → teamIds = [teamId]            (+ orgId, required)
 *   - project   → projectIds = [projectId]      (+ orgId, required)
 *   - organization / workspace → organizationId only (org-wide readers)
 *
 * `isPlatformAdmin` is NEVER set from a scope — a scope has no platform-admin
 * standing, so the public-across-orgs widening can never leak through this
 * path. Returns `null` for a structurally-invalid scope (missing required id)
 * so `scopeMaySeeRow` fails closed.
 */
export function vantageFromScope(scope: CollectionScope): OwnershipVantage | null {
  const base = {
    principalId: undefined as string | undefined,
    teamIds: [] as string[],
    organizationId: undefined as string | undefined,
    projectIds: [] as string[],
    isPlatformAdmin: false,
  };
  switch (scope.kind) {
    case "user":
      if (!scope.userId) return null;
      return { ...base, principalId: scope.userId, organizationId: scope.orgId ?? undefined };
    case "team":
      if (!scope.teamId || !scope.orgId) return null;
      return { ...base, teamIds: [scope.teamId], organizationId: scope.orgId };
    case "organization":
      if (!scope.orgId) return null;
      return { ...base, organizationId: scope.orgId };
    case "workspace":
      if (!scope.orgId) return null;
      return { ...base, organizationId: scope.orgId };
    case "project":
      if (!scope.projectId || !scope.orgId) return null;
      return { ...base, projectIds: [scope.projectId], organizationId: scope.orgId };
    default:
      // Exhaustiveness fail-closed: an unknown scope kind sees nothing.
      return null;
  }
}

/**
 * The SCOPE-VANTAGE GUARD (cinatra#1886 C2 / D11): may a generic member of
 * `scope` already see `row`? A pure row evaluator factored from the SAME
 * canonical predicate the SQL read filter compiles from — one source of truth
 * (`OWNERSHIP_VISIBILITY_CLAUSES`), two projections. Fail-closed: a malformed
 * scope, or a row that satisfies no clause at the scope's vantage, returns
 * false. Scopes carry no OBO ceiling.
 */
export function scopeMaySeeRow(
  scope: CollectionScope,
  row: OwnershipEvalRow,
): boolean {
  const vantage = vantageFromScope(scope);
  if (!vantage) return false;
  return evaluateOwnershipVisibility(vantage, row);
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
