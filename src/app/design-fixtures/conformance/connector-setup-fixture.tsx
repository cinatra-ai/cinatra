import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { ConnectorStatusProbeCard } from "@/components/extensions/connector-status-probe-card";

/**
 * Conformance fixture — the TABBED schema-config connector setup surface
 * (design/specs/app-connectors.html §II: Setup + custom tab + reserved Help
 * tab). Mounts the REAL host renderer (`SchemaConfigConnectorForm`) plus the
 * REAL right-column status card with deterministic fixture data, so the
 * design functional-acceptance suite can assert the §II layout contract on a
 * production-equivalent DOM once the regenerated app-connectors manifest
 * covers the setup surfaces:
 *  - tablist hoisted ABOVE the two-column Setup grid (page-header chrome);
 *  - no duplicated title/description inside the content column;
 *  - role-less named actions render as their button only (no echoed label);
 *  - custom-tab content at the Narrow width;
 *  - Help = ONE read-only card of merged advisory sections.
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
      key: "fixtureApiKey",
      label: "API key",
      description: "Paste the fixture API key. It is validated before it is saved.",
    },
    {
      kind: "select",
      key: "fixtureModel",
      label: "Default model",
      options: [
        { value: "standard", label: "Standard" },
        { value: "advanced", label: "Advanced" },
      ],
      defaultValue: "standard",
    },
    { kind: "named-action", label: "Connect", actionId: "saveConnection", role: "connect" },
    { kind: "named-action", label: "Disconnect", actionId: "clearConnection", role: "disconnect" },
  ],
  tabs: [
    {
      id: "policy",
      label: "Policy",
      fields: [
        {
          kind: "boolean",
          key: "fixturePolicyEnabled",
          label: "Enable fixture policy",
          defaultValue: true,
        },
        { kind: "named-action", label: "Save policy settings", actionId: "savePolicy" },
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
          label: "About the fixture policy",
          tone: "warning",
          probeActionId: "helpContentReady",
          whenReady: "The Policy tab controls the fixture's example policy switch.",
          whenNotReady: "The Policy tab controls the fixture's example policy switch.",
        },
      ],
    },
  ],
} as const;

export function ConnectorSetupConformanceFixture() {
  const parsed = parseSchemaConfig(RAW_SURFACE);
  if (!parsed.ok) {
    // A fixture that fails the real parser is a fixture bug — fail loud so the
    // harness run reds instead of silently asserting against nothing.
    throw new Error(`connector-setup fixture surface invalid: ${parsed.errors.join("; ")}`);
  }
  return (
    <div data-surface-id="connector-setup-tabbed">
      <SchemaConfigConnectorForm
        installId="conformance-fixture-install"
        packageName="@cinatra-fixtures/schema-config-connector"
        surface={parsed.surface}
        omitFieldKinds={["status-probe"]}
        initialConnected
        aside={
          <ConnectorStatusProbeCard
            installId="conformance-fixture-install"
            actionId="connectionStatus"
            initialConnected
            connectedLabel="Connected"
          />
        }
      />
    </div>
  );
}
