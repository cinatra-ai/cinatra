/**
 * Dashboards query endpoint (Cube.js-compatible).
 *
 * Serves three endpoints:
 *
 *   GET  /api/dashboards/cubejs-api/v1/meta
 *     Returns drizzle-cube `CubeMeta` shape `{ cubes: CubeMetaCube[] }`.
 *     Member names are fully-qualified `<cube>.<member>`. Cinatra
 *     `dimension.type === "date"` is mapped to `"time"` so AnalysisBuilder
 *     surfaces granularity controls.
 *
 *   GET  /api/dashboards/cubejs-api/v1/load?query=<encoded JSON>
 *     drizzle-cube/client wire format. Returns Cube.js
 *     `{ data, query, annotation }`. Cinatra-internal `useCubeQuery` ALSO
 *     uses this endpoint via POST (response shape unified).
 *
 *   POST /api/dashboards/cubejs-api/v1/load   { cubeId, query }  (legacy)
 *   POST /api/dashboards/cubejs-api/v1/load   <CubeJsWireQuery>   (cube.js)
 *     Same response shape as GET for parity.
 *
 *   POST /api/dashboards/cubejs-api/v1/batch  { queries: CubeQuery[] }
 *     drizzle-cube/client multi-query path. Serial-N over /load logic.
 *     HTTP 200 with per-query partial-success items.
 *     Envelope errors (malformed body, queries.length > BATCH_MAX_QUERIES,
 *     auth) produce non-2xx.
 *
 * Any other endpoint path returns 404 because the endpoint allowlist is strict.
 *
 * v1 rejects unsupported analysis types (funnel/flow/retention/multi-query)
 * with `400 unsupported_analysis_type` and unsupported query features
 * (filters, timeDimensions.granularity) with `400 unsupported_query_feature`.
 */
import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { AdapterHandle } from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";
// Pull the AdapterHandle from the shared `DashboardCubesPlatform` instead of
// building a transport-private adapter. The same `SemanticLayerCompiler`
// instance powers MCP cube tools as well, preventing cube-registry drift
// between transports.
import { getDashboardCubesPlatform } from "@cinatra-ai/dashboards/cubes-platform";
import {
  isAllowedEndpoint,
  QUERY_ENDPOINT_LIMITS,
  BATCH_MAX_QUERIES,
  resolveAndValidateCubeId,
  checkUnsupportedAnalysisType,
  checkUnsupportedQueryFeature,
  findUnknownFilterMembers,
  toQuerySpec,
  toCubeJsLoadResponse,
  toCubeMeta,
  type CubeJsWireQuery,
  type CubeJsBatchResultItem,
  type QueryEndpointError,
  type QueryResult,
  type SecurityContext,
} from "@cinatra-ai/sdk-dashboard";

import { getAuthSession } from "@/lib/auth-session";
import { listAccessibleOrgIdsForUser } from "@/lib/better-auth-db";
import {
  buildSecurityContextWithVisibility,
  DASHBOARD_VISIBILITY_RESOLVERS,
} from "@cinatra-ai/dashboards/auth";
// `humanizeAgentRunsRows` is shared so the HTTP cubejs route stays slim. The
// MCP cube-tools path (`packages/dashboards/src/mcp-cubes/`) deliberately does
// NOT humanise; LLM clients format the raw epoch seconds themselves.
import { humanizeAgentRunsRows } from "@cinatra-ai/dashboards/cubes-post-process";

// ─── Shared cube platform ──────────────────────────────────────────────
// The `DashboardCubesPlatform` is built once per process and shared with the
// MCP cube-tools transport. Per-transport `globalThis.__cinatraDashboardsAdapter`
// and `__cinatraDashboardsPool` singletons are avoided so all transports use the
// same registry.

function getAdapter(): AdapterHandle {
  return getDashboardCubesPlatform().adapter;
}

function errorResponse(
  status: number,
  body: QueryEndpointError,
): NextResponse {
  return NextResponse.json(body, { status });
}

async function resolveSecurityContext(): Promise<SecurityContext | null> {
  const session = await getAuthSession();
  if (!session?.user?.id) return null;
  const organizationId = session.session?.activeOrganizationId ?? "";
  if (!organizationId) return null;
  // Widen `accessibleOrgIds` to every org the user is a member of AND
  // pre-compute the projects/teams/artifacts visibility-id lists the
  // cubes read in their `WHERE id IN (...)` predicates. Each
  // resolver delegates to the canonical scope helpers so the cube layer
  // never re-implements sealed-room / project_access / ownership-tier
  // authz. Resolver failures fail closed per-field.
  return buildSecurityContextWithVisibility(
    { userId: session.user.id, organizationId },
    listAccessibleOrgIdsForUser,
    DASHBOARD_VISIBILITY_RESOLVERS,
  );
}

function clampQuery<T extends { limit?: number }>(q: T): T & { limit: number } {
  const limit = Math.min(q.limit ?? QUERY_ENDPOINT_LIMITS.maxRows, QUERY_ENDPOINT_LIMITS.maxRows);
  return { ...q, limit };
}

function queryComplexity(q: CubeJsWireQuery): number {
  return (q.measures?.length ?? 0) + (q.dimensions?.length ?? 0) + (q.timeDimensions?.length ?? 0);
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }> {
  return await Promise.race<
    { ok: true; value: T } | { ok: false; reason: "timeout" }
  >([
    promise.then((value) => ({ ok: true, value }) as const),
    new Promise<{ ok: false; reason: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms),
    ),
  ]);
}

/**
 * Shared per-query execution path used by GET /load, POST /load, AND each
 * item of POST /batch. Returns either a Cube.js-shaped success payload or
 * a structured error description (used by /batch for per-item failures
 * and by /load for top-level rejection).
 */
async function executeWireQuery(
  wireQuery: CubeJsWireQuery,
  ctx: SecurityContext,
):
  | Promise<
      | { ok: true; result: QueryResult; cubeId: string }
      | { ok: false; status: number; body: QueryEndpointError }
    > {
  const analysis = checkUnsupportedAnalysisType(wireQuery);
  if (analysis) {
    return {
      ok: false,
      status: 400,
      body: { error: analysis.reason, code: "unsupported_analysis_type" },
    };
  }
  const feature = checkUnsupportedQueryFeature(wireQuery);
  if (feature) {
    return {
      ok: false,
      status: 400,
      body: { error: feature.reason, code: "unsupported_query_feature" },
    };
  }
  if (queryComplexity(wireQuery) > QUERY_ENDPOINT_LIMITS.maxQueryComplexity) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Query complexity exceeds ${QUERY_ENDPOINT_LIMITS.maxQueryComplexity} members`,
        code: "query_too_complex",
        details: { complexity: queryComplexity(wireQuery) },
      },
    };
  }
  const resolved = resolveAndValidateCubeId(wireQuery);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: resolved.code, code: resolved.code, details: resolved.details },
    };
  }
  const adapter = getAdapter();
  // Fail-closed: an `equals` filter on a member the cube does NOT define — or on
  // a MEASURE (drizzle-cube silently drops measure filters in WHERE context) —
  // would fail to narrow, widening a single-entity query back to the full
  // visible set. Validate filter members against the cube's DIMENSIONS only and
  // reject anything else before execution. (The per-cube SecurityContext
  // predicate still AND-applies, so this is defense-in-depth, not the only guard.)
  if (Array.isArray(wireQuery.filters) && wireQuery.filters.length > 0) {
    const descriptor = await adapter.getCubeMeta(resolved.cubeId, ctx);
    const knownMemberIds = new Set<string>(
      descriptor.dimensions.map((d) => d.id),
    );
    const unknownMembers = findUnknownFilterMembers(
      wireQuery,
      resolved.cubeId,
      knownMemberIds,
    );
    if (unknownMembers.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "filter references unknown cube member(s)",
          code: "unsupported_query_feature",
          details: { unknownMembers },
        },
      };
    }
  }
  const spec = toQuerySpec(wireQuery, resolved.cubeId);
  const clamped = clampQuery(spec);
  const raced = await runWithTimeout(
    adapter.executeQuery(resolved.cubeId, clamped, ctx),
    QUERY_ENDPOINT_LIMITS.timeoutMs,
  );
  if (!raced.ok) {
    return {
      ok: false,
      status: 504,
      body: { error: "Query exceeded timeout", code: "timeout", details: { timeoutMs: QUERY_ENDPOINT_LIMITS.timeoutMs } },
    };
  }
  return { ok: true, result: raced.value, cubeId: resolved.cubeId };
}

// ─── Handlers ───────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ endpoint: string[] }> },
): Promise<NextResponse> {
  const { endpoint } = await params;
  if (endpoint.length !== 1 || !isAllowedEndpoint(endpoint[0])) {
    return errorResponse(404, {
      error: `Endpoint not allowed: ${endpoint.join("/")}`,
      code: "endpoint_not_allowed",
    });
  }
  const ctx = await resolveSecurityContext();
  if (!ctx) {
    return errorResponse(401, { error: "Unauthorized", code: "unauthorized" });
  }

  if (endpoint[0] === "meta") {
    const adapter = getAdapter();
    const cubeIds = adapter.listCubeIds();
    const descriptors = await Promise.all(cubeIds.map((id) => adapter.getCubeMeta(id, ctx)));
    return NextResponse.json(toCubeMeta(descriptors));
  }

  if (endpoint[0] === "load") {
    // drizzle-cube/client wire: GET /load?query=<encoded JSON>
    const queryParam = req.nextUrl.searchParams.get("query");
    if (!queryParam) {
      return errorResponse(400, {
        error: "Missing ?query= parameter",
        code: "body_parse_failed",
      });
    }
    let wire: CubeJsWireQuery;
    try {
      wire = JSON.parse(queryParam) as CubeJsWireQuery;
    } catch {
      return errorResponse(400, {
        error: "?query= is not valid JSON",
        code: "body_parse_failed",
      });
    }
    const exec = await executeWireQuery(wire, ctx);
    if (!exec.ok) return errorResponse(exec.status, exec.body);
    const humanizedResult = { ...exec.result, rows: humanizeAgentRunsRows(exec.result.rows) };
    return NextResponse.json(toCubeJsLoadResponse(humanizedResult, wire));
  }

  // /batch is POST-only.
  return errorResponse(405, {
    error: `Endpoint ${endpoint[0]} does not accept GET`,
    code: "endpoint_not_allowed",
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ endpoint: string[] }> },
): Promise<NextResponse> {
  const { endpoint } = await params;
  if (endpoint.length !== 1 || !isAllowedEndpoint(endpoint[0])) {
    return errorResponse(404, {
      error: `Endpoint not allowed: ${endpoint.join("/")}`,
      code: "endpoint_not_allowed",
    });
  }
  if (endpoint[0] === "meta") {
    return errorResponse(405, {
      error: "GET /meta only",
      code: "endpoint_not_allowed",
    });
  }
  const ctx = await resolveSecurityContext();
  if (!ctx) {
    return errorResponse(401, { error: "Unauthorized", code: "unauthorized" });
  }

  // ─── Body size caps ───
  const contentLengthHeader = Number(req.headers.get("content-length") ?? "0");
  if (contentLengthHeader > QUERY_ENDPOINT_LIMITS.maxBodyBytes) {
    return errorResponse(413, {
      error: `Body exceeds ${QUERY_ENDPOINT_LIMITS.maxBodyBytes} bytes`,
      code: "body_too_large",
      details: { contentLength: contentLengthHeader },
    });
  }
  const rawBody = await req.text();
  const actualBytes = Buffer.byteLength(rawBody, "utf-8");
  if (actualBytes > QUERY_ENDPOINT_LIMITS.maxBodyBytes) {
    return errorResponse(413, {
      error: `Body exceeds ${QUERY_ENDPOINT_LIMITS.maxBodyBytes} bytes (post-read)`,
      code: "body_too_large",
      details: { contentLength: contentLengthHeader, actualBytes },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, { error: "Body is not valid JSON", code: "body_parse_failed" });
  }

  if (endpoint[0] === "load") {
    // POST /load accepts either:
    //  - { cubeId, query }  (legacy Cinatra `useCubeQuery` shape)
    //  - <CubeJsWireQuery>  (Cube.js shape — what drizzle-cube/client uses
    //    when batching/POST is forced)
    let wire: CubeJsWireQuery;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.cubeId === "string" &&
      typeof obj.query === "object" &&
      obj.query !== null
    ) {
      // Legacy shape — wrap bare query members in cubeId-prefixed form so
      // the executor sees a uniformly fully-qualified wire query.
      const cubeId = obj.cubeId;
      const inner = obj.query as Record<string, unknown>;
      const measures = Array.isArray(inner.measures)
        ? (inner.measures as string[]).map((m) => m.includes(".") ? m : `${cubeId}.${m}`)
        : undefined;
      const dimensions = Array.isArray(inner.dimensions)
        ? (inner.dimensions as string[]).map((d) => d.includes(".") ? d : `${cubeId}.${d}`)
        : undefined;
      const orderInput = inner.order;
      let order: Record<string, "asc" | "desc"> | undefined;
      if (Array.isArray(orderInput)) {
        order = {};
        for (const entry of orderInput as Array<[string, "asc" | "desc"]>) {
          const key = entry[0].includes(".") ? entry[0] : `${cubeId}.${entry[0]}`;
          order[key] = entry[1];
        }
      } else if (orderInput && typeof orderInput === "object") {
        order = orderInput as Record<string, "asc" | "desc">;
      }
      // Carry same-cube filters through the legacy shape (prefix bare members
      // so the executor sees a uniformly fully-qualified wire query). Shape +
      // member validity are enforced downstream by executeWireQuery.
      const filtersInput = inner.filters;
      const filters = Array.isArray(filtersInput)
        ? (filtersInput as Array<Record<string, unknown>>).map((f) => {
            const member =
              typeof f.member === "string" && !f.member.includes(".")
                ? `${cubeId}.${f.member}`
                : f.member;
            return { ...f, member };
          })
        : undefined;
      wire = {
        measures,
        dimensions,
        order,
        filters,
        limit: typeof inner.limit === "number" ? inner.limit : undefined,
        offset: typeof inner.offset === "number" ? inner.offset : undefined,
      };
    } else if (typeof obj === "object" && obj !== null) {
      wire = obj as CubeJsWireQuery;
    } else {
      return errorResponse(400, {
        error: "Body must be a query object",
        code: "body_parse_failed",
      });
    }
    const exec = await executeWireQuery(wire, ctx);
    if (!exec.ok) return errorResponse(exec.status, exec.body);
    const humanizedResult = { ...exec.result, rows: humanizeAgentRunsRows(exec.result.rows) };
    return NextResponse.json(toCubeJsLoadResponse(humanizedResult, wire));
  }

  if (endpoint[0] === "batch") {
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.queries)) {
      return errorResponse(400, {
        error: "Body must be { queries: CubeQuery[] }",
        code: "body_parse_failed",
      });
    }
    const queries = obj.queries as CubeJsWireQuery[];
    if (queries.length > BATCH_MAX_QUERIES) {
      return errorResponse(400, {
        error: `Batch exceeds ${BATCH_MAX_QUERIES} queries`,
        code: "batch_too_large",
        details: { length: queries.length, max: BATCH_MAX_QUERIES },
      });
    }
    // Serial-N; per-query failures become partial-success items. Whole-batch
    // failures are envelope-level only.
    const results: CubeJsBatchResultItem[] = [];
    for (const wire of queries) {
      const exec = await executeWireQuery(wire, ctx);
      if (exec.ok) {
        results.push({
          success: true,
          data: humanizeAgentRunsRows(exec.result.rows),
          query: wire,
          annotation: {},
        });
      } else {
        results.push({ success: false, error: exec.body.error, query: wire });
      }
    }
    return NextResponse.json({ results });
  }

  return errorResponse(404, {
    error: `Endpoint not allowed: ${endpoint[0]}`,
    code: "endpoint_not_allowed",
  });
}
