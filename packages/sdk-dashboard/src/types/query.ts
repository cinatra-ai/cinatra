/**
 * Cinatra QuerySpec — backend-agnostic query shape. The adapter translates
 * to drizzle-cube/server's native query format internally.
 *
 * timeDimensions and date grains are outside this minimal query shape and
 * belong in adapter-specific extensions. `filters` carries only the minimal
 * same-cube `equals` shape (v1) used to scope a query to one entity.
 */

/**
 * A single equality predicate on one cube member. v1 supports only same-cube
 * `equals` filters (no grouped and/or, no other operators) — the minimal
 * shape the per-entity detail dashboards need to scope a query to one row.
 * The member is bare (`<member>`, no `<cube>.` prefix) inside `QuerySpec`;
 * the adapter re-prefixes it for drizzle-cube.
 */
export type QueryFilter = {
  readonly member: string;
  readonly operator: "equals";
  readonly values: readonly string[];
};

export type QuerySpec = {
  readonly measures?: readonly string[];
  readonly dimensions?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: ReadonlyArray<readonly [member: string, direction: "asc" | "desc"]>;
  readonly filters?: readonly QueryFilter[];
};
