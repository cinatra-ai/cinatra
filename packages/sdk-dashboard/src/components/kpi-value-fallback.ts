// THE KPI VALUE FALLBACK MARKER (cinatra#4311).
//
// drizzle-cube's KPI charts (kpiNumber, kpiText) paint their value with an
// INLINE colour taken from the dashboard colour palette the provider is given,
// and, when that palette has no colours, with the literal `#1f2937`, which does
// not follow the dark palette. The palette reaches a chart only through the
// `colorPalette` prop of `DashboardProvider`; nothing derives it from the
// dashboard configuration.
//
// A host therefore KNOWS, from the props it mounts the provider with, whether a
// KPI value is drizzle-cube's fallback: exactly when it passes no palette with
// colours. It says so with this attribute on an element around the grid, and
// `dashboard-theme.css` repaints the fallback with the foreground token only
// under it. A host that passes a palette gets no marker, so a palette colour is
// never repainted, whatever its value. A pure leaf so both hosts (this SDK's
// read-only composition and the editable home in @cinatra-ai/dashboards) share
// one rule and it is provable without rendering drizzle-cube.

/** The attribute the theme's KPI fallback rule is scoped to. */
export const KPI_VALUE_FALLBACK_ATTRIBUTE = "data-cinatra-kpi-fallback";

/** The palette shape the provider takes, as far as this rule reads it. */
type PaletteLike = { readonly colors?: readonly unknown[] | null } | null | undefined;

/**
 * The marker attribute for a provider mounted with `colorPalette`: present
 * (value "foreground") when the palette carries no colour, so every KPI value
 * under it is drizzle-cube's fallback; absent otherwise.
 */
export function kpiValueFallbackAttributes(
  colorPalette: PaletteLike,
): Record<typeof KPI_VALUE_FALLBACK_ATTRIBUTE, "foreground"> | Record<string, never> {
  const hasColours = Array.isArray(colorPalette?.colors) && colorPalette.colors.length > 0;
  return hasColours ? {} : { [KPI_VALUE_FALLBACK_ATTRIBUTE]: "foreground" };
}
