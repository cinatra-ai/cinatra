/**
 * Cinatra QuerySpec — backend-agnostic query shape. The adapter translates
 * to drizzle-cube/server's native query format internally.
 *
 * v1 executable surface (cinatra#1911): measures, dimensions, order/limit/
 * offset, flat AND-list filters with `equals` | `in` | `inDateRange`, and a
 * single granularity-bearing time dimension. Grouped and/or filter trees and
 * every other operator stay outside this shape and are rejected upstream by
 * `checkUnsupportedQueryFeature`.
 */

/**
 * A single flat predicate on one cube member. v1 supports `equals` and `in`
 * on any dimension, and `inDateRange` on time-typed dimensions (values are
 * either one relative token like "last 30 days" or an absolute
 * [from, to] pair — drizzle-cube handles both natively). No grouped and/or.
 * The member is bare (`<member>`, no `<cube>.` prefix) inside `QuerySpec`;
 * the adapter re-prefixes it for drizzle-cube.
 */
export type QueryFilter = {
  readonly member: string;
  readonly operator: "equals" | "in" | "inDateRange";
  readonly values: readonly string[];
};

/**
 * A time-series axis (cinatra#1911). v1 requires `granularity` — drizzle-cube
 * applies an implicit DAILY grouping to a granularity-less time dimension
 * (its own authoring guidance calls that "usually wrong"), so v1 makes the
 * grouping explicit; a date window WITHOUT time-series grouping is expressed
 * as an `inDateRange` filter instead. `dateRange` is one relative token or an
 * absolute [from, to] pair. The dimension is bare inside `QuerySpec`.
 */
export type QueryTimeDimension = {
  readonly dimension: string;
  readonly granularity: "day" | "week" | "month";
  readonly dateRange?: string | readonly [string, string];
};

export type QuerySpec = {
  readonly measures?: readonly string[];
  readonly dimensions?: readonly string[];
  readonly timeDimensions?: readonly QueryTimeDimension[];
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: ReadonlyArray<readonly [member: string, direction: "asc" | "desc"]>;
  readonly filters?: readonly QueryFilter[];
};
