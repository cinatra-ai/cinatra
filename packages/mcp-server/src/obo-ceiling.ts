// ---------------------------------------------------------------------------
// Agent on-behalf-of (OBO) scope-ceiling chain — carrier types + pure helpers.
//
// An agent run executes on-behalf-of its invoking user but must stay confined
// to the agent's own ANCHORED scope (the install target). The effective reach
// is `invoker live authority ∩ agent anchored scope`; this module owns the
// "anchored scope" operand as a CEILING CHAIN.
//
// A ceiling is a single `{ tier, id }` bound on ONE axis. The owner axis
// (user/team/organization/workspace) and the project axis are INDEPENDENT —
// "team T ∩ project P" has no single narrower value, so the run carries a small
// SET (chain) and a resource must satisfy EVERY applicable ceiling (satisfy-all).
//
// This module is PURE (no I/O, no react/better-auth/tier-restricting imports)
// so it can be the single shared source across the leaf packages, the agents
// store, and the app authz kernel. It lives in `@cinatra-ai/mcp-server` — the
// only cinatra-workspace leaf — and is reached via the dedicated subpath export
// `@cinatra-ai/mcp-server/obo-ceiling` (never through the heavy package facade),
// so a pure-types consumer never pulls the transport runtime.
//
// This wave CARRIES + DERIVES the chain and lands the helper; NO surface
// enforces it yet (that is a later wave). `resourceWithinCeiling` is landed and
// unit-tested here for those future consumers.
// ---------------------------------------------------------------------------

/** The five ceiling axes. Owner axis = user/team/organization/workspace; the
 *  project axis is a refinement, carried independently (never collapsed). */
export type OboCeilingTier =
  | "user"
  | "team"
  | "organization"
  | "workspace"
  | "project";

/** A single bound on one axis. */
export type OboCeiling = { tier: OboCeilingTier; id: string };

/** The carried set of ceilings. A resource must satisfy ALL applicable members. */
export type OboCeilingChain = OboCeiling[];

const OBO_CEILING_TIERS: ReadonlySet<string> = new Set([
  "user",
  "team",
  "organization",
  "workspace",
  "project",
]);

/** Type guard for a single ceiling element (tier in the 5-set, non-empty id). */
export function isOboCeiling(value: unknown): value is OboCeiling {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { tier?: unknown; id?: unknown };
  return (
    typeof v.tier === "string" &&
    OBO_CEILING_TIERS.has(v.tier) &&
    typeof v.id === "string" &&
    v.id.length > 0
  );
}

/** Type guard for a well-formed, NON-EMPTY chain. An empty array is rejected:
 *  every legitimately-derived chain carries at least the org floor, so `[]`
 *  signals corruption and must fail closed at the callers. */
export function isOboCeilingChain(value: unknown): value is OboCeilingChain {
  return Array.isArray(value) && value.length > 0 && value.every(isOboCeiling);
}

/** Parse a persisted JSON-as-text chain defensively. Returns null on any
 *  malformed / empty / non-conforming value (callers fail closed). */
export function parseOboCeilingChain(
  raw: string | null | undefined,
): OboCeilingChain | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isOboCeilingChain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Derive the ceiling chain from a run's LOCKED template anchor + its org +
 * (optionally) an explicit project launch. The SINGLE source of truth used
 * both at run-creation (persist-at-dispatch) and at mint (re-derive-and-compare).
 *
 * Rules:
 *  - A concrete owner-axis anchor (user/team/workspace) yields `{ tier, id }`.
 *  - A locked `owner_level='project'` install yields a `{ project, ownerId }`
 *    element (project-axis, per the epic's project-target install carve).
 *  - A known non-org owner tier with a MISSING id is a CORRUPT anchor → return
 *    null (fail closed). We NEVER widen a partial anchor up to the org floor,
 *    which would grant org-wide reach to an agent meant to be user/team-scoped.
 *  - `owner_level='organization'` → `{ organization, ownerId ?? orgId }`.
 *  - A null / unrecognized owner tier is the documented pre-backfill state → no
 *    owner element; the mandatory org floor below covers it (matching the
 *    `normalizeOwnerLevel` read convention). This is NOT the fail-closed case.
 *  - EVERY non-null chain carries a mandatory `{ organization, orgId }` floor
 *    (dedup) so a cross-org resource always fails satisfy-all.
 *  - An explicit project launch (`run.projectId`) appends an independent
 *    `{ project, projectId }` element (dedup).
 *
 * Returns null ONLY for a corrupt partial anchor; the caller persists SQL NULL
 * / declines to mint, so the run fails closed rather than escalating.
 */
export function deriveOboCeilingChain(input: {
  ownerLevel: string | null | undefined;
  ownerId: string | null | undefined;
  orgId: string;
  projectId: string | null | undefined;
}): OboCeilingChain | null {
  const chain: OboCeiling[] = [];
  const lvl = input.ownerLevel;
  const oid = input.ownerId && input.ownerId.length > 0 ? input.ownerId : null;

  if (lvl === "user" || lvl === "team" || lvl === "workspace") {
    if (!oid) return null; // corrupt partial anchor — fail closed, never widen
    chain.push({ tier: lvl, id: oid });
  } else if (lvl === "project") {
    if (!oid) return null; // corrupt project anchor — fail closed
    chain.push({ tier: "project", id: oid });
  } else if (lvl === "organization") {
    chain.push({ tier: "organization", id: oid ?? input.orgId });
  }
  // else: null / unrecognized tier → org floor (below) is the only owner bound.

  // Mandatory org floor on every chain: guarantees cross-org denial at every tier.
  if (!chain.some((c) => c.tier === "organization")) {
    chain.push({ tier: "organization", id: input.orgId });
  }

  // Independent project-axis element from an explicit project launch (dedup).
  if (
    input.projectId &&
    !chain.some((c) => c.tier === "project" && c.id === input.projectId)
  ) {
    chain.push({ tier: "project", id: input.projectId });
  }

  return chain;
}

/**
 * Mint-time containment check. The PERSISTED dispatch chain is valid iff it
 * CONTAINS every freshly re-derived element (superset OK — a composed child
 * chain legitimately carries parent elements the mint path cannot re-derive).
 * A missing / empty persisted chain is never contained → fail closed.
 */
export function oboCeilingContains(
  persisted: OboCeilingChain | null | undefined,
  recomputed: OboCeilingChain,
): boolean {
  if (!persisted || persisted.length === 0) return false;
  return recomputed.every((r) =>
    persisted.some((p) => p.tier === r.tier && p.id === r.id),
  );
}

/** A resolved resource's ownership facets, compared against a ceiling chain. */
export type CeilingResource = {
  orgId?: string | null;
  /** The resource's owner-axis anchor (4-tier), when it has one. */
  owner?: { tier: "user" | "team" | "organization" | "workspace"; id: string } | null;
  /** The resource's project refinement, when it has one. */
  projectId?: string | null;
};

/**
 * Does a resource fall WITHIN the ceiling chain? Strict satisfy-ALL: the
 * resource must satisfy EVERY member. Incomparable axes (team vs project) are
 * carried, not collapsed, so both must hold. A null / empty chain returns FALSE
 * (never a vacuous allow). No surface calls this yet — it is landed for the
 * enforcement wave.
 */
export function resourceWithinCeiling(
  resource: CeilingResource,
  chain: OboCeilingChain | null | undefined,
): boolean {
  if (!chain || chain.length === 0) return false;
  return chain.every((c) => satisfiesCeiling(resource, c));
}

function satisfiesCeiling(r: CeilingResource, c: OboCeiling): boolean {
  if (c.tier === "project") return r.projectId != null && r.projectId === c.id;
  if (c.tier === "organization") return r.orgId != null && r.orgId === c.id;
  // user / team / workspace: the resource must be owned at that exact tier + id.
  return r.owner != null && r.owner.tier === c.tier && r.owner.id === c.id;
}
