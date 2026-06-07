import "server-only";

// ---------------------------------------------------------------------------
// @cinatra-ai/notifications/server — SERVER-ONLY barrel.
//
// Re-exports the server-only modules (service / realtime / recipient-policy /
// request-actor / agent-run-href). Each underlying module keeps its own
// `import "server-only"`.
//
// ERGONOMIC re-export ONLY: the
// setNotificationsHostAdapters setter + NotificationsHostAdapters type are
// re-exported here for the convenience of NON-boot callers (the
// adapter-mocking tests). The boot-reachable `src/lib/notifications-host.ts`
// MUST import the setter from the TRUE LEAF
// `@cinatra-ai/notifications/host-adapters`, NOT from here — importing it
// from this barrel would pull service/realtime/recipient-policy/request-actor
// onto the Next.js boot graph (the exact ESM/TDZ hazard the leaf split
// exists to prevent).
// ---------------------------------------------------------------------------

export {
  countUnreadForUser,
  createBackgroundProgressNotification,
  createNotificationForRecipient,
  // Append-only agent-creation progress emit plus its swallowing wrapper,
  // re-exported from the server barrel so callers import via the public
  // package surface instead of `./service` directly.
  emitAgentCreationProgress,
  safeEmitAgentCreationProgress,
  listNotificationsForUser,
  markAllNotificationsReadForUser,
  markNotificationReadForUser,
  markNotificationsReadByHrefPrefixForUser,
} from "./service";
export type { CreateNotificationOptions } from "./service";
export type { AgentCreationProgressMilestone } from "./service";

export {
  subscribeUserNotifications,
  __emitForTest,
  __disposeForTest,
} from "./realtime";

export {
  getRecipientForJob,
  resolveRecipientToUserIds,
  topicForRecipient,
} from "./recipient-policy";

export { resolveRequestActorContext } from "./request-actor";

export { resolveAgentRunHref } from "./agent-run-href";

// Ergonomic-only re-export for NON-boot callers (adapter-mocking tests).
export {
  setNotificationsHostAdapters,
  getNotificationsHostAdapters,
} from "./host-adapters";
export type {
  NotificationsHostAdapters,
  BetterAuthSessionLike,
} from "./host-adapters";
