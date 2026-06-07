"use client";

// The notification context now lives in @cinatra-ai/sdk-ui so extension
// settings/setup pages can consume `useNotify` without an `@/` host edge.
// This host module re-exports it for existing host callers (app-shell etc.).
export {
  NotificationContext,
  useNotify,
} from "@cinatra-ai/sdk-ui";
export type {
  AddNotificationInput,
  NotificationContextValue,
} from "@cinatra-ai/sdk-ui";
