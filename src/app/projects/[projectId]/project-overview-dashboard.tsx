"use client";
/**
 * ProjectOverviewDashboard — the render for the non-removable "Overview"
 * dashboard on the project detail Dashboards tab (cinatra#706 / #702).
 *
 * The Overview is render-only: its content is the project's CURRENT summary,
 * composed fresh server-side (`buildProjectOverviewConfig`) into render-only
 * portlets and handed straight to `<PortletHost>` — never persisted, so it can
 * never serve a stale or authorization-obsolete summary.
 *
 * It carries its own lightweight toolbar because the shared
 * `CinatraDashboardToolbar` (which paints the dashboard-select + "New dashboard"
 * controls) mounts DEEP inside the drizzle-cube grid and reads drizzle-cube's
 * `useDashboardContext()`, so it cannot render on this grid-less path. Instead
 * we render `EntityDashboardsToolbarControls` — which needs ONLY the shell's
 * `EntityDashboardsContext` — inside a plain `<Toolbar>`, giving the same select
 * + New affordances (no Edit/Save: the Overview is ephemeral, non-editable).
 *
 * This module deliberately imports NO drizzle-cube surface (kept separate from
 * `project-dashboards-tab.tsx`, which pulls the grid) so it renders standalone.
 */
import { EntityDashboardsToolbarControls } from "@cinatra-ai/dashboards/entity-dashboard-toolbar-controls";

import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";
import { Toolbar } from "@/components/ui/toolbar";

export function ProjectOverviewDashboard({
  portlets,
}: {
  readonly portlets: readonly PortletInstanceProp[];
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="project-overview-dashboard">
      <Toolbar
        aria-label="Dashboard"
        data-cinatra-dashboard-toolbar="true"
        className="sticky top-0 z-10 mb-4"
      >
        <EntityDashboardsToolbarControls />
      </Toolbar>
      <PortletHost portlets={portlets} rowContext={{}} />
    </div>
  );
}
