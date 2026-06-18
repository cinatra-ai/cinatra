"use client";
/**
 * AnalyticsPortletView — the keystone renderer for the apiVersion 1.2
 * `analytics` portlet kind (cinatra#325).
 *
 * An apiVersion 1.2 dashboard may carry a single `analytics` portlet whose
 * `config.dashboard` is a WHOLE drizzle-cube `DashboardConfig` (the embedded
 * format, structurally the legacy 1.1 shape). This component mounts that
 * embedded config as the full interactive drizzle-cube grid
 * (charts/filters/save/drag-resize) — the SAME composition the `/agents` screen
 * and `LegacyDashboardView` use — so an embedded analytics dashboard rendered
 * through `<PortletHost>` is byte-for-byte the live DC grid.
 *
 * Why it lives in `packages/dashboards/src/components/` (ESLint Layer 4):
 *   the transitive `drizzle-cube/client` import (via `DashboardsClientShell` +
 *   `DashboardGridContainer`) is ONLY permitted inside this directory
 *   (`eslint.config.mjs` Layer 4 carve-out, enforced by
 *   `packages/sdk-dashboard/src/__tests__/eslint-boundary.test.ts`). The app-dir
 *   `<PortletHost>` cannot import drizzle-cube/client, so it reaches this view
 *   through a thin app-local re-export lazy-loaded with `next/dynamic`, exactly
 *   like `[id]/page.tsx` lazy-loads `LegacyDashboardView`. The dynamic import
 *   keeps the DC client bundle off non-analytics dashboards.
 *
 * Editability:
 *   - Read-only by default (embedded extension/agent analytics dashboards, the
 *     #325 acceptance) — no `onSave`, no autosave wiring, exactly the
 *     `LegacyDashboardView` contract.
 *   - The optional `editable` + `onSave` props are the seam for the later
 *     entity-dashboard work (#328): when an editable screen threads them
 *     through, the underlying `DashboardGridContainer` wires its autosave
 *     coordinator. This component intentionally does NOT own the apiVersion 1.2
 *     wrap/unwrap — the caller passes the already-unwrapped DC config in and
 *     receives the DC config back out; the envelope stays the caller's concern.
 *   - `pageAnchor` / `dashboardModes` forward to `DashboardsClientShell` so a
 *     route-scoped toolbar (e.g. /agents Run/Create) and the Grid/Rows toggle
 *     are available to entity screens that opt in. They default to the shell's
 *     own defaults (no anchor, `["grid"]`) for the embedded read-only case.
 */
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import { DashboardGridContainer } from "./dashboard-grid-container";
import {
  DashboardsClientShell,
  type DashboardMode,
  type DashboardPageAnchor,
} from "./dashboards-client-shell";

export type AnalyticsPortletViewProps = {
  /** The embedded drizzle-cube dashboard config (the analytics portlet's
   *  `config.dashboard`), already unwrapped from the apiVersion 1.2 envelope. */
  readonly dashboard: DashboardConfigV1_1;
  /** Editable mount (entity dashboards, #328). Defaults to read-only. */
  readonly editable?: boolean;
  /** Server action persisting the edited DC config. Required for editable mounts;
   *  read-only mounts omit it and skip all save wiring. */
  readonly onSave?: (next: DashboardConfigV1_1) => Promise<void>;
  /** Tags the surface for route-scoped toolbar actions (forwarded to the shell). */
  readonly pageAnchor?: DashboardPageAnchor;
  /** Layout modes offered in edit mode (forwarded to the shell). */
  readonly dashboardModes?: readonly DashboardMode[];
};

export function AnalyticsPortletView({
  dashboard,
  editable = false,
  onSave,
  pageAnchor,
  dashboardModes,
}: AnalyticsPortletViewProps) {
  return (
    <DashboardsClientShell pageAnchor={pageAnchor} dashboardModes={dashboardModes}>
      <DashboardGridContainer
        initialConfig={dashboard}
        editable={editable}
        onSave={onSave}
      />
    </DashboardsClientShell>
  );
}
