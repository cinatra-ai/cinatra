// ---------------------------------------------------------------------------
// @cinatra-ai/notifications/client — BROWSER-SAFE barrel.
//
// Re-exports the pure notification-state helpers + the `"use client"` bell
// (badge + link, no flyout — the flyout was retired in the E8 cutover,
// cinatra#1558) and the standalone config-needs row. NO `server-only` import
// anywhere in this graph; the only types imported come from ./types which is
// pure.
// ---------------------------------------------------------------------------

export {
  applySseNotification,
  collapseByJobId,
  filterAgentCreationProgressByRunId,
  getInProgressItems,
  getUnreadItems,
  isRunningProgressNotification,
  isConfigurationNeedsNotification,
  getConfigurationNeedsMetadata,
  AGENT_CONFIGURATION_NEEDS_CATEGORY,
  isRunAwaitingHumanNotification,
  getRunAwaitingHumanMetadata,
  RUN_AWAITING_HUMAN_CATEGORY,
} from "./flyout-state";
export type {
  ConfigurationNeedsConnector,
  ConfigurationNeedsMetadata,
  RunAwaitingHumanMetadata,
} from "./flyout-state";

export {
  NotificationsProvider,
  NotificationsBellTrigger,
} from "./notifications-provider";

// Exported for the design-fixtures render surface (the bell config-needs row in
// isolation, `bell-config-needs-row`). Standalone since the flyout retirement.
export { ConfigurationNeedsRow } from "./configuration-needs-row";

// The shared client store the flyout consumes and the future /notifications
// v2 page (E7) will mount against — the extracted poll/SSE/mark-read state
// machine. Also importable component-free via
// `@cinatra-ai/notifications/notifications-store`.
export {
  createNotificationsStore,
  useNotificationsStore,
  NOTIFICATIONS_POLL_INTERVAL_MS,
} from "./notifications-store";
export type {
  NotificationsStore,
  NotificationsSnapshot,
} from "./notifications-store";
