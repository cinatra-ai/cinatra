"use client";
/**
 * Route identity for dashboard surfaces that carry primary toolbar actions.
 *
 * `DashboardsClientShell` provides the anchor; `CinatraDashboardToolbar`
 * consumes it to decide which (if any) route-scoped action links to render
 * at the left of the dashboard toolbar. Lives in its own module so the
 * toolbar does not have to import the shell (which pulls the dashboard CSS
 * bundles along).
 */
import { createContext, useContext, type ReactNode } from "react";

/**
 * Surfaces that show primary actions inside the dashboard toolbar. Each new
 * surface that wants toolbar actions adds its slug here and a matching
 * entry in `DASHBOARD_PAGE_ACTIONS` (`cinatra-dashboard-toolbar.tsx`) —
 * single registry, no parallel per-surface wiring.
 */
export type DashboardPageAnchor = "agents" | "projects" | "teams";

const DashboardPageAnchorContext = createContext<DashboardPageAnchor | undefined>(
  undefined,
);

export function DashboardPageAnchorProvider({
  pageAnchor,
  children,
}: {
  readonly pageAnchor?: DashboardPageAnchor;
  readonly children: ReactNode;
}) {
  return (
    <DashboardPageAnchorContext.Provider value={pageAnchor}>
      {children}
    </DashboardPageAnchorContext.Provider>
  );
}

/** Read the surface anchor set by the nearest `DashboardsClientShell`. */
export function useDashboardPageAnchor(): DashboardPageAnchor | undefined {
  return useContext(DashboardPageAnchorContext);
}
