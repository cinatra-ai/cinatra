// ---------------------------------------------------------------------------
// @cinatra-ai/notifications/client — BROWSER-SAFE barrel.
//
// Re-exports the pure flyout-state helpers + the `"use client"` flyout
// component. NO `server-only` import anywhere in this graph (flyout-state.ts
// + notifications-flyout.tsx are both browser-safe; the only types imported
// come from ./types which is pure).
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
} from "./flyout-state";
export type {
  ConfigurationNeedsConnector,
  ConfigurationNeedsMetadata,
} from "./flyout-state";

export {
  NotificationsProvider,
  NotificationsBellTrigger,
  // Exported for the design-fixtures render surface (the bell config-needs row
  // in isolation); the app itself renders it via the flyout tree.
  ConfigurationNeedsRow,
} from "./notifications-flyout";

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
