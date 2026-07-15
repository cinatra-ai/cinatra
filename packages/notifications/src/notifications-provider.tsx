"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Bell } from "lucide-react";

import type { AppNotification } from "./types";
import { collapseByJobId, getUnreadItems } from "./flyout-state";
import {
  createNotificationsStore,
  useNotificationsStore,
} from "./notifications-store";
import {
  NotificationContext,
  type AddNotificationInput,
  type NotificationContextValue,
} from "@/context/notification-context";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";

// ---------------------------------------------------------------------------
// Top-navbar notifications bell — badge + link, no flyout.
//
// The bell flyout (packages/notifications/src/notifications-flyout.tsx) was
// retired in the E8 cutover (cinatra#1558) per the ratified notifications
// design spec §IV ("The bell — badge + link, no flyout") and §VII. The bell is
// now a badge and a link and nothing more: it renders the unread count and
// links to `/notifications`; it opens no popover, dropdown, or inline list. The
// only in-place notifications UI is the `/notifications` page.
//
// This module keeps the two non-flyout responsibilities the old provider owned:
//   - `NotificationsProvider` wires the public `NotificationContext` consumed by
//     `useNotify()` (form-save toasts — a pure toast call that writes no
//     bell-visible state), starts the shared E6 client store (30s poll + SSE +
//     focus refetch), and runs the per-route auto-mark-read that keeps the badge
//     accurate as the viewer navigates. It exposes the store's reactive rows +
//     the server-resolved actionable-approvals count to the bell via an internal
//     context.
//   - `NotificationsBellTrigger` renders the bell badge + link in the header.
//
// BADGE (spec §IV — "the badge counts what needs the viewer"): the count is the
// viewer's unread notifications (the E6 store's derived count) PLUS the viewer's
// Inbox-actionable approval count (`approvalsNeedsActionCount`, resolved
// server-side in the root layout across the ApprovalSource registry and passed
// in as a prop). Folding the approvals count in is what makes a pending approval
// that needs the viewer's DECISION visible on the bell — the signal the retired
// sidebar Approvals pill used to carry (§VII moved it here). The approvals half
// is server-rendered (approvals have no client SSE), so it refreshes on
// navigation / route revalidation (the decide server action revalidates the root
// layout); the notifications half stays real-time via the store.
// ---------------------------------------------------------------------------

type NotificationsStateContextValue = {
  notifications: AppNotification[];
  approvalsNeedsActionCount: number;
};

const NotificationsStateContext =
  createContext<NotificationsStateContextValue | null>(null);

function useNotificationsState(): NotificationsStateContextValue {
  const ctx = useContext(NotificationsStateContext);
  if (!ctx) {
    throw new Error(
      "NotificationsBellTrigger must be rendered inside <NotificationsProvider>",
    );
  }
  return ctx;
}

export function NotificationsProvider({
  children,
  approvalsNeedsActionCount = 0,
}: {
  children: ReactNode;
  /**
   * The viewer's Inbox-actionable approval count, resolved server-side in the
   * root layout across the ApprovalSource registry. Combined with the store's
   * unread count to drive the bell badge (spec §IV).
   */
  approvalsNeedsActionCount?: number;
}): React.ReactElement {
  const pathname = usePathname();

  // The shared E6 client store owns the imperative state machine (30s poll +
  // focus/visibility + SSE subscribe with dedupe, the mutation-version guard,
  // mark-read/mark-all/per-route PATCH). One instance per provider; the bell
  // below reads its reactive rows to derive the badge. The `/notifications`
  // page (E7) is server-rendered and manages its own state, so it does not
  // read this instance.
  const [store] = useState(() => createNotificationsStore());
  const { notifications } = useNotificationsStore(store);

  // -----------------------------------------------------------------------
  // addNotification — a pure sonner toast call (the `useNotify().addNotification`
  // surface used by every form-save path). Fires a toast and nothing else: it
  // does NOT mutate any bell-visible state or light the badge. The bell renders
  // only server-polled/SSE-pushed rows.
  // -----------------------------------------------------------------------
  const addNotification = useCallback((input: AddNotificationInput) => {
    const toastFn =
      input.kind === "error"
        ? toast.error
        : input.kind === "warning"
          ? toast.warning
          : toast.success;

    // `@/lib/toast` auto-injects a copy-to-clipboard button into every toast
    // description. Pass the body as a plain string so the wrapper builds the
    // correct `title\nbody` copy text.
    toastFn(input.title, input.body ? { description: input.body } : undefined);
  }, []);

  const notifyContextValue = useMemo<NotificationContextValue>(
    () => ({ addNotification }),
    [addNotification],
  );

  // Attach the store's live sources on mount (poll + focus refetch + SSE); the
  // returned teardown detaches them on unmount.
  useEffect(() => store.start(), [store]);

  // Per-route auto-mark-read: mark read (locally + PATCH) any unread row whose
  // href matches the current pathname so the bell badge stays accurate while we
  // navigate. `markReadByPathname` early-returns when nothing matches, which
  // makes it safe to run on every render.
  useEffect(() => {
    store.markReadByPathname(pathname, notifications);
  }, [store, pathname, notifications]);

  const stateValue = useMemo<NotificationsStateContextValue>(
    () => ({ notifications, approvalsNeedsActionCount }),
    [notifications, approvalsNeedsActionCount],
  );

  return (
    <NotificationContext.Provider value={notifyContextValue}>
      <NotificationsStateContext.Provider value={stateValue}>
        {children}
      </NotificationsStateContext.Provider>
    </NotificationContext.Provider>
  );
}

export function NotificationsBellTrigger(): React.ReactElement {
  const { notifications, approvalsNeedsActionCount } = useNotificationsState();
  const pathname = usePathname();

  // Notifications half — the loaded-page-derived unread count (rows whose href
  // matches the current path are treated as read so the badge stays truthful as
  // we navigate). Approvals half — the server-resolved actionable-approvals
  // count. The badge is their sum: "what needs the viewer" (§IV).
  const collapsed = useMemo(() => collapseByJobId(notifications), [notifications]);
  const unread = useMemo(
    () => getUnreadItems(collapsed, pathname),
    [collapsed, pathname],
  );
  const totalForBadge = unread.length + approvalsNeedsActionCount;
  const unreadHasError = unread.some((n) => n.kind === "error");
  const label =
    totalForBadge > 0
      ? `Notifications, ${totalForBadge} need your attention`
      : "Notifications";

  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="relative rounded-full"
    >
      <Link href="/notifications" aria-label={label}>
        <Bell className="h-5 w-5" />
        {totalForBadge > 0 ? (
          <Badge
            variant={unreadHasError ? "destructive" : "default"}
            className="absolute -right-1 -top-1 min-w-5 px-1 text-badge-xs"
          >
            {totalForBadge > 99 ? "99+" : totalForBadge}
          </Badge>
        ) : null}
      </Link>
    </Button>
  );
}
