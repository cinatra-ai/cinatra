"use client";
/**
 * OrganizationDashboards — the `/organizations/[id]` Dashboards surface,
 * tabless since cinatra#1734 (the #1693 ruling: the detail page keeps only
 * the dashboards; the access model + management live on
 * `/organizations/[id]/settings`).
 *
 * Hosts the reusable `<EntityDashboardsShell>` (#701) with this org's
 * server-bound data source; its non-removable **Overview** default renders
 * the org's identity + member/team counts as portlets (#702), and the
 * toolbar carries the dashboard-select + "+ New dashboard" controls.
 *
 * The Overview is render-only (`entity-*` portlets), which the embedded
 * drizzle-cube grid cannot paint, so `renderDashboard` swaps in
 * `<OrganizationOverviewDashboard>` for the default and keeps the analytics
 * grid for every other (user-created) org dashboard — the drop-in override
 * the shell exposes at its render seam, with no shell edit. Extracted
 * UNCHANGED from the retired `OrganizationDetailTabs` (#705).
 */
import { useMemo, type ReactNode } from "react";

import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";

import type { EntityDashboardsDataSource } from "../entity-dashboards-contract";
import { EmbeddedDrizzleCubeDashboardGrid } from "./embedded-drizzle-cube-dashboard-grid";
import {
  EntityDashboardsShell,
  type EntityDashboardRenderArgs,
} from "./entity-dashboards-shell";
import { OrganizationOverviewDashboard } from "./organization-overview-dashboard";

/** The surface anchor for the org detail Dashboards surface (no href page
 *  actions; its controls come from the entity-dashboards context — see
 *  `DASHBOARD_PAGE_ACTIONS["org-detail"]`). */
const ORG_DETAIL_ANCHOR = "org-detail" as const;

/** Build the Overview-aware render seam: the non-removable Overview renders the
 *  freshly-built summary portlets; every other dashboard renders as the
 *  editable analytics grid (the shell's default behavior). Exported so the seam
 *  is unit-testable independently of the shell state machine. */
export function makeRenderOrganizationDashboard(
  overviewPortlets: readonly PortletInstanceProp[],
): (args: EntityDashboardRenderArgs) => ReactNode {
  return function renderOrganizationDashboard(args: EntityDashboardRenderArgs) {
    if (args.summary.isDefault) {
      return (
        <OrganizationOverviewDashboard
          portlets={overviewPortlets}
          pageAnchor={ORG_DETAIL_ANCHOR}
        />
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
  };
}

export type OrganizationDashboardsProps = {
  /** Server-bound entity-dashboards data source (ensure+list, load, mutate). */
  readonly dataSource: EntityDashboardsDataSource;
  /** Freshly-built render-only Overview portlets (metadata + counts). */
  readonly overviewPortlets: readonly PortletInstanceProp[];
};

export function OrganizationDashboards({
  dataSource,
  overviewPortlets,
}: OrganizationDashboardsProps) {
  // Rebuild the Overview-aware seam whenever the surface hands down freshly-built
  // portlets (e.g. after a `router.refresh()`), so the ephemeral Overview never
  // sticks at its first-render counts (codex convergence, #705).
  const renderDashboard = useMemo(
    () => makeRenderOrganizationDashboard(overviewPortlets),
    [overviewPortlets],
  );

  return (
    <EntityDashboardsShell
      dataSource={dataSource}
      pageAnchor={ORG_DETAIL_ANCHOR}
      dashboardModes={["grid", "rows"]}
      renderDashboard={renderDashboard}
    />
  );
}
