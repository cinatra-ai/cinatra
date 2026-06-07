/**
 * Adapter-internal types. Public consumers of sdk-dashboard see only the
 * Cinatra DTOs in `../../types/`; this file translates between those and
 * drizzle-cube's `Cube` shape.
 */
import type { Cube as DCCube } from "drizzle-cube/server";
import type { CubeDescriptor } from "../../types/cube";

/**
 * A cube descriptor paired with its compiled drizzle-cube `Cube` object.
 * Produced by `defineCinatraCube()` and consumed by `createDrizzleCubeAdapter()`.
 */
export type RegisteredCube = {
  readonly descriptor: CubeDescriptor;
  readonly dcCube: DCCube;
};
