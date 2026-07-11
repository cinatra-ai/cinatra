"use client";

// ---------------------------------------------------------------------------
// Bell flyout "needs configuration" row — isolated design-fixtures render
// (cinatra #1057 ruling (c)). Mounts the REAL `ConfigurationNeedsRow` (the same
// component the notifications flyout renders) so the entry copy is verifiable on
// a production-equivalent build without a session, a seeded DB, or an SSE
// round-trip. The `title` prop is produced by the REAL server-side builder
// (`buildConfigurationNeedsNotificationInput`) in the page below, so the string
// shown here is byte-for-byte what the bell reconciler writes.
// ---------------------------------------------------------------------------

import {
  ConfigurationNeedsRow,
  AGENT_CONFIGURATION_NEEDS_CATEGORY,
} from "@cinatra-ai/notifications/client";
import type { ConfigurationNeedsConnector } from "@cinatra-ai/notifications/client";
import type { AppNotification } from "@cinatra-ai/notifications/types";

export function NotificationConfigNeedsFixture({
  title,
  createdAt,
  connectors,
}: {
  title: string;
  createdAt: string;
  connectors: ConfigurationNeedsConnector[];
}): React.ReactElement {
  const notification: AppNotification = {
    id: "cfg-needs-fixture",
    title,
    body: "",
    kind: "warning",
    createdAt,
    metadata: {
      category: AGENT_CONFIGURATION_NEEDS_CATEGORY,
      configurationNeeds: {
        agentPackageName: "@cinatra-ai/social-outreach-agent",
        agentDisplayName: "Social Outreach Agent",
        connectors,
      },
    },
  };
  return (
    <div
      data-surface-id="bell-config-needs-row"
      className="w-full max-w-[380px]"
    >
      <ConfigurationNeedsRow
        notification={notification}
        connectors={connectors}
        onCloseFlyout={() => {}}
      />
    </div>
  );
}
