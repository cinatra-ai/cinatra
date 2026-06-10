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
 * Toolbar/filter bar render only for non-empty dashboards — same gating as
 * upstream's back-compat assembly (the empty state carries its own
 * "Add text" / "Add portlet" affordances).
 */
import type { ComponentProps } from "react";
import {
  DashboardFilterBar,
  DashboardGridSurface,
  DashboardModals,
  DashboardProvider,
  useCubeFeatures,
} from "drizzle-cube/client";

import { CinatraDashboardToolbar } from "./cinatra-dashboard-toolbar";
import { DcModalA11yScope } from "./dc-modal-a11y-scope";

export type ComposedDashboardProps = Omit<
  ComponentProps<typeof DashboardProvider>,
  "children" | "dashboardModes" | "hideToolbar"
>;

export function ComposedDashboard(props: ComposedDashboardProps) {
  const { dashboardModes } = useCubeFeatures();
  const isEmpty = !props.config.portlets || props.config.portlets.length === 0;

  return (
    <DashboardProvider {...props} dashboardModes={dashboardModes}>
      <DcModalA11yScope>
        {!isEmpty && <CinatraDashboardToolbar />}
        {!isEmpty && <DashboardFilterBar />}
        <DashboardGridSurface />
        <DashboardModals />
      </DcModalA11yScope>
    </DashboardProvider>
  );
}
