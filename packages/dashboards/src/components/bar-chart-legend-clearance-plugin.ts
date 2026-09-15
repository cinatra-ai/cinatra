"use client";
/**
 * Registers `BarChartWithLegendClearance` over drizzle-cube's built-in `bar`
 * chart type (cinatra#2773).
 *
 * The cube's own extension point takes the whole chart definition — config,
 * label, icon and component — so an override that invented its own config
 * would silently replace the built-in bar chart's drop zones, display
 * options and validation everywhere in the app. It therefore resolves the
 * BUILT-IN config first (`getChartConfigAsync("bar")`, before anything is
 * registered, so the lookup still finds the built-in entry) and re-registers
 * exactly that config with only the component swapped.
 *
 * Both imports are dynamic on purpose: `drizzle-cube/client/charts` is the
 * eager chart barrel (every recharts chart component), and the wrapper
 * itself pulls the bar chart in — importing either statically here would
 * drag the whole chart bundle into the dashboards shell's own chunk instead
 * of the lazily-loaded chart chunk it belongs to.
 *
 * The picker's own metadata rides on that config: the resolved built-in
 * config carries the i18n `label`, `description` and `useCase` keys and the
 * `isAvailable` predicate, so the chart-type picker reads the same strings
 * after the override as before it, and the icon falls back to the built-in
 * `chartBar` when a definition declares none. The one entry field the cube
 * exposes no reader for is `dependencies` (the "install recharts" hint shown
 * when a chart module fails to import); it is left unset, which costs only
 * that hint on a load failure — recharts ships inside the vendored package,
 * and a failed import surfaces through the chart error boundary either way.
 *
 * Idempotent, and failure-neutral: if the config cannot be resolved, nothing
 * is registered and the built-in bar chart keeps rendering.
 */
let registrationStarted = false;

export function registerBarChartLegendClearance(): void {
  if (registrationStarted) return;
  registrationStarted = true;

  void (async () => {
    try {
      const [charts, client] = await Promise.all([
        import("drizzle-cube/client/charts"),
        import("drizzle-cube/client"),
      ]);
      const builtInConfig = await charts.getChartConfigAsync("bar");
      if (!builtInConfig) return;

      client.chartPluginRegistry.register({
        type: "bar",
        label: builtInConfig.label ?? "Bar Chart",
        config: builtInConfig,
        lazyComponent: () =>
          import("./bar-chart-legend-clearance").then((module) => ({
            default: module.BarChartWithLegendClearance,
          })),
      } as unknown as Parameters<typeof client.chartPluginRegistry.register>[0]);
    } catch {
      // The built-in bar chart stays registered — the clearance band is an
      // enhancement, never a hard dependency of the dashboard mounting.
    }
  })();
}

/** Test seam: allow a fresh registration in a new module graph. */
export function resetBarChartLegendClearanceRegistration(): void {
  registrationStarted = false;
}
