export type CubeMeasureDescriptor = {
  readonly id: string;
  readonly displayName: string;
  readonly type: "count" | "sum" | "avg" | "min" | "max" | "countDistinct";
  readonly format?: "number" | "currency" | "percent" | "duration";
};

export type CubeDimensionDescriptor = {
  readonly id: string;
  readonly displayName: string;
  readonly type: "string" | "number" | "date" | "boolean";
};

/**
 * Descriptive metadata about a cube. The actual drizzle-cube `Cube` object
 * (with its `sql` function and Drizzle expressions) is constructed by the
 * adapter from this descriptor. Consumers of sdk-dashboard never see the
 * underlying drizzle-cube type.
 */
export type CubeDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly measures: ReadonlyArray<CubeMeasureDescriptor>;
  readonly dimensions: ReadonlyArray<CubeDimensionDescriptor>;
};
