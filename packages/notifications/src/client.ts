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
} from "./flyout-state";

export {
  NotificationsProvider,
  NotificationsBellTrigger,
} from "./notifications-flyout";
