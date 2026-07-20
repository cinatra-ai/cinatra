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

// ---------------------------------------------------------------------------
// Child-run composition (epic W5 / #1884 C4): a child run dispatched by a parent
// run is bounded by BOTH its own anchored ceiling AND the parent's chain. The
// child's effective ceiling chain = child's own anchor ∪ parent's chain
// (satisfy-all → never wider than the parent). INCOMPARABLE axes (owner-axis vs
// project vs org — different single-valued RESOURCE facets) are carried
// un-collapsed; strict satisfy-all at enforcement handles them. A provably-
// disjoint SAME-axis pair (two distinct ids on one single-valued axis — an org
// floor mismatch, two projects) can never be satisfied by any resource, so it
// PRE-DENIES the dispatch (fail closed with a structured reason; no child run).
//
// OWNER-AXIS CONTAINMENT CONTRACT (#1884 C4).  `user | team | workspace` are NOT
// independent axes — they are TIERS of the ONE owner slot: a resource row carries
// exactly one `(owner_level, owner_id)` pair, evaluated by `resourceWithinCeiling`
// / `buildCeilingClause` as an EXACT tuple. So a composed chain carrying two
// DISTINCT owner tiers (e.g. a team-anchored parent's `team T` folded onto a
// user-anchored child's `user U`) can be satisfied by NO single-owner row — the
// mixed-axis gap this slice closes. The owner axis is a VISIBILITY LATTICE
// (private `user` ⊂ `team` ⊂ `workspace` public — the #1785/core__0033 canonical
// visibility order); the intersection of two owner ceilings on that lattice is
// the NARROWER one, PROVIDED the narrower is genuinely contained in the wider
// (the narrower user is a member of the wider team, etc.).
//
// That containment is a MEMBERSHIP fact the pure composer cannot resolve. Rather
// than silently assume it (which would let a mixed chain be "repaired" into a
// satisfiable one the parent never admitted — a widening), the composer takes the
// verified relation as an EXPLICIT input (`ownerContainments`) supplied by the
// dispatching seam, and collapses the owner axis to the single verified-narrowest
// tier. When the relation is absent or incomplete, the mixed composition FAILS
// CLOSED with a structured `unverified_owner_containment` denial (NOT a silent
// unsatisfiable chain). Today every dispatch seam passes NO containment facts, so
// mixed-owner-tier dispatches fail closed — safe; the anchor-derivation slice
// (#1884 C1) is what resolves live membership and supplies the facts (which is
// why this composition contract must land FIRST). C1 also owns the persisted-
// lineage / snapshot-vs-revocation policy — this pure primitive only collapses
// against the facts it is HANDED, and mint (`oboCeilingContains`) still re-checks
// the child's own freshly re-derived anchor against the persisted (collapsed)
// chain.
//
// This is the ONE shared compose-at-dispatch primitive; every dispatch site
// resolves the parent chain and calls this — never a per-site re-implementation.
// The child's OWN anchor must be freshly re-derived (`deriveOboCeilingChain`)
// and NEVER copied from the parent — copying a stale parent/source chain as the
// child's own anchor is the recurring-trigger clone-copy trap. Composition only
// ADDS the parent chain on top of the freshly-derived child anchor.
// ---------------------------------------------------------------------------

/** The narrowing owner tiers — the tiers of the SINGLE owner slot (a resource has
 *  exactly one owner_level+owner_id). `organization` is the tenancy FLOOR (checked
 *  on org_id) and `project` is an independent refinement — neither participates in
 *  owner-axis collapse. */
const OWNER_AXIS_TIERS: ReadonlySet<OboCeilingTier> = new Set([
  "user",
  "team",
  "workspace",
]);

/**
 * A VERIFIED owner-axis containment fact supplied by a dispatch seam: `Sat(
 * narrower) ⊆ Sat(wider)` has been proven server-side (e.g. the narrower `user`
 * is a current member of the wider `team`; the narrower user is the invoking
 * principal). The pure composer TRUSTS but never resolves it. Only facts whose
 * BOTH endpoints are present owner-axis elements of the composed chain are honored.
 */
export type OboOwnerContainment = { narrower: OboCeiling; wider: OboCeiling };

/** Reason a composition is provably empty / not admissibly satisfiable. */
export type OboCeilingComposeDenial =
  | { reason: "cross_org"; tier: "organization"; ids: [string, string] }
  | { reason: "disjoint_axis"; tier: OboCeilingTier; ids: [string, string] }
  | { reason: "unverified_owner_containment"; ceilings: [OboCeiling, OboCeiling] };

export type ComposeOboCeilingResult =
  | { ok: true; chain: OboCeilingChain }
  | ({ ok: false } & OboCeilingComposeDenial);

const ceilingKey = (c: OboCeiling): string => `${c.tier} ${c.id}`;

/**
 * Reduce the DISTINCT-tier owner-axis elements of a composed chain to the single
 * verified-narrowest tier, using the supplied containment facts (transitively
 * closed). Precondition: `ownerEls` are pairwise distinct on `(tier)` (same-tier
 * distinct ids are pre-denied as `disjoint_axis` before this runs) and length ≥ 2.
 *
 * Returns the kept (narrowest) element when a single global-minimum exists under
 * the verified `⊆` relation; otherwise a representative INCOMPARABLE pair (two
 * owner ceilings with no verified nesting in either direction) for the fail-closed
 * `unverified_owner_containment` denial.
 */
function reduceOwnerAxis(
  ownerEls: OboCeiling[],
  containments: OboOwnerContainment[],
):
  | { ok: true; kept: OboCeiling }
  | { ok: false; pair: [OboCeiling, OboCeiling] } {
  const nodes = new Set(ownerEls.map(ceilingKey));
  // subsetOf[a] = every node b with a VERIFIED `Sat(a) ⊆ Sat(b)` (reflexive seed).
  const subsetOf = new Map<string, Set<string>>();
  for (const el of ownerEls) subsetOf.set(ceilingKey(el), new Set([ceilingKey(el)]));
  for (const f of containments) {
    const nk = ceilingKey(f.narrower);
    const wk = ceilingKey(f.wider);
    // Only honor facts whose BOTH endpoints are present owner-axis elements.
    if (nodes.has(nk) && nodes.has(wk)) subsetOf.get(nk)!.add(wk);
  }
  // Transitive closure over the present nodes (Floyd–Warshall style).
  for (const k of nodes) {
    for (const i of nodes) {
      if (subsetOf.get(i)!.has(k)) {
        for (const j of subsetOf.get(k)!) subsetOf.get(i)!.add(j);
      }
    }
  }
  // A global-narrowest element is verified-subset of EVERY present owner node.
  for (const el of ownerEls) {
    const reach = subsetOf.get(ceilingKey(el))!;
    let coversAll = true;
    for (const n of nodes) {
      if (!reach.has(n)) {
        coversAll = false;
        break;
      }
    }
    if (coversAll) return { ok: true, kept: el };
  }
  // No global minimum → surface a concrete incomparable pair (neither ⊆ the other).
  for (let i = 0; i < ownerEls.length; i++) {
    for (let j = i + 1; j < ownerEls.length; j++) {
      const a = ownerEls[i];
      const b = ownerEls[j];
      const ab = subsetOf.get(ceilingKey(a))!.has(ceilingKey(b));
      const ba = subsetOf.get(ceilingKey(b))!.has(ceilingKey(a));
      if (!ab && !ba) return { ok: false, pair: [a, b] };
    }
  }
  // Nesting exists but no single global minimum (multiple incomparable minimals).
  return { ok: false, pair: [ownerEls[0], ownerEls[1]] };
}

/**
 * Compose a child's own derived ceiling chain with its parent run's chain.
 *
 * Rules:
 *  - Union + dedup on `(tier, id)`; the result is the child's own anchor plus
 *    every parent ceiling it does not already carry (satisfy-all → the composed
 *    chain is never wider than the parent, and transitively narrows across
 *    grandchildren because each level unions its parent's already-composed chain).
 *  - Every RESOURCE FACET is single-valued (a row has ONE owner tuple, ONE org,
 *    ONE project). So two DISTINCT ids on the SAME tier can never both be
 *    satisfied → provably disjoint → pre-deny (`cross_org` for the org floor,
 *    `disjoint_axis` for a project pair or a same-owner-tier pair).
 *  - OWNER-AXIS collapse: `user | team | workspace` are tiers of the ONE owner
 *    slot; a chain carrying two DISTINCT owner tiers is satisfiable by no single
 *    row. Under the visibility lattice their intersection is the verified-narrower
 *    tier — collapse to it using `ownerContainments`. With no verified nesting →
 *    fail closed `unverified_owner_containment` (never a silently-unsatisfiable
 *    persisted chain). Single or zero owner-tier elements pass through untouched
 *    (single-axis behavior is byte-stable).
 *  - INCOMPARABLE cross-axis pairs (owner vs project, owner vs org) are DIFFERENT
 *    resource facets → both carried, never collapsed, strict satisfy-all at
 *    enforcement.
 *
 * Both chain inputs must be non-empty, well-formed chains (each already carries
 * its org floor). `ownerContainments` defaults to none. Composition is
 * order-insensitive on membership.
 */
export function composeOboCeilingChain(
  parent: OboCeilingChain,
  child: OboCeilingChain,
  ownerContainments: OboOwnerContainment[] = [],
): ComposeOboCeilingResult {
  // Union + dedup (child first so its freshly-derived anchor leads the chain).
  const merged: OboCeiling[] = [...child];
  for (const p of parent) {
    if (!merged.some((m) => m.tier === p.tier && m.id === p.id)) merged.push(p);
  }

  // Any single-valued facet carrying two distinct ids is unsatisfiable. This also
  // catches a SAME owner-tier pair (two distinct users / teams / workspaces) —
  // genuinely disjoint regardless of membership, so it never reaches the collapse.
  const idsByTier = new Map<OboCeilingTier, string>();
  for (const c of merged) {
    const seen = idsByTier.get(c.tier);
    if (seen === undefined) {
      idsByTier.set(c.tier, c.id);
    } else if (seen !== c.id) {
      return c.tier === "organization"
        ? { ok: false, reason: "cross_org", tier: "organization", ids: [seen, c.id] }
        : { ok: false, reason: "disjoint_axis", tier: c.tier, ids: [seen, c.id] };
    }
  }

  // Owner-axis containment collapse: distinct owner tiers → single verified-narrowest.
  const ownerEls = merged.filter((c) => OWNER_AXIS_TIERS.has(c.tier));
  if (ownerEls.length > 1) {
    const reduced = reduceOwnerAxis(ownerEls, ownerContainments);
    if (!reduced.ok) {
      return {
        ok: false,
        reason: "unverified_owner_containment",
        ceilings: reduced.pair,
      };
    }
    const kept = reduced.kept;
    const collapsed = merged.filter(
      (c) => !OWNER_AXIS_TIERS.has(c.tier) || c === kept,
    );
    return { ok: true, chain: collapsed };
  }

  return { ok: true, chain: merged };
}

/**
 * Structured error thrown when a child-run dispatch composes a non-satisfiable
 * ceiling chain: a provably-disjoint same-axis id conflict / cross-org, OR a
 * mixed owner-tier composition with no verified containment relation. Dispatch
 * sites catch this and surface a structured failure (no child run created/
 * enqueued) — the same fail-closed pattern as the executor's `AGENT_CROSS_ORG`
 * outcome. `code` is stable for site-level branching without instanceof coupling
 * across bundles.
 */
export class OboCeilingCompositionError extends Error {
  readonly code = "AGENT_OBO_CEILING_DISJOINT" as const;
  readonly denial: OboCeilingComposeDenial;
  constructor(denial: OboCeilingComposeDenial) {
    super(composeDenialMessage(denial));
    this.name = "OboCeilingCompositionError";
    this.denial = denial;
  }
}

function composeDenialMessage(denial: OboCeilingComposeDenial): string {
  if (denial.reason === "unverified_owner_containment") {
    const [a, b] = denial.ceilings;
    return `child-run OBO ceiling composition mixes owner tiers with no verified containment (${a.tier}:${a.id} vs ${b.tier}:${b.id})`;
  }
  return `child-run OBO ceiling composition is provably disjoint (${denial.reason} on ${denial.tier}: ${denial.ids[0]} vs ${denial.ids[1]})`;
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
