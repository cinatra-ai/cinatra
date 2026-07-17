"use client";
/**
 * TeamDetailDashboards — the `/teams/[teamId]` dashboards surface (cinatra#704,
 * epic #699; tab chrome dropped by cinatra#1688).
 *
 * Renders UNDER the page header: the reusable entity Dashboards surface (#701's
 * `<EntityDashboardsShell>`) bound to this team's per-user dashboard set. The
 * non-removable "Overview" default (#700) renders the team's summary info AS
 * RENDER-ONLY PORTLETS (#702's `entity-metadata` / `entity-count`, built fresh
 * server-side via `buildTeamOverviewConfig` and handed straight to
 * `<PortletHost>`) — never through the drizzle-cube grid, so no DC client is
 * mounted for the Overview and the summary is always live (a saved row can
 * never serve a stale/authorization-obsolete summary). Any OTHER (custom)
 * dashboard the user creates renders through the standard embedded grid.
 *
 * There is deliberately NO tablist here (cinatra#1688): the former "Permissions"
 * tab duplicated the members surface that `/teams/[teamId]/settings` already
 * hosts — the settings page is THE single team-management surface, so the
 * detail page carries only the dashboards and the shell needs no outer tab
 * chrome (same shape as the personal surface).
 *
 * Why the Overview toolbar is the light `<EntityDashboardsToolbarControls>` in a
 * plain `<Toolbar>` (not `<CinatraDashboardToolbar>`): the full toolbar reads
 * drizzle-cube's `useDashboardContext()`, which only exists inside a mounted DC
 * grid. The Overview is deliberately DC-free, so it paints only the primary
 * entity controls (dashboard-select + "+ New dashboard") — the Overview is
 * render-only and carries no Edit affordance. A custom dashboard's grid brings
 * the full `<CinatraDashboardToolbar>` (same select + New, plus Edit) itself.
 *
 * The `renderDashboard` seam this component supplies is exactly the #701 "#702
 * Overview seam" the shell documents — additive per-surface glue over the
 * LANDED shell/portlet packages, not a change to them.
 */
import { useCallback, type ReactNode } from "react";

import { Toolbar } from "@/components/ui/toolbar";
import { PortletHost, type PortletInstanceProp } from "@/components/dashboards/portlet-host";

import {
  EntityDashboardsShell,
  type EntityDashboardRenderArgs,
  type EntityDashboardsShellProps,
} from "./entity-dashboards-shell";
import { EntityDashboardsToolbarControls } from "./entity-dashboard-toolbar-controls";
import { EmbeddedDrizzleCubeDashboardGrid } from "./embedded-drizzle-cube-dashboard-grid";

const TEAM_DETAIL_ANCHOR = "team-detail" as const;

export type TeamDetailDashboardsProps = {
  /** The ref-bound entity-dashboard server actions for THIS team + user. */
  readonly dataSource: EntityDashboardsShellProps["dataSource"];
  /** The team's Overview summary as render-only portlets (#702), pre-composed
   *  server-side. Rendered for the non-removable Overview default. */
  readonly overviewPortlets: readonly PortletInstanceProp[];
  /** SSR seed so the first paint skips the client round-trip (#701). */
  readonly initialData?: EntityDashboardsShellProps["initialData"];
};

export function TeamDetailDashboards({
  dataSource,
  overviewPortlets,
  initialData,
}: TeamDetailDashboardsProps) {
  // Overview-aware renderer: the non-removable default renders the render-only
  // summary portlets (no DC grid); every other dashboard renders the standard
  // embedded grid. Captures `overviewPortlets`, so the summary the surface
  // fetched drives the Overview regardless of the (empty) persisted row config.
  const renderDashboard = useCallback(
    (args: EntityDashboardRenderArgs): ReactNode => {
      if (args.summary.isDefault) {
        return (
          <div className="flex flex-col">
            <Toolbar
              aria-label="Dashboard"
              data-cinatra-dashboard-toolbar="true"
              className="sticky top-0 z-10 mb-4"
            >
              <EntityDashboardsToolbarControls />
            </Toolbar>
            <PortletHost portlets={overviewPortlets} rowContext={{}} />
          </div>
        );
      }
      return (
        <EmbeddedDrizzleCubeDashboardGrid
          dashboard={args.config}
          editable={args.editable}
          onSave={args.editable ? args.onSave : undefined}
          pageAnchor={args.pageAnchor}
          dashboardModes={args.dashboardModes}
        />
      );
    },
    [overviewPortlets],
  );

  return (
    <EntityDashboardsShell
      dataSource={dataSource}
      pageAnchor={TEAM_DETAIL_ANCHOR}
      initialData={initialData}
      renderDashboard={renderDashboard}
    />
  );
}
