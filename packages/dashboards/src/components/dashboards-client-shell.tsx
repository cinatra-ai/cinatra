"use client";
// drizzle-cube/client default palette + Cinatra --dc-* overrides. Both CSS
// modules live INSIDE this package because:
//   - drizzle-cube is only declared as a dep at packages/dashboards/package.json
//     (pnpm doesn't hoist it to root, so the Next.js root `src/app/layout.tsx`
//     cannot resolve "drizzle-cube/client/styles.css").
//   - Mounting the styles here scopes them to dashboard routes only — no
//     global CSS pollution on routes that never use a dashboard grid.
// Order matters: DC defaults first, override after, so shadcn-mapped vars win.
import "drizzle-cube/client/styles.css";
import "./dashboard-theme.css";

/**
 * DashboardsClientShell.
 *
 * Single client-side wrapper that all dashboards screens mount under. Hosts:
 *  - `<QueryClientProvider>` (TanStack React Query) — drizzle-cube/client's
 *    `useCubeLoadQuery` and friends require it.
 *  - `<CubeProvider>` (drizzle-cube/client) — points at our same-origin API
 *    surface; better-auth cookies ride along via `credentials: "include"`.
 *  - `<DashboardPageAnchorProvider>` — publishes the surface's `pageAnchor`
 *    so `<CinatraDashboardToolbar>` (mounted by the grid components inside
 *    `<ComposedDashboard>`) knows which route-scoped primary actions to
 *    render.
 *
 * The per-dashboard store and the modal a11y scope live INSIDE
 * `<ComposedDashboard>` now: drizzle-cube `0.5.7`'s `DashboardProvider`
 * creates its own per-instance Zustand store, so a shell-level
 * `DashboardStoreProvider` would be shadowed and never see modal state.
 *
 * Feature gates:
 *  - `features.enableAI = false` — suppresses drizzle-cube's AI surface
 *    (AnalysisBuilder buttons + useExplainAI). The static regression test
 *    (`no-ai-on-agents.test.ts`) defends against an accidental
 *    `<AgenticNotebook>` mount slipping into screens/components.
 *  - `enableBatching = false` — drizzle-cube's batch coordinator would call
 *    `POST /batch` for every single-query mount. The API serves /batch for
 *    useMultiCubeLoadQuery, but for the common single-query path we want N
 *    HTTP calls, not 1 batched call wrapping N items.
 *  - `dashboardModes` — defaults to `["grid"]` (single drag-drop grid layout,
 *    no Grid/Rows toggle); callers pass `["grid","rows"]` to surface it.
 *    `<ComposedDashboard>` forwards the value from `useCubeFeatures()` into
 *    the dashboard state machine.
 *
 * Never imports AgenticNotebook, ExplainAIPanel, useExplainAI, useAgentChat.
 */
import { useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { CubeProvider, chartPluginRegistry } from "drizzle-cube/client";

import { cinatraLinkedTableDefinition } from "./cinatra-linked-table";
import {
  DashboardPageAnchorProvider,
  type DashboardPageAnchor,
} from "./dashboard-page-anchor";

// Registration is module-side-effect so EVERY dashboard mount sees the
// `cinatraLinkedTable` chart type regardless of order. Idempotent: the
// registry no-ops re-registrations of the same `type`. Cast to the
// drizzle-cube `ChartDefinition` at the boundary so the cinatraLinkedTable
// module itself stays loose-typed (only the sdk-dashboard
// adapter directory imports drizzle-cube types).
chartPluginRegistry.register(
  cinatraLinkedTableDefinition as unknown as Parameters<
    typeof chartPluginRegistry.register
  >[0],
);

const DASHBOARDS_API_URL = "/api/dashboards/cubejs-api/v1";

export type { DashboardPageAnchor };

/** drizzle-cube layout modes. `["grid"]` (default) shows no Grid/Rows toggle
 *  (the toolbar only renders it when `allowedModes.length > 1`);
 *  `["grid","rows"]` surfaces the toggle so users can switch a dashboard to
 *  a row layout. */
export type DashboardMode = "grid" | "rows";

export type DashboardsClientShellProps = {
  readonly children: ReactNode;
  /**
   * Tags the surface so `<CinatraDashboardToolbar>` renders its route-scoped
   * primary actions (e.g. "Run agent" + "Create agent" on `/agents`). Omit
   * on surfaces that should not get toolbar actions.
   */
  readonly pageAnchor?: DashboardPageAnchor;
  /**
   * Layout modes offered in edit mode. Defaults to `["grid"]` (no toggle).
   * Editable index dashboards pass `["grid","rows"]` to surface the Grid/Rows
   * toggle; read-only detail dashboards keep the default. Enabling rows is
   * additive — it never rewrites a saved `layoutMode:"grid"` config.
   */
  readonly dashboardModes?: readonly DashboardMode[];
};

export function DashboardsClientShell({
  children,
  pageAnchor,
  dashboardModes = ["grid"],
}: DashboardsClientShellProps) {
  // QueryClient per mount — drizzle-cube uses TanStack Query keys internally.
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Avoid refetching the same dashboard mount on every focus change.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  }));

  // `data-cinatra-dashboard-shell` scopes `dashboard-theme.css` rules (and
  // the e2e suite's locators) to dashboard mounts; `data-cinatra-page-anchor`
  // keeps the SSR-fallback-hiding `:has()` rule surface-specific.
  return (
    <div
      data-cinatra-dashboard-shell="true"
      data-cinatra-page-anchor={pageAnchor}
    >
      <QueryClientProvider client={queryClient}>
        <CubeProvider
          apiOptions={{
            apiUrl: DASHBOARDS_API_URL,
            credentials: "include",
          }}
          features={{ enableAI: false }}
          dashboardModes={dashboardModes as ("grid" | "rows")[]}
          enableBatching={false}
        >
          <DashboardPageAnchorProvider pageAnchor={pageAnchor}>
            {children}
          </DashboardPageAnchorProvider>
        </CubeProvider>
      </QueryClientProvider>
    </div>
  );
}
