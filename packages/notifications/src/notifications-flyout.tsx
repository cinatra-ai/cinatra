"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Bell, Copy, TriangleAlert } from "lucide-react";
// Copy is used by NotificationRow's per-row copy button. The toast-side
// copy button is auto-injected by `@/lib/toast`. TriangleAlert is the
// config-needs entry's warning glyph (mirrors the card needs-review strip).

import type { AppNotification } from "./types";
import {
  collapseByJobId,
  getInProgressItems,
  getUnreadItems,
  isRunningProgressNotification,
  isConfigurationNeedsNotification,
  getConfigurationNeedsMetadata,
  type ConfigurationNeedsConnector,
} from "./flyout-state";
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
import { LayoutButton } from "@/components/ui/layout-button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { IconButton } from "@/components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/cinatra-toast";

// ---------------------------------------------------------------------------
// Top-navbar notifications flyout.
//
// The flyout is kept separate from `src/components/app-shell.tsx` so its
// state machine, scrolling constraints, and background-task rendering stay
// localized. In-progress rows arrive through the same notifications path as
// terminal rows; `collapseByJobId` merges them. The UI exposes All / Unread /
// In progress tabs.
//
// Exports:
// - `NotificationsProvider` — CONSUMES the shared notifications client store
//   (`./notifications-store`), which owns the imperative state machine
//   (polling + SSE + mutation-version guard + mark-read/mark-all + per-route
//   mark-as-read). The provider wires the store into both the public
//   `NotificationContext` (consumed by `useNotify()` for toast-from-forms — a
//   pure toast call that never writes bell state) and an internal
//   `NotificationsStateContext` consumed by `NotificationsBellTrigger`. The
//   same store instance is reused by the future `/notifications` v2 page (E7).
// - `NotificationsBellTrigger` — the bell icon + popover. Rendered in
//   `app-shell.tsx`'s header.
// - `useNotificationsState` — internal context hook for the bell trigger
//   (not exported from the package surface; lives in this module only).
// ---------------------------------------------------------------------------

type NotificationsStateContextValue = {
  notifications: AppNotification[];
  open: boolean;
  setOpen: (open: boolean) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNotificationTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleString();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "now";
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    const minutes = Math.floor((diffMs % hour) / minute);
    if (hours <= 0) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    if (minutes <= 0) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  return date.toLocaleString();
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

// ---------------------------------------------------------------------------
// Provider — consumes the shared notifications client store.
// ---------------------------------------------------------------------------

export function NotificationsProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();

  // The shared client store owns the imperative state machine (30s poll +
  // focus/visibility + open-triggered refetch, SSE subscribe with dedupe, the
  // mutation-version optimistic guard, mark-read/mark-all PATCH, and the
  // per-route mark-read PATCH). One instance per provider; the bell below and
  // the future /notifications v2 page (E7) read the same instance. The
  // reactive `notifications` slice is the server-polled/SSE-pushed rows — the
  // only rows the bell renders (`useNotify().addNotification` is a pure toast
  // call and never writes bell state).
  const [store] = useState(() => createNotificationsStore());
  const { notifications } = useNotificationsStore(store);
  const [open, setOpen] = useState(false);

  // -----------------------------------------------------------------------
  // addNotification — a pure sonner toast call.
  //
  // This is the `useNotify().addNotification` surface used by every form
  // save path in the app (the "saved successfully" / "save failed" toasts).
  // It fires a toast and nothing else: it does NOT mutate any bell-visible
  // state, synthesize an `AppNotification` row/id/`readAt`, or light the bell
  // badge. The bell renders ONLY server-polled/SSE-pushed rows. The toast
  // input is intentionally narrow (`success | error | warning`); `info` rows
  // are server-side only and belong to the In-progress tab, not sonner.
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
    // correct `title\nbody` copy text. Passing a JSX description adds a
    // second copy control and makes the wrapper's `textToCopy` fall back to
    // `${title}\n${title}` (the typeof !== "string" branch).
    toastFn(input.title, input.body ? { description: input.body } : undefined);
  }, []);

  const openFlyout = useCallback(() => {
    setOpen(true);
  }, []);

  const notifyContextValue = useMemo<NotificationContextValue>(
    () => ({ addNotification, openFlyout }),
    [addNotification, openFlyout],
  );

  // Attach the store's live sources on mount: the 30s poll +
  // focus/visibilitychange refetch and the SSE `notification` subscription
  // (the dedupe-prepend + mutation-version guard live in the store). The
  // returned teardown detaches all of them on unmount.
  useEffect(() => store.start(), [store]);

  // Toast action button event ↔ flyout open.
  useEffect(() => {
    const handler = (): void => setOpen(true);
    document.addEventListener("cinatra:open-notifications", handler);
    return () =>
      document.removeEventListener("cinatra:open-notifications", handler);
  }, []);

  // When the flyout opens, revalidate once (the poll cycle may be up to 30 s
  // out). The store's version guard drops the response if an optimistic mark
  // mutation fired after the fetch started.
  useEffect(() => {
    if (!open) return;
    store.revalidate();
  }, [open, store]);

  // Per-route auto-mark-read: the store marks read (locally + via PATCH) any
  // unread row whose href matches the current pathname so the bell badge stays
  // accurate while we navigate. `notifications` is the reactive input — the
  // effect re-runs when the store's rows change so a newly-arrived unread row
  // matching the current path is marked read too. `markReadByPathname`
  // early-returns when nothing matches, which guarantees idempotence: after it
  // fires, the next render's rows change re-runs this effect, which finds no
  // matches and exits.
  useEffect(() => {
    store.markReadByPathname(pathname, notifications);
  }, [store, pathname, notifications]);

  const stateValue = useMemo<NotificationsStateContextValue>(
    () => ({
      notifications,
      open,
      setOpen,
      markRead: store.markRead,
      markAllRead: store.markAllRead,
    }),
    [notifications, open, store],
  );

  return (
    <NotificationContext.Provider value={notifyContextValue}>
      <NotificationsStateContext.Provider value={stateValue}>
        {children}
      </NotificationsStateContext.Provider>
    </NotificationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// BellTrigger — bell icon + popover + 3 tabs.
// ---------------------------------------------------------------------------

export function NotificationsBellTrigger(): React.ReactElement {
  const { notifications, open, setOpen, markRead, markAllRead } =
    useNotificationsState();
  const router = useRouter();
  const pathname = usePathname();

  // Derived slices.
  const collapsed = useMemo(() => collapseByJobId(notifications), [notifications]);
  const inProgress = useMemo(
    () => getInProgressItems(notifications),
    [notifications],
  );
  const unread = useMemo(
    () => getUnreadItems(collapsed, pathname),
    [collapsed, pathname],
  );

  const totalForBadge = unread.length;
  const unreadHasError = unread.some((n) => n.kind === "error");

  const onOpenNotification = useCallback(
    (notification: AppNotification): void => {
      setOpen(false);
      if (!notification.readAt) {
        markRead(notification.id);
      }
      if (notification.href) {
        router.push(notification.href);
      }
    },
    [markRead, router, setOpen],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton aria-label="Open notifications" className="relative">
          <Bell className="h-5 w-5" />
          {totalForBadge > 0 ? (
            <Badge
              variant={unreadHasError ? "destructive" : "default"}
              className="absolute -right-1 -top-1 min-w-5 px-1 text-[10px]"
            >
              {totalForBadge > 99 ? "99+" : totalForBadge}
            </Badge>
          ) : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // Keep the explicit z-[200] for the one-off stacking concern with the
        // impersonation banner — see app-shell.tsx <header> sticky z.
        // The shadow uses the tailwind preset `shadow-lg` (was an arbitrary
        // pixel-value shadow).
        className="z-[200] w-[22rem] rounded-control border border-line bg-surface-strong p-2 shadow-lg backdrop-blur-xl"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-kicker-wide text-muted-foreground">
            Notifications
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={markAllRead}
            disabled={unread.length === 0}
            className="h-auto rounded-full px-3 py-1.5 text-[11px] uppercase tracking-[0.15em]"
          >
            Mark all as read
          </Button>
        </div>

        <Tabs defaultValue="all" className="px-1">
          <TabsList className="w-full">
            <TabsTrigger value="all" className="flex-1 gap-1.5">
              All
              {collapsed.length > 0 ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {collapsed.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="unread" className="flex-1 gap-1.5">
              Unread
              {unread.length > 0 ? (
                <Badge
                  variant={unreadHasError ? "destructive" : "default"}
                  className="h-5 px-1.5 text-[10px]"
                >
                  {unread.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="in-progress" className="flex-1 gap-1.5">
              In progress
              {inProgress.length > 0 ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {inProgress.length}
                </Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all">
            <NotificationList
              items={collapsed.slice(0, 10)}
              currentPathname={pathname}
              onSelect={onOpenNotification}
              onCloseFlyout={() => setOpen(false)}
              emptyTitle="No notifications yet"
              emptyDescription="Saved settings, finished jobs, and admin updates will show up here."
            />
          </TabsContent>
          <TabsContent value="unread">
            <NotificationList
              items={unread}
              currentPathname={pathname}
              onSelect={onOpenNotification}
              onCloseFlyout={() => setOpen(false)}
              emptyTitle="You're all caught up"
              emptyDescription="No unread notifications."
            />
          </TabsContent>
          <TabsContent value="in-progress">
            <NotificationList
              items={inProgress}
              currentPathname={pathname}
              onSelect={onOpenNotification}
              onCloseFlyout={() => setOpen(false)}
              emptyTitle="No background tasks running"
              emptyDescription="Jobs you trigger will appear here while they run."
            />
          </TabsContent>
        </Tabs>

        <Separator className="mx-1 mt-1" />
        <div className="px-1 pt-1">
          <Button variant="ghost" className="w-full justify-start" asChild>
            <Link href="/notifications" onClick={() => setOpen(false)}>
              {collapsed.length > 10
                ? "View all notifications"
                : "Open notification archive"}
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Notification row + list (private to this module).
// ---------------------------------------------------------------------------

function NotificationList({
  items,
  currentPathname,
  onSelect,
  onCloseFlyout,
  emptyTitle,
  emptyDescription,
}: {
  items: AppNotification[];
  currentPathname: string;
  onSelect: (n: AppNotification) => void;
  onCloseFlyout: () => void;
  emptyTitle: string;
  emptyDescription: string;
}): React.ReactElement {
  return (
    // Bounded fixed height for small-viewport safety. Plain `h-[22rem]` would
    // overflow short screens; `min(22rem, 100vh - 8rem)` clamps to whatever
    // room the popover has below the header.
    <ScrollArea className="mt-2 h-[min(22rem,calc(100vh-8rem))]">
      {items.length === 0 ? (
        <div className="flex h-full items-center justify-center p-2">
          <Empty className="border-none p-4">
            <EmptyMedia variant="icon">
              <Bell className="size-4" />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
          </Empty>
        </div>
      ) : (
        <div className="grid gap-1 pr-1">
          {items.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              currentPathname={currentPathname}
              onSelect={onSelect}
              onCloseFlyout={onCloseFlyout}
            />
          ))}
        </div>
      )}
    </ScrollArea>
  );
}

function NotificationRow({
  notification,
  currentPathname,
  onSelect,
  onCloseFlyout,
}: {
  notification: AppNotification;
  currentPathname: string;
  onSelect: (n: AppNotification) => void;
  onCloseFlyout: () => void;
}): React.ReactElement {
  // Agent post-install configuration-needs entry (cinatra #1057 ruling (c)):
  // a dedicated row that lists each required connector's displayName as a link
  // to its setup page. Rendered from `metadata.configurationNeeds`, in the same
  // Needs-review mustard treatment as the Extensions-page card strip.
  if (isConfigurationNeedsNotification(notification)) {
    const meta = getConfigurationNeedsMetadata(notification);
    if (meta) {
      return (
        <ConfigurationNeedsRow
          notification={notification}
          connectors={meta.connectors}
          onCloseFlyout={onCloseFlyout}
        />
      );
    }
  }

  const running = isRunningProgressNotification(notification);
  const isReadOrCurrent =
    Boolean(notification.readAt) ||
    (Boolean(notification.href) &&
      (notification.href === currentPathname ||
        currentPathname.startsWith(`${notification.href}/`)));

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-chip px-3 py-3 transition hover:bg-surface-muted",
        isReadOrCurrent
          ? "text-muted-foreground"
          : "bg-surface-muted text-foreground",
      )}
    >
      <LayoutButton
        type="button"
        onClick={() => onSelect(notification)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0 whitespace-normal text-left"
      >
        <div className="flex items-center gap-2">
          {running ? (
            // Use the shadcn `<Spinner>` primitive instead of a hardcoded
            // `bg-blue-500 animate-pulse` dot. Color goes through the
            // semantic `text-info` token instead of the raw Tailwind blue
            // palette.
            <Spinner className="size-3.5 text-info" />
          ) : (
            <span
              className={cn(
                "inline-flex h-2.5 w-2.5 rounded-full",
                notification.kind === "error"
                  ? "bg-destructive"
                  : notification.kind === "warning"
                    ? "bg-warning"
                    : notification.kind === "info"
                      ? "bg-info"
                      : "bg-success",
                notification.readAt ? "opacity-40" : "",
              )}
              aria-hidden="true"
            />
          )}
          <p className="text-sm font-semibold">{notification.title}</p>
        </div>
        {notification.body ? (
          <p className="mt-1 text-sm leading-5">{notification.body}</p>
        ) : null}
        <p className="mt-2 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
          {formatNotificationTimestamp(notification.createdAt)}
        </p>
      </LayoutButton>
      {running ? null : (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy notification message"
          onClick={async () => {
            await copyToClipboard(notification.body);
          }}
          className="h-8 w-8 shrink-0 rounded-full"
        >
          <Copy className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent post-install "needs configuration" row (cinatra #1057 ruling (c)).
//
// One entry per affected agent. The title is the ruling copy
// `Set up connections for "<displayName>":`; the body is the list of each
// required connector's human-readable displayName linking to that connector's
// setup page (never the bare package id). Rendered in the design system's
// Needs-review status colours — the mustard tint (`bg-warning/10`) over the
// mustard ink (`text-warning`) with a mustard hairline (`border-warning/42`) —
// so the bell entry reads the same as the Extensions-page card strip it
// mirrors. The links carry navigation (no whole-row nav button, no copy
// button); each closes the flyout on click. The entry is not marked read on
// interaction — it clears only when the agent becomes runnable, at which point
// the server reconciler deletes it.
// ---------------------------------------------------------------------------
export function ConfigurationNeedsRow({
  notification,
  connectors,
  onCloseFlyout,
}: {
  notification: AppNotification;
  connectors: ConfigurationNeedsConnector[];
  onCloseFlyout: () => void;
}): React.ReactElement {
  return (
    <div
      data-slot="notification-configuration-needs"
      data-conformance="install-config-needs-callout"
      className="flex flex-col gap-2 rounded-chip border border-warning/42 bg-warning/10 px-3 py-3"
    >
      <div className="flex items-start gap-2 text-warning">
        <TriangleAlert
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0"
          strokeWidth={2.25}
        />
        <p className="text-sm font-semibold text-foreground">
          {notification.title}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-xs text-warning">
        {connectors.map((connector, index) => (
          <span key={connector.packageName} className="inline-flex items-center">
            {connector.settingsHref ? (
              <Link
                href={connector.settingsHref}
                data-field="manifest.displayName"
                onClick={onCloseFlyout}
                className="font-semibold underline decoration-warning/50 underline-offset-2 hover:decoration-warning"
              >
                {connector.displayName}
              </Link>
            ) : (
              <span data-field="manifest.displayName" className="font-semibold">
                {connector.displayName}
              </span>
            )}
            {index < connectors.length - 1 && (
              <span aria-hidden className="ml-2 text-warning/60">
                &middot;
              </span>
            )}
          </span>
        ))}
      </div>
      <p className="pl-5 text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
        {formatNotificationTimestamp(notification.createdAt)}
      </p>
    </div>
  );
}
