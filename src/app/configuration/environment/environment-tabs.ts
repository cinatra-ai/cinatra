// Pure tab model for the Environment settings page, extracted from
// `page.tsx` so the legacy `?tab=connections|credentials` continuity
// handling is unit-testable without importing the server component
// (which pulls in requireAdminSession + the registries client).
//
// The "credentials" tab was renamed to "Connections" (?tab=connections)
// and later RETIRED outright (cinatra#35): the inline Nango settings
// section it rendered was the last consumer of the host's
// `@/lib/nango-settings-section` re-export facade, and the canonical,
// mode-independent destination for connection-service configuration is
// `/setup/connections` (see the connections-deeplink-guard test). Both
// legacy values still resolve: they fall back to "mode", flagged so the
// Mode tab can surface the pointer to /setup/connections.

export const CONNECTIONS_TAB_VALUE = "connections";
export const LEGACY_CONNECTIONS_TAB_VALUE = "credentials";

export type EnvTab = { value: string; label: string };

/** The Environment tab set. The retired "Connections" tab is never
 *  offered — connection-service configuration lives on /setup/connections. */
export function buildTabs(): EnvTab[] {
  return [
    { value: "mode", label: "Mode" },
    { value: "instance", label: "Instance" },
    { value: "registries", label: "Registries" },
  ];
}

export type ResolvedEnvTab = {
  /** The tab actually rendered (falls back to "mode" for any unknown or
   *  retired value). */
  tab: string;
  /** True when the user arrived via a connections/credentials URL that
   *  no longer resolves — the Mode tab surfaces an explainer in that case. */
  requestedConnections: boolean;
};

/**
 * Resolve the requested `?tab=` value against the live tab set:
 *   - `?tab=connections|credentials` (retired tab) → falls back to `mode`,
 *     flagged so the Mode tab can point at /setup/connections
 *   - any unknown value → `mode`, unflagged
 */
export function resolveEnvTab(rawTab: string, tabs: EnvTab[]): ResolvedEnvTab {
  const requestedConnections =
    rawTab === CONNECTIONS_TAB_VALUE || rawTab === LEGACY_CONNECTIONS_TAB_VALUE;
  const tab = tabs.some((item) => item.value === rawTab) ? rawTab : "mode";
  return { tab, requestedConnections };
}
