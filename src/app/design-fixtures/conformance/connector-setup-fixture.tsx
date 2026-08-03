import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { ConnectorStatusProbeCard } from "@/components/extensions/connector-status-probe-card";

import {
  CONNECTOR_CONFIG_TAB,
  CONNECTOR_SETUP_CONFIG,
  CONNECTOR_SETUP_INSTALL_ID,
} from "./connector-setup-seed";

/**
 * Conformance fixture — the TABBED schema-config connector setup surface
 * (design/specs/app-connectors.html §II: Setup + custom tab + reserved Help
 * tab). ONE mount carries TWO manifest surfaces, exactly as the real page
 * does: `connector-setup` (the two-column Setup body, emitted by the sdk-ui
 * `ConnectorSetupColumns` the form renders) and `connector-config-tab` (the
 * custom tab's Narrow-width panel, emitted by the form).
 *
 * Mounts the REAL host renderer (`SchemaConfigConnectorForm`) plus the REAL
 * right-column status card (`ConnectorStatusProbeCard` → sdk-ui
 * `ConnectionStatusCard`), so the design functional-acceptance suite asserts
 * the §II layout + data contract on a production-equivalent DOM:
 *  - tablist hoisted ABOVE the two-column Setup grid (page-header chrome);
 *  - no duplicated title/description inside the content column;
 *  - role-less named actions render as their button only (no echoed label);
 *  - custom-tab content at the Narrow width;
 *  - Help = ONE read-only card of merged advisory sections.
 *
 * FIELD KEYS ARE THE MANIFEST BINDINGS: the pinned manifest binds
 * `api-key = config.apiKey`, `service-tier = config.serviceTier`, … so each
 * declared field `key` is the manifest source's own key and a driver asserting
 * `[name="serviceTier"]` is asserting the binding itself. Seeded values are
 * anti-lookalike nonsense tokens (connector-setup-seed.ts) and every select's
 * seeded value is deliberately NOT its first option, so a driver that read a
 * fallback/default instead of the hydrated config value REDS.
 *
 * SEEDING NOTE: the connector is seeded NOT connected — both the form's
 * `initialConnected` (host readiness, which gates Disconnect per §II item 8)
 * and the status card's badge seed. Every action therefore witnesses a REAL
 * transition out of the seeded state rather than re-asserting the state it
 * started in: `connect -> connected` flips the form connected (and releases
 * the gated Disconnect), `disconnect -> confirming` opens its confirmation
 * only after that gate has genuinely been released, and
 * `check-connection -> checked` moves the badge off "Disconnected".
 *
 * Deterministic: the only mount-time fetches are the Help advisories' probes,
 * which resolve fail-closed (`whenNotReady`) against the fixture install id —
 * both copies are identical, exactly like real help-prose declarations. The
 * status card probes only on an explicit Check click. This route is
 * assertion-driven, NOT pixel-diffed (same convention as the other
 * conformance fixtures), so it adds no screenshot baselines.
 */
const RAW_SURFACE = {
  // Deliberately declares the title/description duplication the renderer must
  // DROP (the page header owns the connector name + subtitle).
  title: "Fixture Connector",
  description: "A schema-config fixture connector for the conformance harness.",
  fields: [
    {
      kind: "secret",
      key: CONNECTOR_SETUP_CONFIG.apiKey.key,
      label: CONNECTOR_SETUP_CONFIG.apiKey.label,
      description:
        "Paste the fixture API key. It is validated before it is saved. Leave blank to keep the current saved key; use Disconnect to remove it.",
    },
    {
      kind: "text",
      key: CONNECTOR_SETUP_CONFIG.projectId.key,
      label: CONNECTOR_SETUP_CONFIG.projectId.label,
      description: "Scope usage to a specific fixture project.",
    },
    {
      kind: "text",
      key: CONNECTOR_SETUP_CONFIG.organizationId.key,
      label: CONNECTOR_SETUP_CONFIG.organizationId.label,
      description: "Scope to a specific fixture organization.",
    },
    {
      kind: "select",
      key: CONNECTOR_SETUP_CONFIG.serviceTier.key,
      label: CONNECTOR_SETUP_CONFIG.serviceTier.label,
      // The seeded value is the SECOND option: a driver reading the
      // first-option fallback instead of the hydrated config value is a RED.
      options: [
        {
          value: CONNECTOR_SETUP_CONFIG.serviceTier.otherValue,
          label: CONNECTOR_SETUP_CONFIG.serviceTier.otherOptionLabel,
        },
        {
          value: CONNECTOR_SETUP_CONFIG.serviceTier.value,
          label: CONNECTOR_SETUP_CONFIG.serviceTier.optionLabel,
        },
      ],
    },
    {
      kind: "select",
      key: CONNECTOR_SETUP_CONFIG.defaultModel.key,
      label: CONNECTOR_SETUP_CONFIG.defaultModel.label,
      options: [
        {
          value: CONNECTOR_SETUP_CONFIG.defaultModel.otherValue,
          label: CONNECTOR_SETUP_CONFIG.defaultModel.otherOptionLabel,
        },
        {
          value: CONNECTOR_SETUP_CONFIG.defaultModel.value,
          label: CONNECTOR_SETUP_CONFIG.defaultModel.optionLabel,
        },
      ],
    },
    // The connector's own status probe. `omitFieldKinds` lifts it OUT of the
    // form column and into the right-column card (Model-A, §II) — the host
    // never invents a probe id, so the card reads THIS action id.
    { kind: "status-probe", label: "Connection", actionId: "connectionStatus" },
    { kind: "named-action", label: "Connect", actionId: "saveConnection", role: "connect" },
    { kind: "named-action", label: "Disconnect", actionId: "clearConnection", role: "disconnect" },
  ],
  tabs: [
    {
      // The custom config tab — manifest surface `connector-config-tab`.
      id: CONNECTOR_CONFIG_TAB.tabId,
      label: CONNECTOR_CONFIG_TAB.tabLabel,
      fields: [
        {
          kind: "boolean",
          key: CONNECTOR_CONFIG_TAB.fields.shellEnabled.key,
          label: CONNECTOR_CONFIG_TAB.fields.shellEnabled.label,
          // Seeded FALSE at the schema default so the hydrated "true" proves
          // the config read, not the declared default.
          defaultValue: false,
          description:
            "When enabled, the package can prepare shell tool payloads plus the sandbox policy your executor should apply.",
        },
        {
          kind: "text",
          key: CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key,
          label: CONNECTOR_CONFIG_TAB.fields.shellContainerImage.label,
        },
        {
          kind: "number",
          key: CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.key,
          label: CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.label,
          min: 1,
          max: 600,
        },
        {
          kind: "free-list",
          key: CONNECTOR_CONFIG_TAB.fields.shellReadRoots.key,
          label: CONNECTOR_CONFIG_TAB.fields.shellReadRoots.label,
          itemLabel: "root",
        },
        {
          kind: "free-list",
          key: CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.key,
          label: CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.label,
          itemLabel: "prefix",
        },
        // The result-driven banner the save action's `{ banner: "saved" }`
        // result resolves to — the REAL cinatra#1109 outcome machinery, which
        // is how `save-config -> saved` is witnessed.
        {
          kind: "banner",
          label: "Save outcome",
          variants: [
            { name: "saved", tone: "success", message: "Shell settings saved." },
            { name: "error", tone: "destructive", message: "Shell settings could not be saved." },
          ],
        },
        {
          kind: "named-action",
          label: CONNECTOR_CONFIG_TAB.saveLabel,
          actionId: CONNECTOR_CONFIG_TAB.saveActionId,
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      fields: [
        {
          kind: "advisory",
          label: "Connect the fixture",
          tone: "info",
          probeActionId: "helpContentReady",
          whenReady: "Create a fixture key and paste it into the API key field on the Setup tab.",
          whenNotReady: "Create a fixture key and paste it into the API key field on the Setup tab.",
        },
        {
          kind: "advisory",
          label: "About the local shell",
          tone: "warning",
          probeActionId: "helpContentReady",
          whenReady: "The Local shell tab controls the fixture's sandbox policy.",
          whenNotReady: "The Local shell tab controls the fixture's sandbox policy.",
        },
      ],
    },
  ],
} as const;

/** Hydrated config values — the `config.*` sources the manifest fields bind. */
const INITIAL_VALUES: Record<string, string> = {
  [CONNECTOR_SETUP_CONFIG.projectId.key]: CONNECTOR_SETUP_CONFIG.projectId.value,
  [CONNECTOR_SETUP_CONFIG.organizationId.key]: CONNECTOR_SETUP_CONFIG.organizationId.value,
  [CONNECTOR_SETUP_CONFIG.serviceTier.key]: CONNECTOR_SETUP_CONFIG.serviceTier.value,
  [CONNECTOR_SETUP_CONFIG.defaultModel.key]: CONNECTOR_SETUP_CONFIG.defaultModel.value,
  [CONNECTOR_CONFIG_TAB.fields.shellEnabled.key]: CONNECTOR_CONFIG_TAB.fields.shellEnabled.value,
  [CONNECTOR_CONFIG_TAB.fields.shellContainerImage.key]:
    CONNECTOR_CONFIG_TAB.fields.shellContainerImage.value,
  [CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.key]:
    CONNECTOR_CONFIG_TAB.fields.shellMaxSeconds.value,
  [CONNECTOR_CONFIG_TAB.fields.shellReadRoots.key]: JSON.stringify([
    CONNECTOR_CONFIG_TAB.fields.shellReadRoots.value,
  ]),
  [CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.key]: JSON.stringify([
    CONNECTOR_CONFIG_TAB.fields.shellAllowedPrefixes.value,
  ]),
};

/**
 * One mount of the §II setup page. `variant` selects the surface state the
 * manifest requires on BOTH `connector-setup` and `connector-config-tab`:
 * `populated` (ready) plus the `loading` / `error` variants, each rendered by
 * the REAL components through their own state props.
 */
export function ConnectorSetupConformanceFixture({
  variant = "populated",
}: {
  variant?: "populated" | "loading" | "error";
} = {}) {
  const parsed = parseSchemaConfig(RAW_SURFACE);
  if (!parsed.ok) {
    // A fixture that fails the real parser is a fixture bug — fail loud so the
    // harness run reds instead of silently asserting against nothing.
    throw new Error(`connector-setup fixture surface invalid: ${parsed.errors.join("; ")}`);
  }
  return (
    <div data-surface-id="connector-setup-tabbed" data-variant={variant}>
      <SchemaConfigConnectorForm
        installId={CONNECTOR_SETUP_INSTALL_ID}
        packageName="@cinatra-fixtures/schema-config-connector"
        surface={parsed.surface}
        omitFieldKinds={["status-probe"]}
        initialValues={INITIAL_VALUES}
        conformanceId="connector-setup"
        conformanceState={variant === "populated" ? "ready" : variant}
        aside={
          <ConnectorStatusProbeCard
            installId={CONNECTOR_SETUP_INSTALL_ID}
            actionId="connectionStatus"
            initialConnected={false}
          />
        }
      />
    </div>
  );
}
