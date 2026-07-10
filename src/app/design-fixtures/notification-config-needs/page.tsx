import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { buildConfigurationNeedsNotificationInput } from "@/lib/agent-configuration-needs-notifications";

import { NotificationConfigNeedsFixture } from "./notification-config-needs-fixtures";

export const metadata: Metadata = {
  title: "Design Fixtures — Bell flyout needs-configuration row — Cinatra",
  description:
    "Internal route rendering the bell flyout's needs-configuration entry so the ruling (c) copy is verifiable on a production-equivalent build.",
};

/**
 * /design-fixtures/notification-config-needs.
 *
 * Internal route. Not linked from navigation. Builds the entry via the REAL
 * server-side builder (`buildConfigurationNeedsNotificationInput`) and renders
 * the REAL `ConfigurationNeedsRow`, so the flyout copy — `Set up connections
 * for "<agent>":` (cinatra #1057) — is verifiable without a session or an SSE
 * round-trip. Kept OFF the pixel-diffed /design-fixtures index page so the
 * committed baselines there stay untouched.
 */
export default function NotificationConfigNeedsFixturesPage() {
  const built = buildConfigurationNeedsNotificationInput({
    agentPackageName: "@cinatra-ai/social-outreach-agent",
    agentDisplayName: "Social Outreach Agent",
    connectors: [
      {
        displayName: "LinkedIn",
        packageName: "@cinatra-ai/linkedin-connector",
        settingsHref: "/connectors/cinatra-ai/linkedin/setup",
      },
    ],
  });
  const connectors =
    (built.metadata as {
      configurationNeeds: {
        connectors: {
          displayName: string;
          packageName: string;
          settingsHref: string | null;
        }[];
      };
    }).configurationNeeds.connectors;

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Bell flyout — needs-configuration row"
        description={
          "The post-install bell entry: one per gated agent, titled from the real builder."
        }
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <NotificationConfigNeedsFixture
          title={built.title}
          createdAt={new Date("2026-07-10T09:00:00.000Z").toISOString()}
          connectors={connectors}
        />
      </PageContent>
    </Main>
  );
}
