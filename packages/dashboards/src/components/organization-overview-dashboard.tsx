"use client";
/**
 * OrganizationOverviewDashboard — the render-only "Overview" content for the
 * `/organizations/[id]` Dashboards tab (cinatra#705).
 *
 * The Overview is the epic's non-removable default (epic #699 / #700): the org's
 * CURRENT summary info rendered AS PORTLETS (`entity-metadata` + `entity-count`,
 * cinatra#702) instead of an analytics keystone. Those portlets are render-only,
 * so this mounts them through the app-dir `<PortletHost>` rather than the
 * embedded drizzle-cube grid the other (analytics) dashboards use. The portlets
 * are built FRESH server-side per request (`buildOrganizationOverviewConfig`
 * over securely-fetched counts) and handed in as a prop, so the values are live
 * and never read from the persisted row.
 *
 * The dashboard-select dropdown + "+ New dashboard" control (epic AC) live
 * INSIDE `<CinatraDashboardToolbar>`, which reads its edit-mode machine from a
 * drizzle-cube `<DashboardProvider>` and its list/selection from the shell's
 * `EntityDashboardsContext`. The Overview is not editable, so this mounts an
 * empty, non-editable provider purely to host the toolbar chrome — the same
 * composition the reusable shell proves in its toolbar test (#701). The empty
 * config carries no analytics query, so no drizzle-cube data ever loads here.
 */
import { DashboardProvider } from "drizzle-cube/client";

import {
  PortletHost,
  type PortletInstanceProp,
} from "@/components/dashboards/portlet-host";

import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import { CinatraDashboardToolbar } from "./cinatra-dashboard-toolbar";
import {
  DashboardPageAnchorProvider,
  type DashboardPageAnchor,
} from "./dashboard-page-anchor";

/** An empty drizzle-cube config: it hosts the toolbar's edit-mode machine but
 *  paints no grid (no portlets), so the Overview never mounts an analytics
 *  query. The Overview's real content is the `entity-*` portlets rendered by
 *  `<PortletHost>` below. */
const EMPTY_OVERVIEW_DC = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as unknown as DashboardConfigV1_1;

export type OrganizationOverviewDashboardProps = {
  /** Freshly-built render-only summary portlets (metadata + counts). */
  readonly portlets: readonly PortletInstanceProp[];
  /** Surface anchor so the toolbar keys its (empty) route actions correctly. */
  readonly pageAnchor: DashboardPageAnchor;
};

export function OrganizationOverviewDashboard({
  portlets,
  pageAnchor,
}: OrganizationOverviewDashboardProps) {
  return (
    <DashboardPageAnchorProvider pageAnchor={pageAnchor}>
      <DashboardProvider
        config={EMPTY_OVERVIEW_DC as never}
        editable={false}
        dashboardModes={["grid"]}
      >
        <CinatraDashboardToolbar />
        <PortletHost portlets={portlets} rowContext={{}} />
      </DashboardProvider>
    </DashboardPageAnchorProvider>
  );
}
