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
// given, over a data road they are given or the one their caller already
// mounts. Inside the island, a display's live data arrives through the sealed
// data capability of enabler 0.12; nothing here chooses an address, and nothing
// here holds a credential.
//
// A DATA ROAD, WHEN ONE IS GIVEN (cinatra#3092). The plan: "The series are live,
// fetched under a short-lived data capability sealed to the actor". A display in
// the dashboard extension does not sit inside the application's dashboards
// shell, which is what mounts the query client and the cube provider the grid
// reads through. So, given a data road, each promoted view mounts its OWN query
// client and a cube provider over that road's address — the shell's own
// settings, the reader's session riding along — around exactly what it mounts
// without one. Without a road it renders exactly what it renders today. The road
// is an ADDRESS: it carries no credential, and it adds no toolbar, filter,
// modal, drag or save.

import { useState, type ComponentProps, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CubeProvider, DashboardGridSurface, DashboardProvider } from "drizzle-cube/client";

import {
  narrowToSinglePortlet,
  type NarrowableDashboardConfig,
} from "./narrow-to-single-portlet";

/**
 * The data road a display hands the composition: the address its series are
 * fetched from. `session` is the application's own cube route, reached with the
 * reader's session. (The island's sealed road is a later leg.)
 */
export type ReadOnlyCompositionDataRoad = {
  readonly road: "session";
  readonly apiUrl: string;
};

/** The props the read-only dashboard takes — the provider's, minus every
 *  editing-shaped one the composition deliberately does not mount, plus the
 *  optional data road. */
export type ReadOnlyComposedDashboardProps = Omit<
  ComponentProps<typeof DashboardProvider>,
  "children" | "dashboardModes" | "hideToolbar" | "editable"
> & {
  /** Given, the view mounts its own query client and cube provider over it;
   *  absent, it draws inside the providers its caller already mounts. */
  dataRoad?: ReadOnlyCompositionDataRoad;
};

/**
 * THE PROVIDERS A DATA ROAD BRINGS — mounted only when a road is given, so the
 * host's own read-only surface, inside the shell that already mounts both, is
 * unchanged: without a road this renders its children and nothing else.
 */
function DataRoadProviders({
  dataRoad,
  children,
}: {
  dataRoad: ReadOnlyCompositionDataRoad | undefined;
  children: ReactNode;
}) {
  if (!dataRoad) return <>{children}</>;
  return <MountedDataRoad dataRoad={dataRoad}>{children}</MountedDataRoad>;
}

/** The query client and the cube provider over the road's address — the
 *  dashboards shell's own settings. */
function MountedDataRoad({
  dataRoad,
  children,
}: {
  dataRoad: ReadOnlyCompositionDataRoad;
  children: ReactNode;
}) {
  // One query client per mount, created once — the shell's own lifetime rule.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <CubeProvider
        apiOptions={{ apiUrl: dataRoad.apiUrl, credentials: "include" }}
        features={{ enableAI: false }}
        enableBatching={false}
      >
        {children}
      </CubeProvider>
    </QueryClientProvider>
  );
}

/**
 * A dashboard's portlet grid, drawn from a configuration, read-only.
 *
 * `editable={false}` is belt to the braces of mounting no editing UI: the
 * provider's own state machine is told the surface is not editable, so a portlet
 * that consults it renders its read-only reading too.
 */
export function ReadOnlyComposedDashboard({ dataRoad, ...props }: ReadOnlyComposedDashboardProps) {
  return (
    <DataRoadProviders dataRoad={dataRoad}>
      <DashboardProvider
        {...(props as ComponentProps<typeof DashboardProvider>)}
        editable={false}
      >
        <div data-cinatra-read-only-composition="dashboard">
          <DashboardGridSurface />
        </div>
      </DashboardProvider>
    </DataRoadProviders>
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
 * whole dashboard — the fail-closed direction, and a configuration carrying the
 * id TWICE still draws ONE portlet: "exactly the named portlet" is a count as
 * much as it is a name, and a filter would have handed the grid both copies.
 */
export function ReadOnlySinglePortlet({ portletId, dataRoad, ...rest }: ReadOnlySinglePortletProps) {
  const props = rest as ComponentProps<typeof DashboardProvider> & {
    config?: NarrowableDashboardConfig | null;
  };
  // THE NARROWING IS A PURE LEAF (`narrow-to-single-portlet.ts`) so the rule that
  // decides what the grid may see is provable without rendering drizzle-cube.
  const narrowed = narrowToSinglePortlet(props.config, portletId);
  return (
    <DataRoadProviders dataRoad={dataRoad}>
      <DashboardProvider
        {...(props as ComponentProps<typeof DashboardProvider>)}
        config={narrowed as never}
        editable={false}
      >
        <div data-cinatra-read-only-composition="single-portlet">
          <DashboardGridSurface />
        </div>
      </DashboardProvider>
    </DataRoadProviders>
  );
}
