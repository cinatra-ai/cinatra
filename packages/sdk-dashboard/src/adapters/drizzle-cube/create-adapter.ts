/**
 * The Cinatra ↔ drizzle-cube adapter.
 *
 * Produces an `AdapterHandle` exposing `executeQuery(cubeId, query, ctx)` and
 * `getCubeMeta(cubeId, ctx)` — Cinatra DTOs in, Cinatra DTOs out. Internally
 * wraps `createDrizzleSemanticLayer` and registers each `RegisteredCube`.
 *
 * Consumers never see drizzle-cube types. Host glue (`packages/dashboards`)
 * supplies the Drizzle db handle, schema, and a host-defined cube list.
 *
 * Layer construction lives in `_buildAdapterFromLayer` so `platform.ts` can share one
 * `SemanticLayerCompiler` instance between the HTTP cubejs route and the
 * MCP cube tools. `createDrizzleCubeAdapter` retains its prior shape for
 * callers that only want the HTTP transport.
 */
import {
  createDrizzleSemanticLayer,
  type SecurityContext as DCSecurityContext,
  type SemanticLayerCompiler,
  type SemanticQuery,
} from "drizzle-cube/server";

import type {
  CubeDescriptor,
  QueryResult,
  QueryResultRow,
  QuerySpec,
  SecurityContext,
} from "../../types/index";

import type { RegisteredCube } from "./types";

export type AdapterHandle = {
  /**
   * Execute a Cinatra `QuerySpec` against the named cube. Throws if the cube
   * is unknown. The returned `QueryResult` rows preserve drizzle-cube's
   * `${cubeName}.${memberName}` member keys.
   */
  executeQuery(
    cubeId: string,
    query: QuerySpec,
    ctx: SecurityContext,
  ): Promise<QueryResult>;

  /** Returns the static Cinatra descriptor for the named cube. */
  getCubeMeta(cubeId: string, ctx: SecurityContext): Promise<CubeDescriptor>;

  /** Names of all registered cubes (handy for tests and catalog surfaces). */
  listCubeIds(): readonly string[];
};

export type DrizzleCubeAdapterOptions = {
  /**
   * A Drizzle database handle. Typed as `unknown` because the adapter must
   * not import drizzle-orm itself — the host injects this.
   */
  readonly drizzle: unknown;
  /** Drizzle schema (tables, relations). Optional but typical. */
  readonly schema?: unknown;
  /** Cubes to register, produced by `defineCinatraCube()`. */
  readonly cubes: ReadonlyArray<RegisteredCube>;
};

/**
 * Translate Cinatra `QuerySpec` → drizzle-cube `SemanticQuery`. Member names
 * are prefixed with `${cubeName}.` because that's how drizzle-cube references
 * them across cubes.
 */
function toSemanticQuery(cubeId: string, query: QuerySpec): SemanticQuery {
  const dot = `${cubeId}.`;
  const out: SemanticQuery = {};
  if (query.measures && query.measures.length > 0) {
    out.measures = query.measures.map((m) => dot + m);
  }
  if (query.dimensions && query.dimensions.length > 0) {
    out.dimensions = query.dimensions.map((d) => dot + d);
  }
  if (typeof query.limit === "number") out.limit = query.limit;
  if (typeof query.offset === "number") out.offset = query.offset;
  if (query.order && query.order.length > 0) {
    const orderRecord: Record<string, "asc" | "desc"> = {};
    for (const [member, direction] of query.order) {
      orderRecord[dot + member] = direction;
    }
    out.order = orderRecord;
  }
  if (query.filters && query.filters.length > 0) {
    // Re-prefix each bare member back to `<cube>.<member>` for drizzle-cube's
    // native filter DSL. v1 only carries same-cube `equals` predicates.
    out.filters = query.filters.map((f) => ({
      member: dot + f.member,
      operator: f.operator,
      values: [...f.values],
    }));
  }
  return out;
}

/**
 * Widen Cinatra's typed `SecurityContext` to drizzle-cube's `[k]: unknown`
 * shape. drizzle-cube treats it as opaque; our cube SQL functions read the
 * fields back as Cinatra-typed.
 */
function toDcSecurityContext(ctx: SecurityContext): DCSecurityContext {
  return {
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    teamIds: ctx.teamIds,
    ownerLevel: ctx.ownerLevel,
    // Propagate `accessibleOrgIds` so the cube's SQL function sees the full
    // multi-org membership. WITHOUT this, the HTTP cubejs route silently falls
    // back to active-org-only at the cube layer (`readAccessibleOrgIds`
    // defensively returns `[organizationId]` when the field is missing).
    accessibleOrgIds: ctx.accessibleOrgIds,
    // Visibility-id lists for the projects/teams/artifacts cubes.
    // Each cube fails closed when its list is undefined or empty (no rows
    // visible) — never widens the surface. The host's
    // `buildSecurityContextWithVisibility` helper computes these before
    // query execution so cubes stay synchronous.
    visibleProjectIds: ctx.visibleProjectIds,
    visibleTeamIds: ctx.visibleTeamIds,
    visibleArtifactIds: ctx.visibleArtifactIds,
    // Platform-admin flag for the llm_usage cube's fail-closed visibility
    // gate. WITHOUT this hand-whitelist entry the cube would always read
    // `undefined` and surface zero rows even to a platform admin.
    isPlatformAdmin: ctx.isPlatformAdmin,
  };
}

/**
 * Build an `AdapterHandle` against a pre-built `SemanticLayerCompiler` that
 * has its cubes ALREADY registered. Used by `platform.ts` to share one
 * layer between the HTTP cubejs route and the MCP cube tools. Caller is
 * responsible for `layer.registerCube` on each cube BEFORE calling this.
 *
 * Internal API — exposed for platform composition only. Underscore prefix
 * signals "do not import outside the adapter directory".
 */
export function _buildAdapterFromLayer(
  layer: SemanticLayerCompiler,
  cubes: ReadonlyArray<RegisteredCube>,
): AdapterHandle {
  const byId = new Map<string, RegisteredCube>();
  for (const reg of cubes) byId.set(reg.descriptor.id, reg);

  return {
    async executeQuery(cubeId, query, ctx) {
      const reg = byId.get(cubeId);
      if (!reg) throw new Error(`Unknown cube: ${cubeId}`);
      const semanticQuery = toSemanticQuery(cubeId, query);
      const dcCtx = toDcSecurityContext(ctx);
      const t0 = performance.now();
      const dcResult = await layer.executeQuery(cubeId, semanticQuery, dcCtx);
      const elapsedMs = performance.now() - t0;
      // drizzle-cube QueryResult shape: { data: Array<row>, ... }. Normalize
      // to Cinatra QueryResult; preserve raw row shape unchanged for v1.
      const rows = (
        (dcResult as { data?: ReadonlyArray<QueryResultRow> }).data ?? []
      ) as readonly QueryResultRow[];
      return {
        rows,
        meta: { cubeId, elapsedMs },
      };
    },

    async getCubeMeta(cubeId) {
      const reg = byId.get(cubeId);
      if (!reg) throw new Error(`Unknown cube: ${cubeId}`);
      return reg.descriptor;
    },

    listCubeIds() {
      return Array.from(byId.keys());
    },
  };
}

export function createDrizzleCubeAdapter(
  opts: DrizzleCubeAdapterOptions,
): AdapterHandle {
  const layer = createDrizzleSemanticLayer({
    drizzle: opts.drizzle as never,
    schema: opts.schema,
  });
  for (const reg of opts.cubes) {
    layer.registerCube(reg.dcCube);
  }
  return _buildAdapterFromLayer(layer, opts.cubes);
}
