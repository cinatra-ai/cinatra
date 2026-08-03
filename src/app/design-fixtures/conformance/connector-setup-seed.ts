// ---------------------------------------------------------------------------
// Deterministic seed kit for the four §II connector-SETUP conformance surfaces
// (cinatra#2354): connector-setup, connector-multi-setup, connector-connections,
// connector-config-tab.
//
// Imported by BOTH the harness fixture (connector-setup-fixture.tsx) and the
// Playwright drivers (tests/e2e/design/conformance/contract.ts), so a field
// assertion compares against the SAME value the harness rendered.
//
// Intentionally dependency-free (no "@/" or workspace imports): the Playwright
// suite imports this file by relative path, outside the Next.js toolchain —
// same contract as fixture-data.ts / seed-data.ts.
//
// ANTI-LOOKALIKE: every seeded config VALUE is a distinct nonsense token that
// appears nowhere else in the kit (and shares no substring with any other
// field's value or with its own key). A field driver that reads the wrong
// config key therefore REDS instead of passing on a lookalike — the same
// discipline seed-data.ts applies to displayName-vs-slug.
// ---------------------------------------------------------------------------

/** Addressable install id every fixture form dispatches its actions against. */
export const CONNECTOR_SETUP_INSTALL_ID = "conformance-fixture-install";

/**
 * Single-connection setup surface (`connector-setup`). Keys are the manifest's
 * field sources verbatim (`config.apiKey` → key `apiKey`, …) so a driver
 * asserting `[name="apiKey"]` is asserting the manifest binding itself.
 */
export const CONNECTOR_SETUP_CONFIG = {
  /**
   * `secret` kind — WRITE-ONLY by design: the stored value is never echoed
   * back into the DOM. The binding a driver can prove is therefore the
   * control's identity (name/id = the config key) plus the write-only
   * contract (no value attribute), NOT a rendered value.
   */
  apiKey: { key: "apiKey", label: "API key" },
  projectId: { key: "projectId", label: "Project ID", value: "zorvid-4417" },
  organizationId: {
    key: "organizationId",
    label: "Organization ID",
    value: "kwellum-8823",
  },
  serviceTier: {
    key: "serviceTier",
    label: "Service tier",
    value: "brintal",
    optionLabel: "Brintal",
    otherValue: "hexome",
    otherOptionLabel: "Hexome",
  },
  defaultModel: {
    key: "defaultModel",
    label: "Default model",
    value: "yuldrap",
    optionLabel: "Yuldrap",
    otherValue: "pravoss",
    otherOptionLabel: "Pravoss",
  },
} as const;

/** Multi-connection Setup tab (`connector-multi-setup`). */
export const CONNECTOR_MULTI_SETUP_CONFIG = {
  baseUrl: {
    key: "baseUrl",
    label: "Server base URL",
    value: "http://quenlow.invalid:10001",
  },
  bearerToken: { key: "bearerToken", label: "Bearer token" },
} as const;

/** Custom config tab (`connector-config-tab`). */
export const CONNECTOR_CONFIG_TAB = {
  tabId: "localShell",
  tabLabel: "Local shell",
  saveActionId: "saveShellConfig",
  saveLabel: "Save shell settings",
  fields: {
    shellEnabled: { key: "shellEnabled", label: "Enable sandboxed shell architecture", value: "true" },
    shellContainerImage: {
      key: "shellContainerImage",
      label: "Container image",
      value: "ghcr.io/tavrikon/sandbox:9931",
    },
    shellMaxSeconds: { key: "shellMaxSeconds", label: "Max execution seconds", value: "47" },
    shellReadRoots: { key: "shellReadRoots", label: "Readable roots", value: "/glimsurd" },
    shellAllowedPrefixes: {
      key: "shellAllowedPrefixes",
      label: "Allowed command prefixes",
      value: "vandrek",
    },
  },
} as const;

/**
 * Connections tab rows (`connector-connections`). EXACT cardinality: the
 * populated list renders exactly these rows; the connected and disconnected
 * counts are DISTINCT (2 vs 1), so counting the wrong collection is a red.
 */
export const CONNECTOR_CONNECTION_ROWS = [
  { name: "a2a-fixture-thornvale", url: "http://thornvale.invalid:10010", connected: true },
  { name: "a2a-fixture-mirebost", url: "http://mirebost.invalid:10002", connected: true },
  { name: "a2a-fixture-caldrune", url: "http://caldrune.invalid:10005", connected: false },
] as const;

export const CONNECTOR_CONNECTION_ROW_COUNT = CONNECTOR_CONNECTION_ROWS.length;
export const CONNECTOR_CONNECTION_CONNECTED_COUNT = CONNECTOR_CONNECTION_ROWS.filter(
  (r) => r.connected,
).length;
export const CONNECTOR_CONNECTION_DISCONNECTED_COUNT =
  CONNECTOR_CONNECTION_ROWS.length - CONNECTOR_CONNECTION_CONNECTED_COUNT;

/** Copy the empty Connections list renders (sdk-ui ConnectionsList default). */
export const CONNECTOR_CONNECTIONS_EMPTY_LABEL = "No connections yet.";
/** Copy the loading Connections list renders. */
export const CONNECTOR_CONNECTIONS_LOADING_LABEL = "Loading connections…";
/** Copy the loading/error setup surfaces render (sdk-ui ConnectorSetupColumns). */
export const CONNECTOR_SETUP_LOADING_LABEL = "Loading connector setup…";
export const CONNECTOR_SETUP_ERROR_LABEL = "This connector's setup could not be loaded.";
export const CONNECTOR_CONFIG_TAB_LOADING_LABEL = "Loading settings…";
export const CONNECTOR_CONFIG_TAB_ERROR_LABEL = "These settings could not be loaded.";
