"use client";

import { useSyncExternalStore } from "react";

import type { AppNotification } from "./types";
import {
  applySseNotification,
  collapseByJobId,
  getInProgressItems,
  getUnreadItems,
} from "./flyout-state";

// ---------------------------------------------------------------------------
// Shared notifications client store.
//
// The imperative state machine that used to live inline inside
// `NotificationsProvider` (packages/notifications/src/notifications-flyout.tsx):
//   - the 30s poll + focus/visibilitychange refetch,
//   - the open-triggered refetch,
//   - the EventSource/SSE `notification` subscription with the
//     `applySseNotification` dedupe-prepend contract,
//   - the mutation-version optimistic-guard,
//   - `markRead` / `markAllRead` PATCH calls,
//   - the pathname-driven auto-mark-read PATCH,
// now lives here as a single browser-safe store so BOTH the bell flyout
// (until E8 deletes it) and the future `/notifications` v2 page (E7 / #1557)
// read one instance: a mark-read on either surface updates both without a
// reload.
//
// **Browser-safe.** No `server-only` import anywhere in this graph. `fetch`,
// `EventSource`, `window`, and `document` are read from the ambient globals at
// call time (guarded by `typeof` checks exactly as the inline machine did), so
// the module imports cleanly under a node test runner and only touches the DOM
// once `start()` runs in a browser.
//
// The store is deliberately framework-agnostic (a closure with
// `subscribe`/`getSnapshot` + imperative methods). `useNotificationsStore`
// is the thin React binding via `useSyncExternalStore`. This split lets the
// poll/SSE/mark-read contract be characterized directly (importing this
// module) without mounting a component, and lets E7 mount the same instance
// for the page.
// ---------------------------------------------------------------------------

/** Poll cadence for the notifications GET safety-net (also the default
 * revalidate-on-interval for sources with no SSE channel). */
export const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000;

/** The `notifications` API GET/PATCH endpoint. */
const NOTIFICATIONS_ENDPOINT = "/api/notifications";
/** The `AFTER INSERT` SSE channel. */
const NOTIFICATIONS_STREAM_ENDPOINT = "/api/notifications/stream";

/**
 * The reactive slice both the bell and the page read.
 *
 * - `notifications` — the server-polled + SSE-pushed rows (raw; per-surface
 *   derivation via the `flyout-state` helpers stays with the consumer).
 * - `exactUnreadCount` — the exact viewer unread count backed server-side by
 *   `countUnreadForUser` (packages/notifications/src/service.ts). Populated
 *   from an optional `unreadCount` field on the GET payload; **null until an
 *   endpoint serializes it** (see `getExactUnreadCount` below). The bell badge
 *   does NOT read this today — it stays on the loaded-page-derived count
 *   (`getDerivedUnreadCount`) so behavior is byte-identical. E7 decides when
 *   to switch the visible number.
 */
export type NotificationsSnapshot = {
  notifications: AppNotification[];
  exactUnreadCount: number | null;
};

export type NotificationsStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => NotificationsSnapshot;
  /**
   * Attach the live sources: the poll (revalidate-on-interval), the
   * focus/visibilitychange refetch, and the SSE `notification` subscription.
   * Returns a teardown that detaches all of them. Idempotent teardown.
   */
  start: (options?: { pollIntervalMs?: number }) => () => void;
  /** Optimistic mark-one-read + PATCH `{ id }`; bumps the mutation guard. */
  markRead: (id: string) => void;
  /** Optimistic mark-all-read + PATCH `{ all: true }`; bumps the guard. */
  markAllRead: () => void;
  /**
   * Optimistic per-route mark-read + PATCH `{ href }` for every unread row in
   * `rows` whose `href` matches `pathname`. A no-op (no PATCH, no re-render)
   * when no row matches — so it is safe to call from an effect on every
   * render. `rows` is the caller's current snapshot (the same array this
   * store holds); it is the effect's reactive input so a newly-arrived unread
   * row matching the current path is marked read too. Deliberately does NOT
   * bump the mutation guard (mirrors the historical inline effect: a
   * concurrent poll may reconcile it).
   */
  markReadByPathname: (pathname: string, rows: AppNotification[]) => void;
  /**
   * Revalidate-on-decide: a one-shot version-guarded GET reload. E7 calls
   * this after an approval decision (approvals have no SSE channel) so another
   * admin's decision clears rows + badge within the poll window without a
   * reload. Mirrors the historical refresh-on-open path.
   */
  revalidate: () => void;
  // -- Derivation surface (reuses the flyout-state helpers; E7-facing). ------
  /** `collapseByJobId(notifications)` — the All-tab / page list. */
  getCollapsed: () => AppNotification[];
  /** `getUnreadItems(collapseByJobId(notifications), pathname)`. */
  getUnread: (pathname?: string) => AppNotification[];
  /** `getInProgressItems(notifications)` — the In-progress slice. */
  getInProgress: () => AppNotification[];
  /**
   * The loaded-page-derived unread count the bell badge renders today
   * (`getUnreadItems(collapsed, pathname).length`). Capped implicitly by the
   * 200-row per-user list window.
   */
  getDerivedUnreadCount: (pathname?: string) => number;
  /**
   * The exact viewer unread count backed by `countUnreadForUser`. `null` until
   * an endpoint carries it (the GET response shape is an open E7 design
   * question; grounding does not resolve it here). Distinct from
   * `getDerivedUnreadCount`, which caps at the 200-row list window.
   */
  getExactUnreadCount: () => number | null;
};

/**
 * Create a notifications store instance. The bell flyout mounts one per
 * `NotificationsProvider`; E7 reuses the same instance through the provider so
 * bell + page stay in lock-step.
 */
export function createNotificationsStore(): NotificationsStore {
  let notifications: AppNotification[] = [];
  let exactUnreadCount: number | null = null;

  // Opaque mutation counter every optimistic mark-read/mark-all bumps. All GET
  // writers capture it at fetch start and drop their response if it changed —
  // otherwise a slow GET resolving after an optimistic update would silently
  // restore the pre-mutation snapshot.
  let mutationVersion = 0;

  const listeners = new Set<() => void>();

  // useSyncExternalStore requires getSnapshot to return a STABLE reference when
  // nothing changed. The snapshot is rebuilt only when state actually moves.
  let snapshot: NotificationsSnapshot = { notifications, exactUnreadCount };

  function emit(): void {
    snapshot = { notifications, exactUnreadCount };
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): NotificationsSnapshot {
    return snapshot;
  }

  // Accepts a value or a React-style updater. Returning the SAME array
  // reference from an updater is a no-op (no re-render) — this is what keeps
  // an SSE push of a row a poll snapshot already loaded from re-rendering, and
  // is the cross-tab independence invariant pinned by
  // src/lib/notifications/__tests__/flyout-state.test.ts.
  function setNotifications(
    next: AppNotification[] | ((current: AppNotification[]) => AppNotification[]),
  ): void {
    const resolved =
      typeof next === "function" ? next(notifications) : next;
    if (resolved === notifications) return;
    notifications = resolved;
    emit();
  }

  // Commit a fetched GET payload in ONE emit so the row list and the optional
  // exact-unread count never render as a transient split. `unreadCount` is the
  // exact count backed by `countUnreadForUser`; it is optional (E7 wires it) —
  // absent → exactUnreadCount is left unchanged (null today, so the badge stays
  // on the derived count). Always replaces the row list with a fresh array,
  // matching the historical `setNotifications(payload.notifications ?? [])`.
  type LoadedPayload = {
    notifications?: AppNotification[];
    unreadCount?: number;
  } | null;
  function commitLoadedPayload(payload: LoadedPayload): void {
    notifications = payload?.notifications ?? [];
    if (payload && typeof payload.unreadCount === "number") {
      exactUnreadCount = payload.unreadCount;
    }
    emit();
  }

  // The poll variant: skips when the tab is hidden and drops non-ok responses,
  // exactly as the historical `loadNotifications` did. `isCancelled` is the
  // per-`start()` cancellation token (see `start`) so a GET in flight when its
  // lifecycle is torn down can't clobber a later lifecycle's state.
  async function load(isCancelled: () => boolean): Promise<void> {
    if (typeof document !== "undefined" && document.hidden) return;
    const startVersion = mutationVersion;
    try {
      const response = await fetch(NOTIFICATIONS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as LoadedPayload;
      if (!response.ok || isCancelled()) return;
      if (mutationVersion !== startVersion) return;
      commitLoadedPayload(payload);
    } catch {
      // Ignore polling failures — SSE + next focus event will catch up.
    }
  }

  // The revalidate variant (refresh-on-open / revalidate-on-decide): version-
  // guarded, but does NOT gate on tab-hidden or response.ok — mirrors the
  // historical refresh-on-open effect exactly (which carried no cancellation
  // guard, only the mutation-version check).
  function revalidate(): void {
    const startVersion = mutationVersion;
    void fetch(NOTIFICATIONS_ENDPOINT, { method: "GET", cache: "no-store" })
      .then((response) => response.json())
      .then((payload: LoadedPayload) => {
        if (mutationVersion !== startVersion) {
          // A mutation happened after this fetch started — drop the response
          // rather than clobber the optimistic state.
          return;
        }
        commitLoadedPayload(payload);
      })
      .catch(() => {
        // ignore
      });
  }

  function markRead(id: string): void {
    mutationVersion += 1;
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
    void fetch(NOTIFICATIONS_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  function markAllRead(): void {
    mutationVersion += 1;
    const readAt = new Date().toISOString();
    setNotifications((current) =>
      current.map((notification) => ({
        ...notification,
        readAt: notification.readAt ?? readAt,
      })),
    );
    void fetch(NOTIFICATIONS_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
  }

  function markReadByPathname(
    pathname: string,
    rows: AppNotification[],
  ): void {
    const matchingUnread = rows.filter((notification) => {
      if (notification.readAt || !notification.href) return false;
      return (
        notification.href === pathname ||
        pathname.startsWith(`${notification.href}/`)
      );
    });
    if (matchingUnread.length === 0) return;
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
    void fetch(NOTIFICATIONS_ENDPOINT, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ href: pathname }),
    });
  }

  function start(options?: { pollIntervalMs?: number }): () => void {
    // Per-`start()` cancellation token. Each lifecycle gets its OWN flag (like
    // the historical per-effect `cancelled` closure) so React Strict Mode's
    // setup → cleanup → setup on this one store instance can't let a torn-down
    // lifecycle's in-flight GET or SSE callback clobber the restarted one.
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    const pollIntervalMs =
      options?.pollIntervalMs ?? NOTIFICATIONS_POLL_INTERVAL_MS;

    void load(isCancelled);
    const interval = window.setInterval(() => {
      void load(isCancelled);
    }, pollIntervalMs);
    const onFocus = (): void => {
      void load(isCancelled);
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
        eventSource = new window.EventSource(NOTIFICATIONS_STREAM_ENDPOINT);
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
  }

  function getCollapsed(): AppNotification[] {
    return collapseByJobId(notifications);
  }

  function getUnread(pathname?: string): AppNotification[] {
    return getUnreadItems(collapseByJobId(notifications), pathname);
  }

  function getInProgress(): AppNotification[] {
    return getInProgressItems(notifications);
  }

  function getDerivedUnreadCount(pathname?: string): number {
    return getUnread(pathname).length;
  }

  function getExactUnreadCount(): number | null {
    return exactUnreadCount;
  }

  return {
    subscribe,
    getSnapshot,
    start,
    markRead,
    markAllRead,
    markReadByPathname,
    revalidate,
    getCollapsed,
    getUnread,
    getInProgress,
    getDerivedUnreadCount,
    getExactUnreadCount,
  };
}

/**
 * React binding: subscribe a component to a store instance and return its
 * reactive snapshot. Server render returns the empty initial snapshot (the
 * inline machine started from `useState([])`), so there is no hydration
 * mismatch. Poll/SSE attach client-side via `store.start()`.
 */
export function useNotificationsStore(
  store: NotificationsStore,
): NotificationsSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
