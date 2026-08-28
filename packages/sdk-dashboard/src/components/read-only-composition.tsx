"use client";
// THE PROMOTED READ-ONLY COMPOSITIONS (enabler 0.11 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER: "a host composition an extension display needs is promoted into
// an SDK surface an extension may depend on and admitted at the extension
// boundary, and BOTH THE HOST PAGE AND THE EXTENSION CONSUME THE SAME
// COMPOSITION — the read-only dashboard and single-portlet views are the first."
//
// THIS FILE IS THAT SDK SURFACE. It lives in `@cinatra-ai/sdk-dashboard`, a
// package an extension may already depend on (it is a declared peer of
// `@cinatra-ai/sdk-extensions`), and it is registered in the boundary's
// admission list at `@cinatra-ai/sdk-extensions/read-only-compositions`.
// `@cinatra-ai/dashboards`, the host package, imports these same two components
// for its own read-only surfaces — so there is ONE implementation and the host
// page and an extension display cannot drift apart.
//
// READ-ONLY IS STRUCTURAL, NOT A PROP. What makes these compositions read-only
// is what they DO NOT MOUNT: no toolbar (which owns Edit and Save), no modals
// (which own add/edit/delete of a portlet), no filter bar (an edit-session
// surface). Only the provider and the grid surface. A future edit affordance
// therefore cannot arrive by a default flipping — it would have to be imported
// into this file, which is exactly the review this enabler wants.
//
// NO DATA ROAD OF ITS OWN. These compositions draw a configuration they are
// given. Inside the island, a display's live data arrives through the sealed
// data capability of enabler 0.12; nothing here fetches, and nothing here holds
// a credential.

import type { ComponentProps } from "react";
import { DashboardGridSurface, DashboardProvider } from "drizzle-cube/client";

/** The props the read-only dashboard takes — the provider's, minus every
 *  editing-shaped one the composition deliberately does not mount. */
export type ReadOnlyComposedDashboardProps = Omit<
  ComponentProps<typeof DashboardProvider>,
  "children" | "dashboardModes" | "hideToolbar" | "editable"
>;

/**
 * A dashboard's portlet grid, drawn from a configuration, read-only.
 *
 * `editable={false}` is belt to the braces of mounting no editing UI: the
 * provider's own state machine is told the surface is not editable, so a portlet
 * that consults it renders its read-only reading too.
 */
export function ReadOnlyComposedDashboard(props: ReadOnlyComposedDashboardProps) {
  return (
    <DashboardProvider
      {...(props as ComponentProps<typeof DashboardProvider>)}
      editable={false}
    >
      <div data-cinatra-read-only-composition="dashboard">
        <DashboardGridSurface />
      </div>
    </DashboardProvider>
  );
}

export type ReadOnlySinglePortletProps = ReadOnlyComposedDashboardProps & {
  /** The id of the ONE portlet to draw out of the supplied configuration. */
  portletId: string;
};

/**
 * ONE portlet of a dashboard configuration, drawn alone and read-only.
 *
 * The narrowing happens on the CONFIGURATION, before the provider ever sees it:
 * the composition hands the grid a configuration containing exactly the named
 * portlet, so nothing downstream can render a sibling portlet the caller did not
 * ask for. A `portletId` that names nothing draws an empty grid rather than the
 * whole dashboard — the fail-closed direction.
 */
export function ReadOnlySinglePortlet({ portletId, ...rest }: ReadOnlySinglePortletProps) {
  const props = rest as ComponentProps<typeof DashboardProvider> & {
    config?: { portlets?: Array<{ id?: string }> } | null;
  };
  const config = props.config ?? null;
  const portlets = Array.isArray(config?.portlets) ? config.portlets : [];
  const narrowed = {
    ...(config ?? {}),
    portlets: portlets.filter((p) => p?.id === portletId),
  };
  return (
    <DashboardProvider
      {...(props as ComponentProps<typeof DashboardProvider>)}
      config={narrowed as never}
      editable={false}
    >
      <div data-cinatra-read-only-composition="single-portlet">
        <DashboardGridSurface />
      </div>
    </DashboardProvider>
  );
}
