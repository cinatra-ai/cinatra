"use client";
// drizzle-cube/client default palette + Cinatra --dc-* overrides. Both CSS
// modules live INSIDE this package because:
//   - drizzle-cube is only declared as a dep at packages/dashboards/package.json
//     (pnpm doesn't hoist it to root, so the Next.js root `src/app/layout.tsx`
//     cannot resolve "drizzle-cube/client/styles.css").
//   - Mounting the styles here scopes them to dashboard routes only — no
//     global CSS pollution on routes that never use a <DashboardGrid>.
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
 *
 * Never imports AgenticNotebook, ExplainAIPanel, useExplainAI, useAgentChat.
 */
import { useRef, useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  CubeProvider,
  DashboardStoreProvider,
  chartPluginRegistry,
} from "drizzle-cube/client";

import { DcModalA11yScope } from "./dc-modal-a11y-scope";
import { useDashboardToolbarPolish } from "./use-dashboard-toolbar-polish";
import { cinatraLinkedTableDefinition } from "./cinatra-linked-table";

// Registration is module-side-effect so EVERY dashboard mount sees the
// `cinatraLinkedTable` chart type regardless of order. Idempotent: the
// registry no-ops re-registrations of the same `type`. Cast to the
// drizzle-cube `ChartDefinition` at the boundary so the cinatraLinkedTable
// module itself stays loose-typed (ADR 0044 — only the sdk-dashboard
// adapter directory imports drizzle-cube types).
chartPluginRegistry.register(
  cinatraLinkedTableDefinition as unknown as Parameters<
    typeof chartPluginRegistry.register
  >[0],
);

const DASHBOARDS_API_URL = "/api/dashboards/cubejs-api/v1";

// The value of the `data-cinatra-page-anchor` attribute the
// polish hook reads to decide which (if any) route-scoped action buttons to
// inject at the left of the DC dashboard toolbar. Each new surface that
// wants primary toolbar actions adds its slug here and a matching ACTIONS
// entry in `use-dashboard-toolbar-polish.ts` — single registry, no parallel
// observer/selector patterns.
export type DashboardPageAnchor = "agents" | "projects" | "teams";

/** drizzle-cube layout modes. `["grid"]` (default) shows no Grid/Rows toggle
 *  (DC only renders it when `allowedModes.length > 1`); `["grid","rows"]`
 *  surfaces the toggle so users can switch a dashboard to a row layout. */
export type DashboardMode = "grid" | "rows";

export type DashboardsClientShellProps = {
  readonly children: ReactNode;
  /**
   * Tags the shell so the polish hook can inject route-scoped primary
   * action buttons into the DC toolbar (e.g. "Run agent" + "Create agent"
   * on `/agents`). Omit on surfaces that should not get injected buttons.
   */
  readonly pageAnchor?: DashboardPageAnchor;
  /**
   * Layout modes DC offers in edit mode. Defaults to `["grid"]` (no toggle).
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

  // `shellRef` scopes the toolbar-polish observer to this dashboard mount
  // (the wrapper `<div>` below). `data-cinatra-dashboard-shell` is also the
  // CSS scoping hook for `dashboard-theme.css` toolbar overrides.
  const shellRef = useRef<HTMLDivElement | null>(null);
  useDashboardToolbarPolish(shellRef);

  return (
    <div
      ref={shellRef}
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
          {/* DashboardStoreProvider is required by <DashboardGrid> + its
           * edit-mode modals (PortletAnalysisModal, DashboardEditModal). It
           * creates a Zustand store per dashboard mount that holds edit-mode
           * state, modal visibility, draft layouts, and chart debug data.
           *
           * DcModalA11yScope traps focus inside the dialog whenever any DC
           * modal is open. Mounted INSIDE DashboardStoreProvider so it can
           * subscribe to the store via useDashboardStore. */}
          <DashboardStoreProvider>
            <DcModalA11yScope>{children}</DcModalA11yScope>
          </DashboardStoreProvider>
        </CubeProvider>
      </QueryClientProvider>
    </div>
  );
}
