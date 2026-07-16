import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { buildConfigurationNeedsNotificationInput } from "@/lib/agent-configuration-needs-notifications";

import { ConformanceCardFixtures } from "./card-fixtures";
import { NotificationConfigNeedsFixture } from "./notification-config-needs-fixture";
import { ConnectorSetupConformanceFixture } from "./connector-setup-fixture";
import { InstallConfigNeedsConformanceFixture } from "./install-config-needs-fixture";
import { ApprovalsSchedulingConformanceFixtures } from "./approvals-scheduling-fixtures";
import { NotificationsConformanceFixtures } from "./notifications-conformance-fixtures";
import {
  CONFORMANCE_BUTTON_VARIANTS,
  CONFORMANCE_STATUS_PILL_STATUSES,
} from "./fixture-data";

// Bell flyout needs-configuration row (cinatra#1057 ruling (c)). Built here from
// the REAL server-side builder so the entry copy — `Set up connections for
// "<agent>":` — is verifiable byte-for-byte on the production-equivalent boot.
// Mounted in THIS already-allowlisted conformance harness (off the pixel-diffed
// /design-fixtures index, coverage assertion-based) rather than a NEW standalone
// public route, so no src/lib/auth-route-guard.ts allowlist edit is needed and
// the change stays off the gate-suite high-risk auth paths.
const BELL_CONFIG_NEEDS_FIXTURE = buildConfigurationNeedsNotificationInput({
  agentPackageName: "@cinatra-ai/social-outreach-agent",
  agentDisplayName: "Social Outreach Agent",
  connectors: [
    {
      // FICTIONAL connector package (like the fictional agent above): the
      // core-extension-instance-coupling-ban forbids a core file naming a real
      // extension instance, and the fixture only needs a plausible shape —
      // packageName is used as a React key, never rendered.
      displayName: "LinkedIn",
      packageName: "@cinatra-ai/pro-network-connector",
      settingsHref: "/connectors/cinatra-ai/pro-network/setup",
    },
  ],
});
const BELL_CONFIG_NEEDS_CONNECTORS = (
  BELL_CONFIG_NEEDS_FIXTURE.metadata as {
    configurationNeeds: {
      connectors: {
        displayName: string;
        packageName: string;
        settingsHref: string | null;
      }[];
    };
  }
).configurationNeeds.connectors;

export const metadata: Metadata = {
  title: "Design Fixtures — Conformance harness — Cinatra",
  description:
    "Internal route mounting the real conformance-surface components (extension listing cards through the real six-state CTA machinery, status pills, button variants) for the manifest-driven functional-acceptance suite.",
};

/**
 * /design-fixtures/conformance.
 *
 * Internal route. Not linked from navigation. The functional-acceptance
 * harness for the design-conformance manifests (cinatra#985): mounts the REAL
 * covered components with deterministic fixture data so
 * tests/e2e/design/conformance/functional-acceptance.spec.ts can assert, per
 * manifest surface, that required fields render bound to the right data,
 * actions produce their specified outcomes, and required state variants exist
 * — on the production-equivalent standalone boot, no DB/registry round-trip.
 *
 * Kept OFF the pixel-diffed /design-fixtures index page (same convention as
 * the §V detail-modal fixture route) so the committed pixel baselines stay
 * untouched; coverage here is assertion-based.
 *
 * Operational sources: the published conformance manifests (see
 * tests/e2e/design/conformance-pins.json) generated from the annotated
 * design specs at https://docs.cinatra.ai/references/design/.
 */
export default function ConformanceHarnessPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Conformance harness"
        description="Internal — real conformance-surface components mounted with deterministic fixtures for the manifest-driven functional-acceptance gate."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Status pills (surface: status-pills)</CardTitle>
          </CardHeader>
          <CardContent>
            <div data-surface-id="status-pills" className="flex flex-wrap gap-2">
              {CONFORMANCE_STATUS_PILL_STATUSES.map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Button variants (surface: button-variants)</CardTitle>
          </CardHeader>
          <CardContent>
            <div data-surface-id="button-variants" className="flex flex-wrap items-center gap-2">
              {CONFORMANCE_BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Extension listing cards (surfaces: extension-listing-card-*)</CardTitle>
          </CardHeader>
          <CardContent>
            <ConformanceCardFixtures />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Bell flyout — needs-configuration row (surface: bell-config-needs-row)</CardTitle>
          </CardHeader>
          <CardContent>
            <NotificationConfigNeedsFixture
              title={BELL_CONFIG_NEEDS_FIXTURE.title}
              createdAt={new Date("2026-07-10T09:00:00.000Z").toISOString()}
              connectors={BELL_CONFIG_NEEDS_CONNECTORS}
            />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Connector setup — tabbed schema-config (surface: connector-setup-tabbed)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConnectorSetupConformanceFixture />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Post-install needs-configuration callout (surface: install-config-needs-callout)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InstallConfigNeedsConformanceFixture />
          </CardContent>
        </Card>

        {/* Approvals + Scheduling surfaces added at spec 4d7b3505 (cinatra#1043):
            approvals-inbox, approvals-your-requests, approvals-marketplace-states,
            scheduling-step, scheduling-trigger-tab. */}
        <ApprovalsSchedulingConformanceFixtures />

        {/* /notifications unified-surface surfaces (conformance/app-notifications.json,
            design@2bcc2c7e; cinatra#1549 E11-AC2): notifications-list,
            notifications-filters, notification-row, approval-row,
            notifications-filter-rail, notifications-bell, notifications-empty,
            notifications-vendor-gate, notifications-degraded. */}
        <NotificationsConformanceFixtures />
      </PageContent>
    </Main>
  );
}
