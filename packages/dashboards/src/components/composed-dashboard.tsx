"use client";
/**
 * ComposedDashboard — Cinatra's assembly of drizzle-cube `0.5.7`'s
 * composable dashboard pieces.
 *
 * Mirrors the upstream back-compat `<DashboardGrid>` wiring
 * (provider → toolbar → filter bar → grid surface → modals) but swaps the
 * bundled `<DashboardToolbar>` for `<CinatraDashboardToolbar>`, which owns
 * the labels ("Edit dashboard" / "Save dashboard") and the route-scoped
 * primary actions through `useDashboardContext()`.
 *
 * Two pieces of host wiring live here on purpose:
 *
 *   - `dashboardModes` is forwarded from `useCubeFeatures()` so the value
 *     the shell passes to `<CubeProvider dashboardModes={...}>` actually
 *     reaches the dashboard state machine. (Directly-mounted
 *     `<DashboardGrid>` never read it — only upstream's
 *     `<AnalyticsDashboard>` did — so the Grid/Rows toggle previously
 *     showed regardless of the shell's declared modes.)
 *
 *   - `<DcModalA11yScope>` mounts INSIDE the provider: `DashboardProvider`
 *     creates its own per-instance Zustand store, so the modal-state
 *     subscription must live under it to see the flags. It wraps all the
 *     pieces so the focus trap contains the inline-rendered modal DOM.
 *
 * Empty state (cinatra#1119): the assembly keeps the grey toolbar frame
 * mounted whether or not the dashboard has portlets, and swaps drizzle-cube's
 * own raw "No Portlets" placeholder (`<DashboardGridSurface>`'s zero-portlet
 * branch — an off-column, library-styled screen) for the app-consistent
 * `<DashboardEmptyState>`. Emptiness is read LIVE from
 * `useDashboardContext().config` — the SAME signal `<DashboardGridSurface>`
 * uses internally — so adding the first card flips the count and hands
 * rendering straight back to the real grid surface (and removing the last
 * card returns to the app empty state). The toolbar self-hides for a
 * read-only surface with no route actions, so read-only embedded analytics
 * grids are unaffected.
 */
import type { ComponentProps } from "react";
import {
  DashboardFilterBar,
  DashboardGridSurface,
  DashboardModals,
  DashboardProvider,
  useCubeFeatures,
  useDashboardContext,
} from "drizzle-cube/client";

import { CinatraDashboardToolbar } from "./cinatra-dashboard-toolbar";
import { DashboardEmptyState } from "./dashboard-empty-state";
import { useDashboardFilterBarVisible } from "./dashboard-filter-bar-visibility";
import { DcModalA11yScope } from "./dc-modal-a11y-scope";

/**
 * Host wrapper that renders drizzle-cube's `<DashboardFilterBar>` as a
 * CHILD TOOLBAR of `<CinatraDashboardToolbar>` (design spec §Nested
 * toolbar, cinatra#65): inset 20px from the toolbar above (`ml-5`); the
 * 6px stack gap comes from the toolbar tightening its own bottom margin
 * while the bar is visible (see cinatra-dashboard-toolbar.tsx). The
 * `data-cinatra-dashboard-filter-bar` attribute is the STABLE HOOK the
 * scoped restyle in dashboard-theme.css targets — the cube's internal
 * markup is all inline `style={{ … var(--dc-*) … }}`, so the restyle
 * happens by redefining those vars inside this scope, never by DOM
 * mutation. Mount INSIDE the provider (it reads `useDashboardContext()`).
 */
function DashboardFilterBarSlot() {
  const visible = useDashboardFilterBarVisible();
  if (!visible) return null;
  return (
    <div data-cinatra-dashboard-filter-bar="true" className="ml-5">
      <DashboardFilterBar />
    </div>
  );
}

export type ComposedDashboardProps = Omit<
  ComponentProps<typeof DashboardProvider>,
  "children" | "dashboardModes" | "hideToolbar"
>;

/**
 * Body of the composition, mounted INSIDE `<DashboardProvider>` so it can read
 * the live dashboard state. Emptiness is derived from the context `config`
 * (the store-published config), identical to the check `<DashboardGridSurface>`
 * makes before it would paint its own placeholder — so this stays in lockstep
 * with the grid as cards are added/removed within an edit session.
 */
function ComposedDashboardBody() {
  const { config } = useDashboardContext();
  const isEmpty = !config.portlets || config.portlets.length === 0;

  return (
    <>
      <CinatraDashboardToolbar />
      {!isEmpty && <DashboardFilterBarSlot />}
      {isEmpty ? <DashboardEmptyState /> : <DashboardGridSurface />}
      <DashboardModals />
    </>
  );
}

export function ComposedDashboard(props: ComposedDashboardProps) {
  const { dashboardModes } = useCubeFeatures();

  return (
    <DashboardProvider {...props} dashboardModes={dashboardModes}>
      <DcModalA11yScope>
        <ComposedDashboardBody />
      </DcModalA11yScope>
    </DashboardProvider>
  );
}
