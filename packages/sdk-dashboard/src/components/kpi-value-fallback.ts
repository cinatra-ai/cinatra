// THE KPI VALUE FALLBACK MARKER (cinatra#4311).
//
// drizzle-cube's KPI charts (kpiNumber, kpiText) paint their value with an
// INLINE colour taken from the dashboard colour palette the provider is given,
// and, when that palette has no first colour, with the literal `#1f2937`, which does
// not follow the dark palette. The palette reaches a chart only through the
// `colorPalette` prop of `DashboardProvider`; nothing derives it from the
// dashboard configuration.
//
// A host therefore KNOWS, from the props it mounts the provider with, whether a
// KPI value is drizzle-cube's fallback. drizzle-cube decides it with
// `colors?.[0] || '#1f2937'` (kpiText's colour helper, and KpiNumber's
// resolveValueColor when no valueColorIndex is set): the TRUTHINESS of the
// palette's first entry, not the array's length. This helper uses the same
// predicate, so an empty, sparse, undefined or null first entry is the
// fallback too. The host says so with this attribute on an element around the
// grid, and `dashboard-theme.css` repaints the fallback with the foreground
// token only under it. A host whose palette has a first colour gets no marker,
// so its colours are never repainted, whatever their value. (The one palette
// colour that can sit under the marker is a later entry that a portlet's
// valueColorIndex picks from a palette whose first entry is empty.) A pure leaf
// so both hosts (this SDK's read-only composition and the editable home in
// @cinatra-ai/dashboards) share one rule and it is provable without rendering
// drizzle-cube.

/** The attribute the theme's KPI fallback rule is scoped to. */
export const KPI_VALUE_FALLBACK_ATTRIBUTE = "data-cinatra-kpi-fallback";

/** The palette shape the provider takes, as far as this rule reads it. */
type PaletteLike = { readonly colors?: readonly unknown[] | null } | null | undefined;

/**
 * The marker attribute for a provider mounted with `colorPalette`: present
 * (value "foreground") when the palette's first entry is falsy, which is when
 * drizzle-cube falls back to `#1f2937`; absent otherwise.
 */
export function kpiValueFallbackAttributes(
  colorPalette: PaletteLike,
): Record<typeof KPI_VALUE_FALLBACK_ATTRIBUTE, "foreground"> | Record<string, never> {
  return colorPalette?.colors?.[0] ? {} : { [KPI_VALUE_FALLBACK_ATTRIBUTE]: "foreground" };
}
