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
//
// THE NO-SERIES ROAD (cinatra#3092). A reading that holds no series still draws
// the dashboard's chrome, titles and layout, with no numbers. Road `none` mounts
// the same providers over a query client on which no query reaches the cube
// client: every query is born settled with an EMPTY answer, so the grid lays the
// portlets out by the configuration's own `grid`, `layoutMode` and `rows`, each
// portlet settles to its empty state, and nothing is fetched and no address is
// read.
//
// ONLY THE TWO NAMED ROADS. The road is read by equality against `"none"` and
// `"session"` and nothing else. Any other value — a missing or malformed road, a
// case-varied or future name, a session road without an address, a non-object —
// draws a settled refusal and mounts no provider: it never falls through to the
// session road, which sends the reader's credentials.

import { useState, type ComponentProps, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  type DefaultError,
  type DefaultedQueryObserverOptions,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import { CubeProvider, DashboardGridSurface, DashboardProvider } from "drizzle-cube/client";

import {
  narrowToSinglePortlet,
  type NarrowableDashboardConfig,
} from "./narrow-to-single-portlet";

/**
 * The data road a display hands the composition. `session` is the address its
 * series are fetched from: the application's own cube route, reached with the
 * reader's session. `none` is a reading with no series: the dashboard's chrome,
 * titles and layout are drawn, and nothing is fetched. (The island's sealed road
 * is a later leg.)
 */
export type ReadOnlyCompositionDataRoad =
  | { readonly road: "session"; readonly apiUrl: string }
  | { readonly road: "none" };

/** The props the read-only dashboard takes — the provider's, minus every
 *  editing-shaped one the composition deliberately does not mount, plus the
 *  optional data road. */
export type ReadOnlyComposedDashboardProps = Omit<
  ComponentProps<typeof DashboardProvider>,
  "children" | "dashboardModes" | "hideToolbar" | "editable"
> & {
  /** Given, the view mounts its own query client and cube provider over it
   *  (road `none`: over no address, with no query run); absent, it draws inside
   *  the providers its caller already mounts. */
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
  if (dataRoad === undefined) return <>{children}</>;
  const road = readDataRoad(dataRoad);
  if (road.road === "none") return <MountedNoSeriesRoad>{children}</MountedNoSeriesRoad>;
  if (road.road === "session") return <MountedDataRoad apiUrl={road.apiUrl}>{children}</MountedDataRoad>;
  return <RefusedDataRoad />;
}

type ReadDataRoad =
  | { readonly road: "none" }
  | { readonly road: "session"; /** the resolved href */ readonly apiUrl: string }
  | { readonly road: "refused" };

const REFUSED: ReadDataRoad = { road: "refused" };

/** An own DATA property of a plain object, read once; an accessor, an inherited
 *  property or a read that throws reads as absent. */
function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** A value that may hold no backslash, whitespace or control character. */
const UNSAFE_CHARACTER = /[\\\s\u0000-\u001f\u007f]/;
/** A root-relative path ("/x", never "//x") or an absolute URL with a scheme. */
const ADDRESS_SHAPE = /^(?:\/(?!\/)|[a-z][a-z0-9+.-]*:)/i;

/**
 * THE ADDRESS THE READER'S SESSION GOES TO, RESOLVED ONCE. The session road
 * sends the reader's credentials (`credentials: "include"`), so its address
 * must be the page's own origin. The value is resolved exactly once, against
 * `window.location.origin` (never `document.baseURI`, so a `<base>` element
 * cannot move it), and the RESOLVED href is the one handed on: the provider
 * never receives a path a browser would resolve again. Admitted is a value of
 * the address shape whose resolved origin EQUALS the page's origin, with no
 * user name and no password. Refused (`undefined`) is everything else: no
 * window, a missing, empty or opaque ("null") page origin, a value that does
 * not parse, a backslash, whitespace or control character, "//host", a bare
 * relative path, another origin, port or scheme, "javascript:", and any user
 * name or password (an empty user name with a password included).
 */
function sameOriginHref(apiUrl: string): string | undefined {
  if (UNSAFE_CHARACTER.test(apiUrl) || !ADDRESS_SHAPE.test(apiUrl)) return undefined;
  try {
    const pageOrigin = typeof window === "undefined" ? undefined : window.location?.origin;
    if (typeof pageOrigin !== "string" || pageOrigin.length === 0 || pageOrigin === "null") return undefined;
    const url = new URL(apiUrl, pageOrigin);
    if (url.origin !== pageOrigin || url.username !== "" || url.password !== "") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * THE ROAD, READ FAIL-CLOSED. A road is admitted only when it is a non-array
 * object whose own `road` equals `"none"`, or equals `"session"` with an own
 * string `apiUrl` that resolves to the page's own origin (`sameOriginHref`);
 * the session road then carries that resolved href, never the value as given.
 * Everything else is refused — the composition does not guess which road a
 * value it cannot read meant, and never sends the reader's session to another
 * origin.
 */
function readDataRoad(dataRoad: unknown): ReadDataRoad {
  if (typeof dataRoad !== "object" || dataRoad === null || Array.isArray(dataRoad)) return REFUSED;
  const road = ownValue(dataRoad, "road");
  if (road === "none") return { road: "none" };
  if (road === "session") {
    const apiUrl = ownValue(dataRoad, "apiUrl");
    const href = typeof apiUrl === "string" ? sameOriginHref(apiUrl) : undefined;
    if (href !== undefined) return { road: "session", apiUrl: href };
  }
  return REFUSED;
}

/** The settled refusal: no provider, no grid, no request — a visible notice. */
function RefusedDataRoad() {
  return (
    <div role="alert" data-cinatra-read-only-composition-refused="data-road">
      This view cannot be drawn: its data road is not one this composition knows.
    </div>
  );
}

/** The shell's own query settings, shared by both roads. */
const ROAD_QUERY_DEFAULTS = {
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
};

/** An empty reading in drizzle-cube 0.6.6's own result-set shape
 *  (`CubeResultSet`, src/client/types.ts:523-530; the client's `ResultSet`,
 *  src/client/client/CubeClient.ts:249-295): no rows, no annotation. */
function emptyResultSet() {
  return {
    loadResponse: { data: [], annotation: {} },
    rawData: () => [],
    tablePivot: () => [],
    series: () => [],
    annotation: () => ({}),
    cacheInfo: () => undefined,
  };
}

/**
 * THE SETTLED, EMPTY ANSWER FOR A QUERY OF THE GRID, by the query family
 * drizzle-cube 0.6.6 names in the key's second place — each in the shape that
 * family's own query function returns when the server answers with no rows:
 *   `load`       → a result set (hooks/queries/useCubeLoadQuery.ts:32-36, 198-224)
 *   `multiLoad`  → the merged reading (hooks/queries/useMultiCubeLoadQuery.ts:26-31, 203-209)
 *   `funnel`, `flow`, `retention` → `{ rawData, executionTime, cacheInfo }`
 *                  (useFunnelQuery.ts:207-211, 262-266; useFlowQuery.ts:187-190,
 *                  243-251; useRetentionQuery.ts:256-259, 304-308)
 *   `meta`       → `{ meta, labelMap }` (hooks/queries/useCubeMetaQuery.ts:19, 93-98)
 * A portlet with a result set and no error is done (components/analyticsPortlet/
 * portletRenderState.ts:74, 78), and its chart draws its own "No data available".
 * A key this road does not know has no answer: its query stays off and, if it is
 * ever fetched, settles with an error.
 */
function emptyAnswerFor(queryKey: readonly unknown[] | undefined): unknown {
  if (!Array.isArray(queryKey) || queryKey[0] !== "cube") return undefined;
  const family = queryKey[1];
  if (family === "load") return emptyResultSet();
  if (family === "multiLoad") {
    return { data: [], resultSets: [], perQueryData: [], errors: [], firstError: null };
  }
  if (family === "funnel" || family === "flow" || family === "retention") {
    return { rawData: [], executionTime: 0, cacheInfo: undefined };
  }
  if (family === "meta") return { meta: { cubes: [] }, labelMap: {} };
  return undefined;
}

/** The answer to a query this road does not know: settled, never a request. */
function refuseUnknownQuery(): Promise<never> {
  return Promise.reject(new Error("The no-series road answers no such query."));
}

/**
 * THE NO-SERIES ROAD'S QUERY CLIENT. drizzle-cube 0.6.6 builds its cube client
 * from `apiOptions` inside its provider and does not read a `cubeApi` it is
 * given (providers/CubeApiProvider.tsx:69-73), so the one seam that every query
 * of the grid passes through is the query client the provider is given
 * (`queryClient`): each portlet's series, the cube metadata and a portlet's
 * refresh, including the `fetchQuery` a cache-busting refresh calls. On this
 * client every query is off, is born holding its family's empty answer
 * (`initialData`), and its function answers that same empty answer at once — so
 * no query reaches the cube client, the road fetches nothing, and every portlet
 * settles to its empty state instead of loading forever.
 */
class NoSeriesQueryClient extends QueryClient {
  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    const defaulted = super.defaultQueryOptions(options);
    const answer = emptyAnswerFor(defaulted.queryKey);
    return {
      ...defaulted,
      enabled: false,
      retry: false,
      initialData: answer as TQueryData | undefined,
      queryFn: answer === undefined ? refuseUnknownQuery : () => Promise.resolve(answer as TQueryFnData),
    };
  }
}

/** The no-series road: the session road's providers over a query client on
 *  which no query runs, and no address. */
function MountedNoSeriesRoad({ children }: { children: ReactNode }) {
  // One query client per mount, created once — the shell's own lifetime rule.
  const [queryClient] = useState(() => new NoSeriesQueryClient(ROAD_QUERY_DEFAULTS));
  return (
    <QueryClientProvider client={queryClient}>
      <CubeProvider
        queryClient={queryClient}
        apiOptions={{ credentials: "omit" }}
        features={{ enableAI: false }}
        enableBatching={false}
      >
        {children}
      </CubeProvider>
    </QueryClientProvider>
  );
}

/** The query client and the cube provider over the road's address — the
 *  dashboards shell's own settings. */
function MountedDataRoad({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  // One query client per mount, created once — the shell's own lifetime rule.
  const [queryClient] = useState(() => new QueryClient(ROAD_QUERY_DEFAULTS));
  return (
    <QueryClientProvider client={queryClient}>
      <CubeProvider
        apiOptions={{ apiUrl, credentials: "include" }}
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
