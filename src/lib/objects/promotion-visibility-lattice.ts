/**
 * Promotion visibility LATTICE — the never-narrow ordering, pure (cinatra#1437).
 *
 * A single, dependency-free source of truth for "is this a real widen". Both
 * the #1437 row-promotion service (`artifact-row-promotion.ts`, which re-exports
 * these) and the collection-add authorization contract
 * (`collection-add-authorization.ts`, whose promotion-offer recourse must only
 * name a target #1437 will accept) evaluate the SAME lattice — so an offer the
 * contract emits can never be a target the promotion flow would reject as
 * `narrowing`. Kept pure (no `server-only`, no DB) so the pure contract can
 * import it without dragging the data layer in.
 */

/** Visibility widening lattice — a promotion may only move UP this rank. */
export const PROMOTION_SCOPE_RANK: Readonly<Record<string, number>> = {
  private: 0,
  team: 1,
  organization: 2,
  public: 3,
};

export function promotionScopeRank(scope: string): number {
  return PROMOTION_SCOPE_RANK[scope] ?? -1;
}

/**
 * True iff `to` is STRICTLY wider than `from` (a real widen — never-narrow,
 * never a no-op). An unknown scope ranks -1 and never widens.
 */
export function isWiden(from: string, to: string): boolean {
  const f = promotionScopeRank(from);
  const t = promotionScopeRank(to);
  return f >= 0 && t >= 0 && t > f;
}
