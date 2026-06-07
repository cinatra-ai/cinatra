# @cinatra-ai/notifications

Postgres-backed notification layer for the Cinatra platform. It resolves recipients at
write time, persists per-user notification rows, streams live updates over SSE, and
provides the in-app notification flyout/bell UI.

The package ships four entry points with strict server/client/leaf separation, so it can
be imported safely from server code, browser components, or boot-time host wiring without
dragging the server graph onto the client or the boot graph.

## Public API

### `@cinatra-ai/notifications/server`
Server-only writers, readers, and realtime.
- `createNotificationForRecipient` / `createBackgroundProgressNotification` — write notifications
- `emitAgentCreationProgress` / `safeEmitAgentCreationProgress` — append agent-creation progress
- `listNotificationsForUser` / `countUnreadForUser` — read per-user state
- `markNotificationReadForUser` / `markAllNotificationsReadForUser` / `markNotificationsReadByHrefPrefixForUser` — read-state updates
- `subscribeUserNotifications` — per-user realtime subscription
- `getRecipientForJob` / `resolveRecipientToUserIds` / `topicForRecipient` — recipient policy
- `resolveRequestActorContext` — resolve actor from request
- `resolveAgentRunHref` — canonical deep-link for an agent run

### `@cinatra-ai/notifications/client`
Browser-safe flyout state and components.
- `NotificationsProvider` / `NotificationsBellTrigger` — flyout UI
- `applySseNotification` / `collapseByJobId` — live-state reducers
- `getUnreadItems` / `getInProgressItems` / `isRunningProgressNotification` / `filterAgentCreationProgressByRunId` — selectors

### `@cinatra-ai/notifications/types`
Pure types, zero runtime deps: `NotificationKind`, `NotificationRecipient`, `NotificationInput`, `NotificationRecord`, `AppNotification`, `ActorContext`.

### `@cinatra-ai/notifications/host-adapters`
Leaf-pure host wiring contract: `NotificationsHostAdapters`, `setNotificationsHostAdapters`, `getNotificationsHostAdapters`.

### `@cinatra-ai/notifications/perf-log`
Optional, env-gated performance instrumentation helpers.

## Usage

```ts
import { createNotificationForRecipient } from "@cinatra-ai/notifications/server";

await createNotificationForRecipient(
  { kind: "user", userId },
  { title: "Run finished", kind: "success", href: "/agents/run/123" },
);
```

## Docs

See https://docs.cinatra.ai
