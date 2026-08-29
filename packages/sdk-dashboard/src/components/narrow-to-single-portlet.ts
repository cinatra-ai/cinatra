// THE SINGLE-PORTLET NARROWING (enabler 0.11 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3027 / epic #3023), as a PURE leaf.
//
// It lives beside the composition rather than inside it because the composition
// mounts drizzle-cube's client tree, which no node unit tier renders — and the
// narrowing is the whole security-shaped half of the single-portlet view: it
// decides what the grid is even allowed to see. A rule that decides that must be
// provable without a browser.

/** The narrowest shape this leaf needs — a configuration is otherwise opaque. */
export interface NarrowableDashboardConfig {
  portlets?: Array<{ id?: string } | null | undefined>;
}

/**
 * Narrow a dashboard configuration to the ONE portlet the caller named.
 *
 * "Exactly the named portlet" is a COUNT as much as it is a name: a
 * configuration that carries the id twice must still draw one portlet, so this
 * takes the first match rather than every match. A `portletId` that names
 * nothing yields an empty portlet list — an empty grid, never the whole
 * dashboard: the fail-closed direction.
 */
export function narrowToSinglePortlet<T extends NarrowableDashboardConfig>(
  config: T | null | undefined,
  portletId: string,
): T & { portlets: Array<{ id?: string }> } {
  const portlets = Array.isArray(config?.portlets) ? config.portlets : [];
  const first = portlets.find((p) => p != null && p.id === portletId);
  return {
    ...((config ?? {}) as T),
    portlets: first === undefined || first === null ? [] : [first],
  };
}
