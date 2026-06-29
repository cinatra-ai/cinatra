/**
 * Adapter-internal types. Public consumers of sdk-dashboard see only the
 * Cinatra DTOs in `../../types/`; this file translates between those and
 * drizzle-cube's `Cube` shape.
 */
import type { Cube as DCCube, QueryContext, BaseQueryDefinition, Dimension, Measure } from "drizzle-cube/server";
import type { CubeDescriptor } from "../../types/cube";

/**
 * The host-owned SQL build for a cube: the FROM/JOIN/WHERE base query plus the
 * per-member SQL expressions. This is the ONLY place a consumer expresses
 * drizzle-cube SQL — it is ALWAYS host-supplied, NEVER extension-supplied
 * (preserving the no-unsigned-code-execution invariant). Carried back on the
 * `RegisteredCube` so the runtime-cube registry can ALIAS a host cube under a
 * new id with a member SUBSET while reusing the SAME host SQL + tenant
 * predicate (no SQL duplication, no extension expressions).
 */
export type CinatraCubeBuildSql = {
  readonly buildSql: (ctx: QueryContext) => BaseQueryDefinition;
  readonly dimensionSql: Readonly<Record<string, Dimension["sql"]>>;
  readonly measureSql: Readonly<Record<string, NonNullable<Measure["sql"]>>>;
};

/**
 * A cube descriptor paired with its compiled drizzle-cube `Cube` object.
 * Produced by `defineCinatraCube()` and consumed by `createDrizzleCubeAdapter()`.
 *
 * `build` carries the host-owned SQL closures back so a runtime-cube alias can
 * be derived from a host cube WITHOUT re-declaring (and therefore without
 * duplicating / drifting) the tenant predicate or member SQL.
 */
export type RegisteredCube = {
  readonly descriptor: CubeDescriptor;
  readonly dcCube: DCCube;
  readonly build: CinatraCubeBuildSql;
};
