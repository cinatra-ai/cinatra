/**
 * Translation layer: Cinatra `CubeDescriptor` → drizzle-cube `Cube`.
 *
 * Consumers describe a cube as a Cinatra `CubeDescriptor` (backend-agnostic
 * metadata) plus a `buildSql` callback that returns drizzle-cube's
 * `BaseQueryDefinition`. This helper packages both into a `RegisteredCube`
 * that `createDrizzleCubeAdapter` accepts.
 *
 * The `buildSql` callback is the ONLY place where consumers express
 * drizzle-cube concepts. Even there, the host package supplies the callback
 * — sdk-dashboard never inlines a specific schema reference.
 */
import {
  defineCube,
  type BaseQueryDefinition,
  type QueryContext,
  type Dimension,
  type Measure,
  type DimensionType,
  type MeasureType,
} from "drizzle-cube/server";

import type {
  CubeDescriptor,
  CubeDimensionDescriptor,
  CubeMeasureDescriptor,
} from "../../types/cube";

import type { RegisteredCube } from "./types";

type DimensionSql = Dimension["sql"];
type MeasureSql = NonNullable<Measure["sql"]>;

/** Map Cinatra DTO dimension type → drizzle-cube `DimensionType`. */
function toDcDimensionType(t: CubeDimensionDescriptor["type"]): DimensionType {
  // Cinatra DTO uses "date"; drizzle-cube uses "time".
  if (t === "date") return "time";
  return t;
}

/** Map Cinatra DTO measure type → drizzle-cube `MeasureType`. */
function toDcMeasureType(t: CubeMeasureDescriptor["type"]): MeasureType {
  return t;
}

export type CinatraCubeBuild = {
  /** Builds the base query (FROM / JOINs / WHERE). The WHERE clause is the place to inject `securityContext`-derived row filtering. */
  readonly buildSql: (ctx: QueryContext) => BaseQueryDefinition;
  /** Drizzle-cube `Dimension.sql` per dimension id (must match descriptor.dimensions). */
  readonly dimensionSql: Readonly<Record<string, DimensionSql>>;
  /** Drizzle-cube `Measure.sql` per measure id (must match descriptor.measures). */
  readonly measureSql: Readonly<Record<string, MeasureSql>>;
};

/**
 * Compile a Cinatra `CubeDescriptor` + drizzle-cube SQL functions into a
 * `RegisteredCube` ready for `createDrizzleCubeAdapter`.
 *
 * Validates that every descriptor dimension/measure has a matching SQL entry
 * — missing entries throw at registration time, not at query time.
 */
export function defineCinatraCube(
  descriptor: CubeDescriptor,
  build: CinatraCubeBuild,
): RegisteredCube {
  // Validate that build provides SQL for every descriptor member.
  for (const dim of descriptor.dimensions) {
    if (!(dim.id in build.dimensionSql)) {
      throw new Error(
        `defineCinatraCube(${descriptor.id}): missing dimensionSql["${dim.id}"]`,
      );
    }
  }
  for (const measure of descriptor.measures) {
    if (!(measure.id in build.measureSql)) {
      throw new Error(
        `defineCinatraCube(${descriptor.id}): missing measureSql["${measure.id}"]`,
      );
    }
  }

  const dcDimensions: Record<string, Dimension> = {};
  for (const dim of descriptor.dimensions) {
    dcDimensions[dim.id] = {
      name: dim.id,
      title: dim.displayName,
      type: toDcDimensionType(dim.type),
      sql: build.dimensionSql[dim.id],
    };
  }

  const dcMeasures: Record<string, Measure> = {};
  for (const measure of descriptor.measures) {
    dcMeasures[measure.id] = {
      name: measure.id,
      title: measure.displayName,
      type: toDcMeasureType(measure.type),
      sql: build.measureSql[measure.id],
    };
  }

  const dcCube = defineCube(descriptor.id, {
    title: descriptor.displayName,
    description: descriptor.description,
    sql: build.buildSql,
    dimensions: dcDimensions,
    measures: dcMeasures,
  });

  return { descriptor, dcCube, build };
}

/**
 * Derive a runtime-ALIAS `RegisteredCube` from an already-compiled host cube,
 * reusing the host's SQL build (FROM/JOIN/WHERE + per-member SQL) UNCHANGED.
 *
 * The alias gets a NEW cube id (`aliasId`) and a SUBSET of the base cube's
 * members (`memberIds`). This is how a runtime-installed extension exposes a
 * host-allowlisted cube under its own id with a narrower projection WITHOUT
 * supplying any SQL — every dimension/measure SQL and the tenant predicate come
 * from `base.build`, so the alias inherits the base cube's EXACT row filtering.
 *
 * Fail-closed: an empty `aliasId`, an alias id equal to the base id, an empty
 * member set, or any `memberId` not present on the base cube THROWS — a runtime
 * cube can never reference a member (and therefore a column) the host did not
 * already publish for that table.
 */
export function aliasCinatraCube(
  base: RegisteredCube,
  aliasId: string,
  memberIds: readonly string[],
): RegisteredCube {
  if (!aliasId || aliasId.length === 0) {
    throw new Error("aliasCinatraCube: aliasId is required");
  }
  if (aliasId === base.descriptor.id) {
    throw new Error(
      `aliasCinatraCube: aliasId "${aliasId}" must differ from the base cube id`,
    );
  }
  const want = new Set(memberIds);
  if (want.size === 0) {
    throw new Error(`aliasCinatraCube(${aliasId}): at least one member is required`);
  }
  const baseDimensions = new Map(base.descriptor.dimensions.map((d) => [d.id, d]));
  const baseMeasures = new Map(base.descriptor.measures.map((m) => [m.id, m]));
  const dimensions: CubeDescriptor["dimensions"][number][] = [];
  const measures: CubeDescriptor["measures"][number][] = [];
  for (const id of want) {
    const dim = baseDimensions.get(id);
    const meas = baseMeasures.get(id);
    if (dim) dimensions.push(dim);
    else if (meas) measures.push(meas);
    else {
      throw new Error(
        `aliasCinatraCube(${aliasId}): member "${id}" is not published by base cube "${base.descriptor.id}"`,
      );
    }
  }
  const aliasDescriptor: CubeDescriptor = {
    id: aliasId,
    version: base.descriptor.version,
    displayName: base.descriptor.displayName,
    description: base.descriptor.description,
    dimensions,
    measures,
  };
  // Reuse the host SQL build verbatim — defineCinatraCube only reads the SQL
  // entries for members named in the alias descriptor, so the subset is
  // honoured while the FROM/JOIN/WHERE (and thus the tenant predicate) is the
  // base cube's exact closure.
  return defineCinatraCube(aliasDescriptor, base.build);
}
