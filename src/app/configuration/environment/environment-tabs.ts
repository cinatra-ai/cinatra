// Pure tab model for the Environment settings page, extracted from
// `page.tsx` so the dev/prod gating + the legacy `?tab=credentials`
// continuity alias are unit-testable without importing the server
// component (which pulls in requireAdminSession + the registries client).
//
// The "credentials" tab was renamed to "Connections" (?tab=connections)
// and is rendered ONLY in dev mode (isAppDevelopmentMode) — production
// credential setup happens via env vars + the per-connector pages. For
// continuity the legacy `?tab=credentials` URL aliases to connections in
// dev; in production both fall back to "mode" because the tab is hidden.

import { isAppDevelopmentMode } from "@/lib/runtime-mode";

export const CONNECTIONS_TAB_VALUE = "connections";
export const LEGACY_CONNECTIONS_TAB_VALUE = "credentials";

export type EnvTab = { value: string; label: string };

/** The Environment tab set. The dev-only "Connections" tab is appended
 *  last when the app is in development mode. */
export function buildTabs(): EnvTab[] {
  const base: EnvTab[] = [
    { value: "mode", label: "Mode" },
    { value: "instance", label: "Instance" },
    { value: "registries", label: "Registries" },
  ];
  if (isAppDevelopmentMode()) {
    base.push({ value: CONNECTIONS_TAB_VALUE, label: "Connections" });
  }
  return base;
}

export type ResolvedEnvTab = {
  /** The tab actually rendered (falls back to "mode" for any unknown or
   *  prod-hidden value). */
  tab: string;
  /** True when a prod user arrived via a connections/credentials URL that
   *  no longer resolves — the Mode tab surfaces an explainer in that case. */
  requestedConnections: boolean;
};

/**
 * Resolve the requested `?tab=` value against the live tab set:
 *   - dev `?tab=credentials` → aliased to `connections`
 *   - prod `?tab=credentials|connections` → falls back to `mode`, flagged
 *     so the Mode tab can explain the redirect
 *   - any unknown value → `mode`
 */
export function resolveEnvTab(rawTab: string, tabs: EnvTab[]): ResolvedEnvTab {
  const normalizedTab =
    rawTab === LEGACY_CONNECTIONS_TAB_VALUE && isAppDevelopmentMode()
      ? CONNECTIONS_TAB_VALUE
      : rawTab;
  const requestedConnections =
    !isAppDevelopmentMode() &&
    (rawTab === CONNECTIONS_TAB_VALUE || rawTab === LEGACY_CONNECTIONS_TAB_VALUE);
  const tab = tabs.some((item) => item.value === normalizedTab) ? normalizedTab : "mode";
  return { tab, requestedConnections };
}
