"use client";
/**
 * TeamDetailTabs — the `/teams/[teamId]` tabbed surface (cinatra#704, epic #699).
 *
 * A two-tab shell rendered UNDER the page header:
 *   - "Dashboards" — the reusable entity Dashboards surface (#701's
 *     `<EntityDashboardsShell>`) bound to this team's per-user dashboard set. The
 *     non-removable "Overview" default (#700) renders the team's summary info AS
 *     RENDER-ONLY PORTLETS (#702's `entity-metadata` / `entity-count`, built
 *     fresh server-side via `buildTeamOverviewConfig` and handed straight to
 *     `<PortletHost>`) — never through the drizzle-cube grid, so no DC client is
 *     mounted for the Overview and the summary is always live (a saved row can
 *     never serve a stale/authorization-obsolete summary). Any OTHER (custom)
 *     dashboard the user creates renders through the standard embedded grid.
 *   - "Permissions" — the team access configuration (membership + per-team
 *     roles), passed in as a server-rendered slot so this client shell does not
 *     couple to the app-route members surface. There is NO "customer invite"
 *     here — customers are a project-only external-grant concept.
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
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

import {
  EntityDashboardsShell,
  type EntityDashboardRenderArgs,
  type EntityDashboardsShellProps,
} from "./entity-dashboards-shell";
import { EntityDashboardsToolbarControls } from "./entity-dashboard-toolbar-controls";
import { EmbeddedDrizzleCubeDashboardGrid } from "./embedded-drizzle-cube-dashboard-grid";

const TEAM_DETAIL_ANCHOR = "team-detail" as const;

export type TeamDetailTabsProps = {
  /** The ref-bound entity-dashboard server actions for THIS team + user. */
  readonly dataSource: EntityDashboardsShellProps["dataSource"];
  /** The team's Overview summary as render-only portlets (#702), pre-composed
   *  server-side. Rendered for the non-removable Overview default. */
  readonly overviewPortlets: readonly PortletInstanceProp[];
  /** SSR seed so the first paint skips the client round-trip (#701). */
  readonly initialData?: EntityDashboardsShellProps["initialData"];
  /** Server-rendered Permissions-tab content (the team members/access surface). */
  readonly permissionsSlot: ReactNode;
};

export function TeamDetailTabs({
  dataSource,
  overviewPortlets,
  initialData,
  permissionsSlot,
}: TeamDetailTabsProps) {
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
    <Tabs defaultValue="dashboards" className="gap-6">
      <TabsListRow>
        <TabsTrigger value="dashboards">Dashboards</TabsTrigger>
        <TabsTrigger value="permissions">Permissions</TabsTrigger>
      </TabsListRow>

      <TabsContent value="dashboards" className="flex flex-col gap-4">
        <EntityDashboardsShell
          dataSource={dataSource}
          pageAnchor={TEAM_DETAIL_ANCHOR}
          initialData={initialData}
          renderDashboard={renderDashboard}
        />
      </TabsContent>

      <TabsContent value="permissions" className="flex flex-col gap-4">
        {permissionsSlot}
      </TabsContent>
    </Tabs>
  );
}
