"use client";

import { createContext, useContext } from "react";

// Explicit toast input shape decoupled from the widened
// `AppNotification["kind"]` (which now includes "info" for
// background-process running rows). Toasts only render the three severity
// kinds; an `info`-kind notification belongs to the flyout's
// In-progress tab, not the sonner toast surface. Keeping this type literal
// here prevents widening from silently letting `addNotification({ kind: "info" })`
// fall through to the `toast.success` mapping in app-shell.tsx.
export type AddNotificationInput = {
  title: string;
  body: string;
  kind: "success" | "error" | "warning";
  href?: string;
};

export type NotificationContextValue = {
  addNotification: (input: AddNotificationInput) => void;
  openFlyout: () => void;
};

export const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotify(): NotificationContextValue {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotify must be used inside <AppShell> (NotificationContext.Provider is missing)");
  }
  return context;
}
