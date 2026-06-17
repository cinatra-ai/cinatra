"use client";
/**
 * LegacyDashboardView — read-only renderer for the legacy operator/agent
 * dashboard config family (config_version 1.0.0 / 1.1.0) on the generic
 * `/dashboards/[id]` route (cinatra#272).
 *
 * Agent-created dashboards (`dashboards_create` MCP) and operator `/agents`
 * saves persist a drizzle-cube `DashboardConfig` (NOT an extension apiVersion 1.2 config).
 * Those rows already render on the bespoke `/agents` screen via
 * `<AgentsDashboardGrid>`; this component reuses the SAME underlying grid
 * (`<DashboardGridContainer>`) so the generic detail route renders an
 * agent-created dashboard with its real analytics portlets instead of the
 * "Unsupported dashboard format" card.
 *
 * READ-ONLY by contract:
 *   - Mounted via `<DashboardGridContainer editable={false}>` with NO `onSave`.
 *     The container's read-only branch renders `<ComposedDashboard editable=
 *     {false}>` with the autosave coordinator and every save/config-change
 *     callback skipped entirely — there is no write wiring at all on the
 *     generic viewer. Persistence for legacy dashboards stays on the dedicated
 *     `/agents`-family screens, which wire the real `upsertDashboardConfig`
 *     server action.
 *
 * Lives under `packages/dashboards/src/components/` so the ESLint Layer 4
 * carve-out permits the transitive `drizzle-cube/client` import (via
 * `DashboardsClientShell` + `DashboardGridContainer`), mirroring `agents-dashboard.tsx`.
 */
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import { DashboardGridContainer } from "./dashboard-grid-container";
import { DashboardsClientShell } from "./dashboards-client-shell";

export type LegacyDashboardViewProps = {
  /** The parsed legacy config from the dashboard row's `config_json`. */
  readonly config: DashboardConfigV1_1;
};

export function LegacyDashboardView({ config }: LegacyDashboardViewProps) {
  return (
    <DashboardsClientShell>
      <DashboardGridContainer initialConfig={config} editable={false} />
    </DashboardsClientShell>
  );
}
