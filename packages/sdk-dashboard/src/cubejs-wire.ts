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
 * shapes (rejected by the route with `400 unsupported_analysis_type`).
 *
 * v1 filter surface (cinatra#1911): a flat AND-list of same-cube predicates
 * with operator `equals` | `in` (non-empty string values) or `inDateRange`
 * (one relative token like "last 30 days", or an absolute [from, to] pair,
 * on a time-typed dimension). `timeDimensions` carries at most ONE entry and
 * it MUST name a granularity (day|week|month) — drizzle-cube applies an
 * implicit daily grouping to a granularity-less time dimension, which its own
 * authoring guidance calls "usually wrong", so v1 requires the grouping to be
 * explicit; a date window without time-series grouping is an `inDateRange`
 * filter instead. Everything else (grouped and/or, other operators) is
 * rejected with `400 unsupported_query_feature`.
 *
 * `collectQueryFeatureViolations` is the SINGLE feature predicate shared by
 * this wire gate and the dashboards write path (cinatra#1911): what cannot
 * execute cannot be persisted, and both seats emit the same product copy.
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

// ─── Supported-filter surface (v1 — flat same-cube predicates) ─────────

export const SUPPORTED_FILTER_OPERATORS = ["equals", "in", "inDateRange"] as const;
export type SupportedFilterOperator = (typeof SUPPORTED_FILTER_OPERATORS)[number];

export const SUPPORTED_TIME_GRANULARITIES = ["day", "week", "month"] as const;
export type SupportedTimeGranularity = (typeof SUPPORTED_TIME_GRANULARITIES)[number];

/**
 * The flat filter shape v1 accepts: a single-member predicate with non-empty
 * string values and a supported operator. drizzle-cube's filter DSL also
 * supports many more operators and grouped `and`/`or` wrappers; those stay
 * rejected with `unsupported_query_feature` until a use case earns them.
 */
export type CubeJsSupportedFilter = {
  readonly member: string;
  readonly operator: SupportedFilterOperator;
  readonly values: readonly string[];
};

/** @deprecated cinatra#1911 — kept as an alias for the equals-only era. */
export type CubeJsEqualsFilter = CubeJsSupportedFilter & { readonly operator: "equals" };

export function isSupportedFilter(f: unknown): f is CubeJsSupportedFilter {
  if (typeof f !== "object" || f === null) return false;
  const o = f as Record<string, unknown>;
  if (
    typeof o.member !== "string" ||
    o.member.length === 0 ||
    typeof o.operator !== "string" ||
    !(SUPPORTED_FILTER_OPERATORS as readonly string[]).includes(o.operator) ||
    !Array.isArray(o.values) ||
    o.values.length === 0 ||
    !o.values.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return false;
  }
  // A date window is either one relative token ("last 30 days") or an
  // absolute [from, to] pair — drizzle-cube accepts exactly these two arities
  // (a bare string dateRange is wrapped to a 1-element array internally).
  if (o.operator === "inDateRange" && o.values.length > 2) return false;
  return true;
}

export function isEqualsFilter(f: unknown): f is CubeJsEqualsFilter {
  return isSupportedFilter(f) && f.operator === "equals";
}

/**
 * First supported-filter member (if any) — an additional cube-id source so a
 * filters-only query still resolves a cube. Returns undefined when no
 * supported filter is present.
 */
function firstSupportedFilterMember(
  filters: readonly unknown[] | undefined,
): string | undefined {
  for (const f of filters ?? []) {
    if (isSupportedFilter(f)) return f.member;
  }
  return undefined;
}

// ─── Feature predicate (shared: wire gate + dashboards write path) ─────

export type QueryFeatureViolation = {
  /** Stable machine identity of the violation class (cinatra#1911). */
  readonly kind:
    | "grouped_boolean_filters"
    | "unsupported_filter_operator"
    | "invalid_filter_shape"
    | "invalid_date_window"
    | "multiple_time_dimensions"
    | "invalid_time_dimension"
    | "missing_or_invalid_granularity"
    | "invalid_date_range";
  /** Offending fully-qualified member, when one is identifiable. */
  readonly member?: string;
  /** Product copy — safe to render on a card and in a write-rejection. */
  readonly message: string;
};

const SUPPORTED_SURFACE_COPY =
  `Supported filters: "equals" and "in" with exact text values, and ` +
  `"inDateRange" with one relative period (like "last 30 days") or a ` +
  `[from, to] pair of dates.`;

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);
}

/**
 * The v1 executable-feature predicate (cinatra#1911). Tolerant of unknown or
 * partial shapes — persisted portlet queries are opaque to Zod, so this is
 * safe to run on untrusted `analysisConfig.query` blobs at save time (same
 * philosophy as `collectQueryCubeIds`). Non-object input yields no
 * violations; presence/absence rules stay with the callers' schemas.
 *
 * Checks only what is decidable WITHOUT cube metadata. Member existence and
 * time-typedness stay render-time (`findInvalidMetaMembers`) — write-time
 * callers must not claim member resolution happened.
 */
export function collectQueryFeatureViolations(query: unknown): QueryFeatureViolation[] {
  const out: QueryFeatureViolation[] = [];
  if (typeof query !== "object" || query === null) return out;
  const q = query as Record<string, unknown>;

  // A present-but-non-array container would evade the per-entry checks below
  // and then throw inside `toQuerySpec` (500 instead of a readable 400) —
  // fail closed here on both seats (codex merge-round finding).
  if (q.filters !== undefined && !Array.isArray(q.filters)) {
    out.push({
      kind: "invalid_filter_shape",
      message: "`filters` must be an array of { member, operator, values } objects.",
    });
  }
  if (q.timeDimensions !== undefined && !Array.isArray(q.timeDimensions)) {
    out.push({
      kind: "invalid_time_dimension",
      message: "`timeDimensions` must be an array with one { dimension, granularity, dateRange? } entry.",
    });
  }

  if (Array.isArray(q.filters)) {
    for (const f of q.filters) {
      if (typeof f !== "object" || f === null) {
        out.push({
          kind: "invalid_filter_shape",
          message: `A filter entry is not a { member, operator, values } object. ${SUPPORTED_SURFACE_COPY}`,
        });
        continue;
      }
      const o = f as Record<string, unknown>;
      if ("and" in o || "or" in o) {
        out.push({
          kind: "grouped_boolean_filters",
          message:
            "Grouped and/or filters aren't supported. Use a flat list of filters — they combine with AND.",
        });
        continue;
      }
      const member = typeof o.member === "string" && o.member.length > 0 ? o.member : undefined;
      const label = member ? `Filter on "${member}"` : "A filter";
      if (typeof o.operator !== "string" || !(SUPPORTED_FILTER_OPERATORS as readonly string[]).includes(o.operator)) {
        out.push({
          kind: "unsupported_filter_operator",
          member,
          message: `${label} uses the unsupported operator "${String(o.operator)}". ${SUPPORTED_SURFACE_COPY}`,
        });
        continue;
      }
      if (!isNonEmptyStringArray(o.values)) {
        out.push({
          kind: "invalid_filter_shape",
          member,
          message: `${label} needs a non-empty list of non-empty text values.`,
        });
        continue;
      }
      if (o.operator === "inDateRange" && (o.values as string[]).length > 2) {
        out.push({
          kind: "invalid_date_window",
          member,
          message: `${label} has ${(o.values as string[]).length} values — a date window is one relative period (like "last 30 days") or a [from, to] pair of dates.`,
        });
        continue;
      }
      if (!member) {
        out.push({
          kind: "invalid_filter_shape",
          message: `A filter is missing its member (the "<cube>.<field>" it applies to).`,
        });
      }
    }
  }

  if (Array.isArray(q.timeDimensions) && q.timeDimensions.length > 0) {
    if (q.timeDimensions.length > 1) {
      out.push({
        kind: "multiple_time_dimensions",
        message: "Only one time dimension per query is supported.",
      });
    }
    for (const td of q.timeDimensions) {
      if (typeof td !== "object" || td === null) {
        out.push({
          kind: "invalid_time_dimension",
          message: "A timeDimensions entry is not a { dimension, granularity, dateRange? } object.",
        });
        continue;
      }
      const t = td as Record<string, unknown>;
      const member = typeof t.dimension === "string" && t.dimension.length > 0 ? t.dimension : undefined;
      if (!member) {
        out.push({
          kind: "invalid_time_dimension",
          message: "A timeDimensions entry is missing its dimension.",
        });
        continue;
      }
      if (
        typeof t.granularity !== "string" ||
        !(SUPPORTED_TIME_GRANULARITIES as readonly string[]).includes(t.granularity)
      ) {
        out.push({
          kind: "missing_or_invalid_granularity",
          member,
          message:
            `Time dimension "${member}" needs a granularity of "day", "week" or "month" for a time series. ` +
            `For a plain date window without time grouping, use an "inDateRange" filter instead.`,
        });
      }
      const dr = t.dateRange;
      if (dr !== undefined) {
        const okString = typeof dr === "string" && dr.length > 0;
        const okPair =
          Array.isArray(dr) &&
          (dr.length === 1 || dr.length === 2) &&
          dr.every((v) => typeof v === "string" && v.length > 0);
        if (!okString && !okPair) {
          out.push({
            kind: "invalid_date_range",
            member,
            message:
              `Time dimension "${member}" has an invalid dateRange — use one relative period ` +
              `(like "last 30 days") or a [from, to] pair of dates.`,
          });
        }
      }
    }
  }

  return out;
}

/**
 * Query complexity as counted by the endpoint's cap: measures + dimensions +
 * time dimensions (each time dimension is a grouping axis under the v1
 * granularity-required contract). Exported so the dashboards write path
 * enforces the SAME arithmetic — a query that saves must never later be
 * rejected as too complex (cinatra#1911). Tolerant of unknown shapes.
 */
export function queryComplexityOf(query: unknown): number {
  if (typeof query !== "object" || query === null) return 0;
  const q = query as Record<string, unknown>;
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return len(q.measures) + len(q.dimensions) + len(q.timeDimensions);
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
    if (!isSupportedFilter(f)) continue;
    if (!f.member.startsWith(prefix)) {
      unknown.push(f.member);
      continue;
    }
    const suffix = f.member.slice(prefix.length);
    if (!knownMemberIds.has(suffix)) unknown.push(f.member);
  }
  return unknown;
}

/**
 * Meta-dependent member validation (cinatra#1911) — everything that needs the
 * cube's dimension list in hand:
 *   - `unknownMembers`: supported-filter members AND `timeDimensions[].dimension`
 *     that don't name a known dimension of the cube (drizzle-cube silently
 *     drops unknown filter members — fail-closed, same rationale as
 *     `findUnknownFilterMembers`);
 *   - `nonTimeMembers`: `inDateRange` filter members and
 *     `timeDimensions[].dimension` that name a KNOWN dimension whose type is
 *     not time — drizzle-cube itself throws on a non-time dateRange target,
 *     so we reject earlier with readable copy.
 * Cinatra descriptors use type `"date"` for what drizzle-cube's meta calls
 * `"time"` (see `toCubeMetaCube`).
 */
export function findInvalidMetaMembers(
  q: CubeJsWireQuery,
  cubeId: string,
  dimensions: ReadonlyArray<{ readonly id: string; readonly type: string }>,
): { unknownMembers: string[]; nonTimeMembers: string[] } {
  const prefix = `${cubeId}.`;
  const knownIds = new Set(dimensions.map((d) => d.id));
  const timeIds = new Set(dimensions.filter((d) => d.type === "date").map((d) => d.id));
  // Filter-member unknowns (all supported operators) — the pre-existing check.
  const unknownMembers = findUnknownFilterMembers(q, cubeId, knownIds);
  const nonTimeMembers: string[] = [];
  const isKnown = (member: string): boolean =>
    member.startsWith(prefix) && knownIds.has(member.slice(prefix.length));
  const isTimeTyped = (member: string): boolean =>
    member.startsWith(prefix) && timeIds.has(member.slice(prefix.length));
  for (const f of q.filters ?? []) {
    // Unknowns already collected above — only the type check remains here.
    if (isSupportedFilter(f) && f.operator === "inDateRange" && isKnown(f.member) && !isTimeTyped(f.member)) {
      nonTimeMembers.push(f.member);
    }
  }
  for (const td of q.timeDimensions ?? []) {
    const member = typeof td?.dimension === "string" && td.dimension.length > 0 ? td.dimension : undefined;
    if (!member) continue;
    if (!isKnown(member)) unknownMembers.push(member);
    else if (!isTimeTyped(member)) nonTimeMembers.push(member);
  }
  return { unknownMembers, nonTimeMembers };
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
    firstSupportedFilterMember(q.filters);
  if (!firstMember) return null;
  const dot = firstMember.indexOf(".");
  return dot > 0 ? firstMember.slice(0, dot) : null;
}

// ─── Human-readable cube-scope messages (cinatra#1512) ─────────────────

/**
 * Distinct `<cube>.` prefixes referenced anywhere in a query-LIKE object, in
 * first-seen order. Walks the same member surfaces `resolveCubeIdFromQuery` /
 * cube-guard resolve cube ids from: measures, dimensions, segments,
 * timeDimensions[].dimension, order keys (object or legacy tuple-array form),
 * filters[].member. Tolerant of unknown/partial shapes (persisted portlet
 * configs are opaque to Zod) — anything non-conforming is skipped, so this is
 * safe to run on untrusted `analysisConfig.query` blobs at save time.
 */
export function collectQueryCubeIds(query: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (member: unknown): void => {
    if (typeof member !== "string") return;
    const dot = member.indexOf(".");
    if (dot <= 0) return;
    const cube = member.slice(0, dot);
    if (!seen.has(cube)) {
      seen.add(cube);
      out.push(cube);
    }
  };
  if (typeof query !== "object" || query === null) return out;
  const q = query as Record<string, unknown>;
  for (const key of ["measures", "dimensions", "segments"]) {
    const arr = q[key];
    if (Array.isArray(arr)) for (const m of arr) push(m);
  }
  if (Array.isArray(q.timeDimensions)) {
    for (const td of q.timeDimensions) {
      push((td as Record<string, unknown> | null)?.dimension);
    }
  }
  if (Array.isArray(q.order)) {
    // Legacy tuple-array order: [["<cube>.<member>", "asc"], …]
    for (const entry of q.order) {
      if (Array.isArray(entry)) push(entry[0]);
    }
  } else if (q.order && typeof q.order === "object") {
    for (const key of Object.keys(q.order)) push(key);
  }
  if (Array.isArray(q.filters)) {
    for (const f of q.filters) {
      push((f as Record<string, unknown> | null)?.member);
    }
  }
  return out;
}

/**
 * Cube id → display-ish name for error copy ("agent_runs" → "Agent Runs").
 * Deterministic title-casing so error paths never need async cube metadata;
 * acronym cubes (e.g. "llm_usage" → "Llm Usage") stay readable enough for an
 * error message.
 */
export function humanizeCubeId(cubeId: string): string {
  return cubeId
    .split(/[_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** "A" / "A and B" / "A, B, and C" — for cube-name lists in error copy. */
function formatNameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * The product copy for a single query that mixes fields from several cubes
 * (issue #1512 acceptance copy). Shared by the query endpoint's
 * `cube_id_ambiguous` message and the dashboards save-path validation so the
 * user reads the SAME explanation at save time and on a rendered error card.
 */
export function describeCrossCubeQuery(cubeIds: readonly string[]): string {
  const names = formatNameList(cubeIds.map(humanizeCubeId));
  return `This portlet mixes fields from ${names}. Choose fields from one data source.`;
}

/**
 * Assert all member references in `q` share the same `<cube>.` prefix.
 * Returns the prefix on success, or an error code on ambiguity / missing.
 * The error arm carries a human-readable `userMessage` (rendered verbatim by
 * drizzle-cube's error card, which throws `new Error(body.error)`) alongside
 * the machine `code`/`details`.
 */
export function resolveAndValidateCubeId(
  q: CubeJsWireQuery,
):
  | { ok: true; cubeId: string }
  | {
      ok: false;
      code: "cube_id_required" | "cube_id_ambiguous";
      userMessage: string;
      details: Readonly<Record<string, unknown>>;
    } {
  const cubeId = resolveCubeIdFromQuery(q);
  if (!cubeId) {
    return {
      ok: false,
      code: "cube_id_required",
      userMessage:
        "This card's query doesn't reference any data source fields. Edit this card and pick at least one measure or dimension.",
      details: { reason: "no fully-qualified members in query" },
    };
  }
  const allMembers: string[] = [
    ...(q.measures ?? []),
    ...(q.dimensions ?? []),
    ...((q.timeDimensions ?? []).map((td) => td.dimension)),
    ...Object.keys(q.order ?? {}),
    ...(q.segments ?? []),
    // Filter members participate in the same-cube check so a supported
    // filter on a foreign cube triggers `cube_id_ambiguous` (no widening).
    ...((q.filters ?? []).filter(isSupportedFilter).map((f) => f.member)),
  ];
  const prefix = `${cubeId}.`;
  const foreign = allMembers.filter((m) => !m.startsWith(prefix));
  if (foreign.length > 0) {
    // Multiple qualified cubes → name them all; otherwise the "foreign"
    // members are bare (`count`, not `<cube>.count`) and naming a single cube
    // as a mix would read wrong — name the offending fields instead.
    const cubes = collectQueryCubeIds(q);
    const explanation =
      cubes.length > 1
        ? describeCrossCubeQuery(cubes)
        : `Some fields in this card's query don't belong to the ${humanizeCubeId(cubeId)} data source (${foreign.join(", ")}). Choose fields from one data source.`;
    return {
      ok: false,
      code: "cube_id_ambiguous",
      userMessage: `${explanation} Edit this card to change its fields — retrying will not fix an invalid configuration.`,
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
 * The wire gate over the v1 executable feature surface (cinatra#1911) — a
 * thin wrapper over the shared `collectQueryFeatureViolations` predicate.
 * `reason` carries product copy (drizzle-cube's CubeClient throws
 * `new Error(body.error)` and the portlet error card renders `error.message`
 * verbatim), joined when a query violates on several counts.
 */
export function checkUnsupportedQueryFeature(
  q: CubeJsWireQuery,
): { code: string; reason: string } | null {
  const violations = collectQueryFeatureViolations(q);
  if (violations.length === 0) return null;
  return {
    code: "unsupported_query_feature",
    reason: violations.map((v) => v.message).join(" "),
  };
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
  // Map supported filters (validated upstream by
  // `checkUnsupportedQueryFeature`); strip the `<cube>.` prefix off each member.
  const filters = (q.filters ?? [])
    .filter(isSupportedFilter)
    .map((f) => ({
      member: stripCubePrefix(f.member, cubeId),
      operator: f.operator,
      values: [...f.values],
    }));
  // Map the (single, granularity-bearing — validated upstream) time dimension.
  // A 1-element dateRange array is a relative token; normalize it to the bare
  // string form so `QueryTimeDimension` stays string | [from, to].
  const timeDimensions = (q.timeDimensions ?? [])
    .filter(
      (td): td is { dimension: string; granularity: string; dateRange?: string | readonly string[] } =>
        typeof td?.dimension === "string" &&
        typeof td.granularity === "string" &&
        (SUPPORTED_TIME_GRANULARITIES as readonly string[]).includes(td.granularity),
    )
    .map((td) => {
      const dr = td.dateRange;
      const dateRange =
        typeof dr === "string"
          ? dr
          : Array.isArray(dr) && dr.length === 1
            ? dr[0]
            : Array.isArray(dr) && dr.length === 2
              ? ([dr[0], dr[1]] as const)
              : undefined;
      return {
        dimension: stripCubePrefix(td.dimension, cubeId),
        granularity: td.granularity as SupportedTimeGranularity,
        ...(dateRange !== undefined ? { dateRange } : {}),
      };
    });
  const out: QuerySpec = {
    ...(measures && measures.length > 0 ? { measures } : {}),
    ...(dimensions && dimensions.length > 0 ? { dimensions } : {}),
    ...(timeDimensions.length > 0 ? { timeDimensions } : {}),
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
