import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { buildConfigurationNeedsNotificationInput } from "@/lib/agent-configuration-needs-notifications";

import {
  ConformanceCardFixtures,
  ConformanceInstallPanelFixture,
} from "./card-fixtures";
import { NotificationConfigNeedsFixture } from "./notification-config-needs-fixture";
import { ConnectorSetupConformanceFixture } from "./connector-setup-fixture";
import {
  ConnectorConnectionsFixture,
  ConnectorMultiConnectionFixture,
} from "./connector-multi-connection-fixture";
import { InstallConfigNeedsConformanceFixture } from "./install-config-needs-fixture";
import { ApprovalsSchedulingConformanceFixtures } from "./approvals-scheduling-fixtures";
import { SidebarAssistantsConformanceFixture } from "./sidebar-assistants-fixture";
import { BreadcrumbEntityResolutionFixture } from "./breadcrumb-conformance-fixtures";
import { NotificationsConformanceFixtures } from "./notifications-conformance-fixtures";
import { LifecycleSuggestionChipFixtures } from "./lifecycle-card-fixtures";
import { LifecycleReviewTargetHeaderFixtures } from "./lifecycle-review-target-header-fixtures";
import { LifecycleComposerFixtures } from "./lifecycle-composer-fixtures";
import { LifecycleRecommendationFixtures } from "./lifecycle-recommendation-fixtures";
import { LifecycleScheduleCardFixtures } from "./lifecycle-schedule-card-fixtures";
import { RunStepRailConformanceFixture } from "./run-step-rail-conformance-fixtures";
import { ReviewGateStateConformanceFixtures } from "./review-gate-state-fixtures";
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
            <CardTitle>In-card install panel (surface: extension-install-panel)</CardTitle>
          </CardHeader>
          <CardContent>
            <ConformanceInstallPanelFixture />
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
              Connector setup — tabbed schema-config (surfaces: connector-setup,
              connector-config-tab)
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-8">
            <ConnectorSetupConformanceFixture />
            {/* The two non-ready variants both surfaces declare. */}
            <ConnectorSetupConformanceFixture variant="loading" />
            <ConnectorSetupConformanceFixture variant="error" />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Connector setup — multi-connection (surfaces: connector-multi-setup,
              connector-connections)
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-8">
            <ConnectorMultiConnectionFixture variant="populated" />
            <ConnectorMultiConnectionFixture variant="loading" />
            <ConnectorMultiConnectionFixture variant="error" />
            <ConnectorConnectionsFixture variant="populated" />
            <ConnectorConnectionsFixture variant="empty" />
            <ConnectorConnectionsFixture variant="loading" />
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
            scheduling-step, and — since the cinatra#3057 pin reconciliation —
            scheduling-step-configured in place of the retired
            scheduling-trigger-tab. */}
        <ApprovalsSchedulingConformanceFixtures />

        {/* App-shell surfaces adopted with the cinatra#3057 pin reconciliation:
            sidebar-assistants-entry (conformance/app.json) and
            breadcrumb-entity-resolution (conformance/app-components.json). */}
        <SidebarAssistantsConformanceFixture />
        <BreadcrumbEntityResolutionFixture />

        {/* /notifications unified-surface surfaces (conformance/app-notifications.json,
            design@2bcc2c7e; cinatra#1549 E11-AC2): notifications-list,
            notifications-filters, notification-row, approval-row,
            notifications-filter-rail, notifications-bell, notifications-empty,
            notifications-vendor-gate, notifications-degraded. */}
        <NotificationsConformanceFixtures />

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              In-conversation review suggestion chips (mount: chip-row-live)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3156, epic #3155: the REAL SuggestionChips row under the
                REAL chat-thread host declaration. The harness holds only the
                reader's local marks; the shipped component draws everything. */}
            <LifecycleSuggestionChipFixtures />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              In-conversation artifact-kind cards (surfaces: review-card-*)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3157, epic #3155: the REAL §IV target header the review
                card draws, under the REAL chat-thread host declaration, one
                mount per artifact kind. The harness seeds the answer's own
                values and words none of them. */}
            <LifecycleReviewTargetHeaderFixtures />
          </CardContent>
        </Card>
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              In-conversation review composer row (mounts: composer-row-bound,
              composer-row-acting, composer-rows-unbound, chat-composer-primary-field)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3159, epic #3155 W3: the REAL ComposerFocusRow, fed by the
                REAL binding hook inside the REAL focus store, plus the REAL
                primary chat box. The harness holds only which open review the
                reader chose; the shipped resolver decides every reading. */}
            <LifecycleComposerFixtures />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              In-conversation recommendation card (mounts: recommendation-paused,
              recommendation-empty, recommendation-readings)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3160, epic #3155 W4: the REAL RecommendationHoldCard — the
                ONE composer of the shipped row — under the REAL chat-thread host
                declaration, one mount per run. The card resolves the run's
                authoritative hold state itself, so this route hands it a run and
                nothing else; on this sessionless dev-only route that resolve
                answers "no row for this reader" and the card draws nothing, which
                is its own fail-closed reading. See the module header. */}
            <LifecycleRecommendationFixtures />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              In-conversation schedule card (nine surfaces, five readings)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3161, epic #3155: the REAL drawn schedule card under the
                REAL chat-thread host declaration, one mount per manifest
                surface. The harness supplies only what a server would have said
                — the resolved state and body, and the one answer the decision
                endpoint gives — and computes no presentation from it. */}
            <LifecycleScheduleCardFixtures />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Run step rail (surface: run-step-rail)</CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3162, epic #3155 W6: the REAL RunStepRailPanel on a run
                that carries every rail entry kind — a work step, the gate
                already answered and kept as history, the gate the run is paused
                on, and a step still ahead. The harness supplies the entries; the
                shipped component draws every row. */}
            <RunStepRailConformanceFixture />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>
              Review gate states (surfaces: review-gate-loading, review-gate-blocked)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* cinatra#3163, epic #3155: the REAL ReviewGateLoading and
                ReviewGateBlocked. Both are props-only, so nothing is intercepted;
                the blocked reason comes from the closed set the surface model
                owns and the panel writes its own words from it. */}
            <ReviewGateStateConformanceFixtures />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
