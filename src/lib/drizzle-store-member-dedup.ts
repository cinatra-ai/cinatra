// Member-dedup ranking mirror — vertical slice extracted from
// drizzle-store.ts (file-size ratchet, cinatra#923). Pure helpers, no store
// internals. TEST-ONLY module: the production ranking lives in the SQL
// emitted by buildCreateStoreSchemaQueries (independently shape-guarded);
// this JS mirror exists so the strategy is unit-testable on synthetic rows
// (member-dedup-ranking.test.ts imports it directly — no runtime importer,
// keeping it out of the locked route graphs).

// JS mirror of the window-CTE ORDER BY in buildCreateStoreSchemaQueries'
// member dedup block. Source of truth is the SQL; this mirror exists so the
// ranking strategy can be unit-tested on synthetic rows (the SQL byte-shape
// is independently guarded by member-dedup-migration-shape.test.ts). Keep
// the two in lockstep when either changes.

export type MemberDedupRow = {
  id: string;
  role: string | null;
  createdAt: Date | string | null;
};

// owner > admin > member > unknown/NULL, taken as the MAX across comma-split
// role tokens. Better Auth stores multi-role membership as comma-joined text
// ('owner,admin') and splits member.role on commas in its permission checks,
// so 'owner,admin' is owner-capable and must rank as owner (3) — never 0,
// which would let a plain 'member' row survive the dedup and the owner-capable
// row be deleted. Unknown/custom tokens contribute 0. Mirrors the SQL
// role_rank = MAX(CASE trim(tok) ...) over unnest(string_to_array(role, ',')).
export function memberDedupRoleRank(role: string | null | undefined): number {
  if (!role) return 0;
  return role.split(",").reduce((max, raw) => {
    const tok = raw.trim();
    const rank = tok === "owner" ? 3 : tok === "admin" ? 2 : tok === "member" ? 1 : 0;
    return rank > max ? rank : max;
  }, 0);
}

// Mirrors `"createdAt" ASC NULLS LAST`: NULL/invalid createdAt sorts last.
function memberDedupCreatedAtKey(createdAt: Date | string | null): number {
  if (createdAt == null) return Number.POSITIVE_INFINITY;
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// Negative => a survives over b. Order: role rank DESC, createdAt ASC (NULLS
// LAST), id ASC — identical to the SQL window ORDER BY.
export function compareMemberDedup(a: MemberDedupRow, b: MemberDedupRow): number {
  const rankDelta = memberDedupRoleRank(b.role) - memberDedupRoleRank(a.role);
  if (rankDelta !== 0) return rankDelta;
  // Compare keys directly (not by subtraction) so two NULLS-LAST rows
  // (both Infinity) fall through to the id tie-break instead of producing
  // NaN from Infinity - Infinity.
  const ka = memberDedupCreatedAtKey(a.createdAt);
  const kb = memberDedupCreatedAtKey(b.createdAt);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Returns the row that survives dedup for a single (organizationId, userId)
// partition — i.e. the SQL window's rn = 1 row.
export function pickSurvivingMemberRow<T extends MemberDedupRow>(rows: T[]): T {
  if (rows.length === 0) {
    throw new Error("pickSurvivingMemberRow: empty partition");
  }
  return [...rows].sort(compareMemberDedup)[0];
}
