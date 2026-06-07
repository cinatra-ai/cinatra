"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { Bell, Copy } from "lucide-react";
// Copy is used by NotificationRow's per-row copy button. The toast-side
// copy button is auto-injected by `@/lib/toast`.

import type { AppNotification } from "./types";
import {
  applySseNotification,
  collapseByJobId,
  getInProgressItems,
  getUnreadItems,
  isRunningProgressNotification,
} from "./flyout-state";
import {
  NotificationContext,
  type AddNotificationInput,
  type NotificationContextValue,
} from "@/context/notification-context";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
// - `NotificationsProvider` — owns the notification state machine
//   (polling + SSE + ephemeral merge + per-route mark-as-read) and
//   provides both the public `NotificationContext` (consumed by
//   `useNotify()` for toast-from-forms) and an internal
//   `NotificationsStateContext` consumed by `NotificationsBellTrigger`.
// - `NotificationsBellTrigger` — the bell icon + popover. Rendered in
//   `app-shell.tsx`'s header.
// - `useNotificationsState` — internal context hook for the bell trigger
//   (not exported from the package surface; lives in this module only).
// ---------------------------------------------------------------------------

const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000;

// Opaque mutation counter the refresh-on-open effect bumps past so a slow GET
// response can't clobber an optimistic markRead / markAllRead update that
// fired after the GET started.
function useNotificationsMutationVersion(): MutableRefObject<number> {
  const ref = useRef<number>(0);
  return ref;
}

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
// Provider — owns the notification state machine.
// ---------------------------------------------------------------------------

export function NotificationsProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [ephemeralNotifications, setEphemeralNotifications] = useState<
    AppNotification[]
  >([]);
  const [open, setOpen] = useState(false);

  // Version counter every mutation bumps. ALL GET writers (polling,
  // focus/visibility, refresh-on-open) capture the version at fetch start and
  // drop their response if the version has changed since — otherwise a slow
  // GET resolving after an optimistic `markRead`/`markAllRead` would silently
  // restore the pre-mutation snapshot.
  const mutationVersionRef = useNotificationsMutationVersion();

  // Merge server-polled + ephemeral, deduping by id, newest first.
  // Ephemeral items survive polling cycles (the polling effect only updates
  // `notifications`, never `ephemeralNotifications`).
  const mergedNotifications = useMemo<AppNotification[]>(() => {
    const serverIds = new Set(notifications.map((n) => n.id));
    const ephemeralNotInServer = ephemeralNotifications.filter(
      (n) => !serverIds.has(n.id),
    );
    return [...ephemeralNotInServer, ...notifications].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }, [notifications, ephemeralNotifications]);

  // -----------------------------------------------------------------------
  // addNotification — ephemeral local notification + sonner toast.
  //
  // This is the `useNotify().addNotification` surface used by every form
  // save path in the app (the "saved successfully" / "save failed" toasts).
  // The toast input is intentionally narrow (`success | error | warning`)
  // `info` rows are server-side only and belong to the In-progress tab, not
  // sonner.
  // -----------------------------------------------------------------------
  const addNotification = useCallback((input: AddNotificationInput) => {
    const notification: AppNotification = {
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: input.title,
      body: input.body,
      kind: input.kind,
      href: input.href,
      createdAt: new Date().toISOString(),
      // Mark ephemeral notifications as already-read — the toast itself is
      // the notification; we don't want the bell badge to light up for
      // items the user already saw.
      readAt: new Date().toISOString(),
    };

    setEphemeralNotifications((previous) =>
      [notification, ...previous].slice(0, 50),
    );

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

  // -----------------------------------------------------------------------
  // Polling (30 s + focus + visibilitychange) + SSE push.
  // -----------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function loadNotifications(): Promise<void> {
      if (typeof document !== "undefined" && document.hidden) return;
      // Capture the mutation version at fetch start. If it changes before
      // the response arrives, an optimistic `markRead` / `markAllRead`
      // happened in the meantime and we drop the response rather than
      // clobber the optimistic state.
      const startVersion = mutationVersionRef.current;
      try {
        const response = await fetch("/api/notifications", {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | { notifications?: AppNotification[] }
          | null;
        if (!response.ok || cancelled) return;
        if (mutationVersionRef.current !== startVersion) return;
        setNotifications(payload?.notifications ?? []);
      } catch {
        // Ignore polling failures — SSE + next focus event will catch up.
      }
    }

    void loadNotifications();
    const interval = window.setInterval(
      loadNotifications,
      NOTIFICATIONS_POLL_INTERVAL_MS,
    );
    const onFocus = (): void => {
      void loadNotifications();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    // SSE pushes new notifications into the same `notifications` state the
    // poll fills, so the UI works identically whether the data arrived via
    // push or pull. The poll remains the safety net.
    //
    // Native EventSource handles reconnect automatically with the browser's
    // default retry policy; we deliberately do NOT layer manual retry on
    // top — that fights the browser and produces duplicate connections on
    // transient errors.
    let eventSource: EventSource | null = null;
    if (
      typeof window !== "undefined" &&
      typeof window.EventSource === "function"
    ) {
      try {
        eventSource = new window.EventSource("/api/notifications/stream");
        eventSource.addEventListener("notification", (ev) => {
          if (cancelled) return;
          const data = (ev as MessageEvent).data;
          if (typeof data !== "string" || !data) return;
          let parsed: AppNotification | null = null;
          try {
            parsed = JSON.parse(data) as AppNotification;
          } catch {
            return;
          }
          if (!parsed?.id || !parsed?.title) return;
          // Dedupe-prepend via the pure helper. Keeps the multi-tab
          // independence invariant pinned by the regression test at
          // src/lib/notifications/__tests__/flyout-state.test.ts.
          setNotifications((current) => applySseNotification(current, parsed));
        });
        eventSource.addEventListener("error", () => {
          // Native reconnect — polling continues as the fallback.
        });
      } catch {
        eventSource = null;
      }
    }

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // ignore
        }
      }
    };
  }, [mutationVersionRef]);

  // Toast action button event ↔ flyout open.
  useEffect(() => {
    const handler = (): void => setOpen(true);
    document.addEventListener("cinatra:open-notifications", handler);
    return () =>
      document.removeEventListener("cinatra:open-notifications", handler);
  }, []);

  // When the flyout opens, refresh once (the poll cycle may be up to 30 s out).
  // Same version-guard as the polling effect (declared at the top of the
  // Provider) so a slow refresh-on-open response can't clobber an
  // optimistic mark mutation that fired after the fetch started.
  useEffect(() => {
    if (!open) return;
    const startVersion = mutationVersionRef.current;
    void fetch("/api/notifications", { method: "GET", cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { notifications?: AppNotification[] }) => {
        if (mutationVersionRef.current !== startVersion) {
          // A mutation happened after this fetch started — drop the response
          // rather than clobber the optimistic state.
          return;
        }
        setNotifications(payload.notifications ?? []);
      })
      .catch(() => {
        // ignore
      });
  }, [mutationVersionRef, open]);

  // Per-route auto-mark-read: any unread notification whose href matches
  // the current pathname is marked read both locally and via PATCH so the
  // bell badge stays accurate while we navigate.
  //
  // This effect intentionally calls setState inside its body — it's the
  // optimistic local update mirroring the server PATCH so the badge count
  // updates immediately. The early-return on `matchingUnread.length === 0`
  // guarantees idempotence: after the setState fires, the next render's
  // effect sees no matches and exits without re-entering.
  //
  useEffect(() => {
    const matchingUnread = notifications.filter((notification) => {
      if (notification.readAt || !notification.href) return false;
      return (
        notification.href === pathname ||
        pathname.startsWith(`${notification.href}/`)
      );
    });
    if (matchingUnread.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional optimistic mirror of the server PATCH; guarded by early-return above.
    setNotifications((current) =>
      current.map((notification) =>
        matchingUnread.some((item) => item.id === notification.id)
          ? {
              ...notification,
              readAt: notification.readAt ?? new Date().toISOString(),
            }
          : notification,
      ),
    );
    void fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ href: pathname }),
    });
  }, [notifications, pathname]);

  // -----------------------------------------------------------------------
  // Mutations exposed to the bell trigger.
  //
  // Each mutation bumps `mutationVersionRef` so the refresh-on-open guard
  // drops any GET response that started before the mutation. Without this
  // guard, a slow refresh-on-open could resolve AFTER an optimistic update
  // and silently restore the pre-mutation snapshot.
  // -----------------------------------------------------------------------
  const markRead = useCallback((id: string): void => {
    mutationVersionRef.current += 1;
    setNotifications((current) =>
      current.map((notification) =>
        notification.id === id
          ? {
              ...notification,
              readAt: notification.readAt ?? new Date().toISOString(),
            }
          : notification,
      ),
    );
    void fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }, [mutationVersionRef]);

  const markAllRead = useCallback((): void => {
    mutationVersionRef.current += 1;
    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((notification) => ({
        ...notification,
        readAt: notification.readAt ?? readAt,
      })),
    );
    void fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
  }, [mutationVersionRef]);

  const stateValue = useMemo<NotificationsStateContextValue>(
    () => ({
      notifications: mergedNotifications,
      open,
      setOpen,
      markRead,
      markAllRead,
    }),
    [mergedNotifications, open, markRead, markAllRead],
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
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
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
              emptyTitle="No notifications yet"
              emptyDescription="Saved settings, finished jobs, and admin updates will show up here."
            />
          </TabsContent>
          <TabsContent value="unread">
            <NotificationList
              items={unread}
              currentPathname={pathname}
              onSelect={onOpenNotification}
              emptyTitle="You're all caught up"
              emptyDescription="No unread notifications."
            />
          </TabsContent>
          <TabsContent value="in-progress">
            <NotificationList
              items={inProgress}
              currentPathname={pathname}
              onSelect={onOpenNotification}
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
  emptyTitle,
  emptyDescription,
}: {
  items: AppNotification[];
  currentPathname: string;
  onSelect: (n: AppNotification) => void;
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
}: {
  notification: AppNotification;
  currentPathname: string;
  onSelect: (n: AppNotification) => void;
}): React.ReactElement {
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
      <button
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
      </button>
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
