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

  return { descriptor, dcCube };
}
