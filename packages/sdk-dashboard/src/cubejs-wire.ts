/**
 * Cube.js wire-format helpers.
 *
 * drizzle-cube/client's `CubeClient.load()` issues `GET ${apiUrl}/load?query=`
 * with a Cube.js-shaped query payload; `CubeClient.meta()` expects a Cube.js
 * `CubeMeta` shape; `CubeClient.batchLoad()` POSTs `{queries[]}` and expects
 * partial-success results. This module owns the conversion between Cube.js
 * wire types and Cinatra's anti-corruption DTOs (`QuerySpec`, `QueryResult`,
 * `CubeDescriptor`).
 *
 * The adapter deliberately does NOT support funnel/flow/retention/multi-query
 * shapes (rejected by the route with `400 unsupported_analysis_type`) or
 * timeDimensions (rejected with `400 unsupported_query_feature`). The ONLY
 * filter shape accepted in v1 is a same-cube `equals` predicate with non-empty
 * string values (used to scope a per-entity detail dashboard to one row);
 * every other filter shape (grouped and/or, other operators) is rejected with
 * `400 unsupported_query_feature`.
 */

import type {
  CubeDescriptor,
  QuerySpec,
  QueryResult,
  QueryResultRow,
} from "./types/index";

// ─── Cube.js wire types (minimal — only what we serve) ─────────────────

/**
 * Cube.js-flavored query body as it arrives off the wire (parsed JSON from
 * `?query=` for GET /load, or directly from body for POST). Members are
 * fully-qualified `<cubeName>.<member>`.
 */
export type CubeJsWireQuery = {
  readonly measures?: readonly string[];
  readonly dimensions?: readonly string[];
  readonly timeDimensions?: ReadonlyArray<{
    readonly dimension: string;
    readonly granularity?: string;
    readonly dateRange?: string | readonly string[];
  }>;
  readonly filters?: readonly unknown[];
  readonly segments?: readonly string[];
  readonly order?: Readonly<Record<string, "asc" | "desc">>;
  readonly limit?: number;
  readonly offset?: number;
  // unsupported-analysis-type top-level keys (reject if present)
  readonly funnel?: unknown;
  readonly flow?: unknown;
  readonly retention?: unknown;
  readonly queries?: unknown; // multi-query
};

/**
 * Cube.js-flavored CubeMeta response shape (`GET /meta`). drizzle-cube's
 * `types.d.ts` declares `CubeMetaCube.dimensions[].type` as a string;
 * time dimensions use the literal `"time"` (NOT `"date"`).
 *
 * `granularities` is `TimeGranularity[]` — array of string literals, not
 * objects.
 */
export type CubeMetaDimension = {
  readonly name: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly type: string;
  readonly granularities?: ReadonlyArray<
    "second" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year"
  >;
};

export type CubeMetaMeasure = {
  readonly name: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly type: string;
};

export type CubeMetaCube = {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly measures: readonly CubeMetaMeasure[];
  readonly dimensions: readonly CubeMetaDimension[];
  readonly segments: readonly CubeMetaMeasure[]; // shape parity; empty in v1
};

export type CubeMeta = {
  readonly cubes: readonly CubeMetaCube[];
};

/**
 * Cube.js `/load` response — `{ data, query, annotation }`. Used for both
 * GET (drizzle-cube/client) and POST (Cinatra `useCubeQuery`) for response
 * shape parity.
 */
export type CubeJsLoadResponse = {
  readonly data: readonly QueryResultRow[];
  readonly query: CubeJsWireQuery;
  readonly annotation: Readonly<Record<string, unknown>>;
};

/**
 * Cube.js `/batch` response — partial-success per drizzle-cube's adapter
 * model. HTTP 200 even if some queries failed; only
 * envelope-level errors (malformed body, batch > BATCH_MAX_QUERIES, auth)
 * produce non-2xx.
 */
export type CubeJsBatchResultItem =
  | { readonly success: true; readonly data: readonly QueryResultRow[]; readonly query: CubeJsWireQuery; readonly annotation: Readonly<Record<string, unknown>> }
  | { readonly success: false; readonly error: string; readonly query: CubeJsWireQuery };

export type CubeJsBatchResponse = {
  readonly results: readonly CubeJsBatchResultItem[];
};

// ─── Equals-filter support (v1 — same-cube equality only) ──────────────

/**
 * The only filter shape v1 accepts: a single-member equality predicate with
 * non-empty string values. drizzle-cube's filter DSL also supports other
 * operators and grouped `and`/`or` wrappers, but the per-entity detail
 * dashboards only need same-cube `equals`, so we keep the accepted surface
 * minimal — everything else is rejected with `unsupported_query_feature`.
 */
export type CubeJsEqualsFilter = {
  readonly member: string;
  readonly operator: "equals";
  readonly values: readonly string[];
};

export function isEqualsFilter(f: unknown): f is CubeJsEqualsFilter {
  if (typeof f !== "object" || f === null) return false;
  const o = f as Record<string, unknown>;
  return (
    typeof o.member === "string" &&
    o.member.length > 0 &&
    o.operator === "equals" &&
    Array.isArray(o.values) &&
    o.values.length > 0 &&
    o.values.every((v) => typeof v === "string")
  );
}

/**
 * First equals-filter member (if any) — an additional cube-id source so a
 * filters-only query still resolves a cube. Returns undefined when no
 * equals-filter is present.
 */
function firstEqualsFilterMember(
  filters: readonly unknown[] | undefined,
): string | undefined {
  for (const f of filters ?? []) {
    if (isEqualsFilter(f)) return f.member;
  }
  return undefined;
}

/**
 * Filter members whose `<cube>.<suffix>` does NOT name a known dimension or
 * measure of the cube. drizzle-cube silently DROPS an unknown filter member —
 * which would widen a single-entity detail query back to the full visible set
 * — so the route must reject these to stay fail-closed. Pass the cube's known
 * member ids (`dimensions ∪ measures`). Returns the offending fully-qualified
 * members (empty when all filter members are valid).
 */
export function findUnknownFilterMembers(
  q: CubeJsWireQuery,
  cubeId: string,
  knownMemberIds: ReadonlySet<string>,
): string[] {
  const prefix = `${cubeId}.`;
  const unknown: string[] = [];
  for (const f of q.filters ?? []) {
    if (!isEqualsFilter(f)) continue;
    if (!f.member.startsWith(prefix)) {
      unknown.push(f.member);
      continue;
    }
    const suffix = f.member.slice(prefix.length);
    if (!knownMemberIds.has(suffix)) unknown.push(f.member);
  }
  return unknown;
}

// ─── Resolver: cube id from query members ──────────────────────────────

/**
 * Inspect the query's member fields and find the first fully-qualified
 * `<cube>.<member>` reference. Returns the prefix or null if none found.
 *
 * Must walk all sources, not just `measures[0]`, because AnalysisBuilder may
 * emit dimensions-only or timeDimensions-only queries. This is sufficient when
 * `unsupported_analysis_type` rejection precedes this for
 * funnel/flow/retention/multi-query shapes.
 */
export function resolveCubeIdFromQuery(q: CubeJsWireQuery): string | null {
  const firstMember =
    q.measures?.[0] ??
    q.dimensions?.[0] ??
    q.timeDimensions?.[0]?.dimension ??
    (q.order ? Object.keys(q.order)[0] : undefined) ??
    q.segments?.[0] ??
    firstEqualsFilterMember(q.filters);
  if (!firstMember) return null;
  const dot = firstMember.indexOf(".");
  return dot > 0 ? firstMember.slice(0, dot) : null;
}

/**
 * Assert all member references in `q` share the same `<cube>.` prefix.
 * Returns the prefix on success, or an error code on ambiguity / missing.
 */
export function resolveAndValidateCubeId(
  q: CubeJsWireQuery,
):
  | { ok: true; cubeId: string }
  | { ok: false; code: "cube_id_required" | "cube_id_ambiguous"; details: Readonly<Record<string, unknown>> } {
  const cubeId = resolveCubeIdFromQuery(q);
  if (!cubeId) {
    return { ok: false, code: "cube_id_required", details: { reason: "no fully-qualified members in query" } };
  }
  const allMembers: string[] = [
    ...(q.measures ?? []),
    ...(q.dimensions ?? []),
    ...((q.timeDimensions ?? []).map((td) => td.dimension)),
    ...Object.keys(q.order ?? {}),
    ...(q.segments ?? []),
    // Filter members participate in the same-cube check so an `equals`
    // filter on a foreign cube triggers `cube_id_ambiguous` (no widening).
    ...((q.filters ?? []).filter(isEqualsFilter).map((f) => f.member)),
  ];
  const prefix = `${cubeId}.`;
  const foreign = allMembers.filter((m) => !m.startsWith(prefix));
  if (foreign.length > 0) {
    return {
      ok: false,
      code: "cube_id_ambiguous",
      details: { resolved: cubeId, foreignMembers: foreign },
    };
  }
  return { ok: true, cubeId };
}

// ─── Analysis-type guard ───────────────────────────────────────────────

/**
 * The route rejects `funnel`/`flow`/`retention`/`queries` (multi-query).
 */
export function checkUnsupportedAnalysisType(
  q: CubeJsWireQuery,
): { code: string; reason: string } | null {
  if (q.funnel !== undefined) return { code: "unsupported_analysis_type", reason: "funnel analysis not supported in v1" };
  if (q.flow !== undefined) return { code: "unsupported_analysis_type", reason: "flow analysis not supported in v1" };
  if (q.retention !== undefined) return { code: "unsupported_analysis_type", reason: "retention analysis not supported in v1" };
  if (q.queries !== undefined) return { code: "unsupported_analysis_type", reason: "multi-query (top-level queries[]) not supported in v1; use POST /batch instead" };
  return null;
}

/**
 * The route accepts ONLY same-cube `equals` filters; it rejects every other
 * filter shape and all `timeDimensions`.
 *
 * Rejecting only `timeDimensions[].granularity` lets valid Cube.js fields like
 * `dateRange`, `fillMissingDates`, or a bare time dimension pass and then get
 * silently dropped by `toQuerySpec` (which only maps measures/dimensions/order/
 * limit/offset/filters). That would return successful but incorrect results.
 *
 * Reject any non-empty `timeDimensions` entirely until both `QuerySpec` and
 * the adapter support time-grain queries.
 */
export function checkUnsupportedQueryFeature(
  q: CubeJsWireQuery,
): { code: string; reason: string } | null {
  if (Array.isArray(q.filters) && q.filters.length > 0) {
    if (!q.filters.every(isEqualsFilter)) {
      return {
        code: "unsupported_query_feature",
        reason:
          "only same-cube `equals` filters with non-empty string values are supported in v1 (no grouped and/or, no other operators)",
      };
    }
  }
  if (Array.isArray(q.timeDimensions) && q.timeDimensions.length > 0) {
    return {
      code: "unsupported_query_feature",
      reason: "timeDimensions not supported by this adapter",
    };
  }
  return null;
}

// ─── Wire → Cinatra conversion ─────────────────────────────────────────

/**
 * Strip `<cube>.` from a member name. Throws if the prefix doesn't match.
 */
export function stripCubePrefix(member: string, cubeId: string): string {
  const prefix = `${cubeId}.`;
  if (!member.startsWith(prefix)) {
    throw new Error(`stripCubePrefix: member "${member}" does not start with "${prefix}"`);
  }
  return member.slice(prefix.length);
}

/**
 * Convert a Cube.js-wire query (fully-qualified members + object order)
 * into a Cinatra `QuerySpec` (bare members + tuple-array order).
 *
 * Callers must run `resolveAndValidateCubeId` first to get the prefix.
 */
export function toQuerySpec(q: CubeJsWireQuery, cubeId: string): QuerySpec {
  const measures = q.measures?.map((m) => stripCubePrefix(m, cubeId));
  const dimensions = q.dimensions?.map((d) => stripCubePrefix(d, cubeId));
  const order: Array<readonly [string, "asc" | "desc"]> = [];
  if (q.order) {
    for (const [member, direction] of Object.entries(q.order)) {
      order.push([stripCubePrefix(member, cubeId), direction]);
    }
  }
  // Map same-cube `equals` filters (validated upstream by
  // `checkUnsupportedQueryFeature`); strip the `<cube>.` prefix off each member.
  const filters = (q.filters ?? [])
    .filter(isEqualsFilter)
    .map((f) => ({
      member: stripCubePrefix(f.member, cubeId),
      operator: "equals" as const,
      values: [...f.values],
    }));
  const out: QuerySpec = {
    ...(measures && measures.length > 0 ? { measures } : {}),
    ...(dimensions && dimensions.length > 0 ? { dimensions } : {}),
    ...(order.length > 0 ? { order } : {}),
    ...(typeof q.limit === "number" ? { limit: q.limit } : {}),
    ...(typeof q.offset === "number" ? { offset: q.offset } : {}),
    ...(filters.length > 0 ? { filters } : {}),
  };
  return out;
}

// ─── Cinatra → Cube.js conversion ──────────────────────────────────────

/**
 * Wrap a Cinatra `QueryResult` into the Cube.js `/load` response shape.
 * `data` keys are already `<cube>.<member>` because the drizzle-cube
 * adapter returns rows that way.
 */
export function toCubeJsLoadResponse(
  result: QueryResult,
  originalWireQuery: CubeJsWireQuery,
): CubeJsLoadResponse {
  return {
    data: result.rows,
    query: originalWireQuery,
    annotation: {}, // Cube.js extension point; currently empty.
  };
}

/**
 * Convert a `CubeDescriptor` to a Cube.js `CubeMetaCube`. Member names
 * are fully-qualified (`<cube>.<member>`); Cinatra dimension type
 * `"date"` maps to drizzle-cube `"time"` so AnalysisBuilder surfaces
 * granularity controls.
 */
export function toCubeMetaCube(d: CubeDescriptor): CubeMetaCube {
  const dimensions: CubeMetaDimension[] = d.dimensions.map((dim) => {
    const dcType = dim.type === "date" ? "time" : dim.type;
    const base: CubeMetaDimension = {
      name: `${d.id}.${dim.id}`,
      title: dim.displayName,
      shortTitle: dim.displayName,
      type: dcType,
    };
    if (dcType === "time") {
      return { ...base, granularities: ["day", "week", "month"] };
    }
    return base;
  });
  const measures: CubeMetaMeasure[] = d.measures.map((m) => ({
    name: `${d.id}.${m.id}`,
    title: m.displayName,
    shortTitle: m.displayName,
    type: m.type,
  }));
  return {
    name: d.id,
    title: d.displayName,
    description: d.description,
    measures,
    dimensions,
    segments: [],
  };
}

export function toCubeMeta(descriptors: readonly CubeDescriptor[]): CubeMeta {
  return { cubes: descriptors.map(toCubeMetaCube) };
}
