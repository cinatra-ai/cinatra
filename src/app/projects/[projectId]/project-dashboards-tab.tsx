"use client";
/**
 * ProjectDashboardsTab — the "Dashboards" tab body for `/projects/[projectId]`
 * (cinatra#706). Wires the reusable entity Dashboards shell (#701) to this
 * project's server actions (bound to the project entity ref on the SERVER, so
 * the ref crosses Next-encrypted and the client never authors the owner axis)
 * and overrides the shell's render seam (#702) so:
 *
 *   - the non-removable "Overview" default renders the project's CURRENT summary
 *     as RENDER-ONLY portlets — built fresh per request server-side via
 *     `buildProjectOverviewConfig`, handed straight to `<PortletHost>`; and
 *   - every user-created dashboard renders through the standard EDITABLE
 *     drizzle-cube grid (the shell's default renderer, reproduced here because
 *     overriding the seam replaces it for every dashboard).
 *
 * Why the Overview carries its own toolbar: the shared `CinatraDashboardToolbar`
 * that paints the dashboard-select + "New dashboard" controls mounts DEEP inside
 * the drizzle-cube grid and reads drizzle-cube's `useDashboardContext()`, so it
 * cannot render on the Overview (which renders through `<PortletHost>`, not the
 * grid). The Overview branch therefore renders `EntityDashboardsToolbarControls`
 * — which needs ONLY the shell's `EntityDashboardsContext` — inside a plain
 * `<Toolbar>`, giving the same select + New affordances on the render-only
 * Overview (no Edit/Save: the Overview is ephemeral and non-editable).
 */
import {
  EntityDashboardsShell,
  type EntityDashboardRenderArgs,
  type EntityDashboardsShellProps,
} from "@cinatra-ai/dashboards/entity-dashboards-shell";
import type { EntityDashboardsDataSource } from "@cinatra-ai/dashboards/entity-dashboards-contract";

import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";
import { EmbeddedDrizzleCubeDashboardGrid } from "@/components/dashboards/embedded-drizzle-cube-dashboard-grid";

import { ProjectOverviewDashboard } from "./project-overview-dashboard";

export type ProjectDashboardsTabProps = {
  /** The project's Dashboards server actions, each bound to the project ref. */
  readonly dataSource: EntityDashboardsDataSource;
  /** SSR seed (list + selected Overview id) so the tab paints without a flash. */
  readonly initialData?: EntityDashboardsShellProps["initialData"];
  /** The FRESH Overview portlets, composed server-side from live project info. */
  readonly overviewPortlets: readonly PortletInstanceProp[];
};

export function ProjectDashboardsTab({
  dataSource,
  initialData,
  overviewPortlets,
}: ProjectDashboardsTabProps) {
  const renderDashboard = (args: EntityDashboardRenderArgs) => {
    if (args.summary.isDefault) {
      // Overview: ignore the persisted (empty) anchor config — the live summary
      // rides `overviewPortlets`, rebuilt fresh on every request.
      return <ProjectOverviewDashboard portlets={overviewPortlets} />;
    }
    // A user-created dashboard: the standard editable analytics grid, which
    // brings its own CinatraDashboardToolbar (select + New + Edit) inside the
    // shell's context.
    return (
      <EmbeddedDrizzleCubeDashboardGrid
        dashboard={args.config}
        editable={args.editable}
        onSave={args.editable ? args.onSave : undefined}
        pageAnchor={args.pageAnchor}
        dashboardModes={args.dashboardModes}
      />
    );
  };

  return (
    <EntityDashboardsShell
      dataSource={dataSource}
      pageAnchor="project-detail"
      initialData={initialData}
      renderDashboard={renderDashboard}
    />
  );
}
