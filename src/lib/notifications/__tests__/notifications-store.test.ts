// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import {
  createNotificationsStore,
  NOTIFICATIONS_POLL_INTERVAL_MS,
} from "@cinatra-ai/notifications/notifications-store";

// ---------------------------------------------------------------------------
// Characterization tests for the extracted shared notifications client store
// (E6 / #1556). These import the NEW module directly and pin the imperative
// contract the flyout used to own inline: the poll (initial + interval +
// focus/visibilitychange), the SSE `notification` subscription with the
// `applySseNotification` dedupe, the mutation-version optimistic guard,
// markRead / markAllRead / per-route mark-read PATCH shapes, the
// revalidate-on-decide primitive, and the exact-unread accessor.
//
// The store is deliberately framework-agnostic, so it is exercised here
// without mounting a React component — the extraction is proven by a test that
// imports the store, not only by the existing tests written against the old
// inline implementation.
// ---------------------------------------------------------------------------

type FetchInit = { method?: string; body?: string } | undefined;

// A minimal EventSource stand-in (jsdom does not implement EventSource). The
// store reads `window.EventSource`; each constructed instance is captured so a
// test can dispatch a `notification` event into it.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  url: string;
  closed = false;
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  close(): void {
    this.closed = true;
  }
}

function notification(
  overrides: Partial<AppNotification> & Pick<AppNotification, "id">,
): AppNotification {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title ${overrides.id}`,
    body: overrides.body ?? "",
    kind: overrides.kind ?? "info",
    href: overrides.href,
    createdAt: overrides.createdAt ?? "2026-07-15T00:00:00.000Z",
    readAt: overrides.readAt,
    sourceJobId: overrides.sourceJobId,
    metadata: overrides.metadata,
  } as AppNotification;
}

// Drain the microtask queue (the load() await chain: fetch -> json). Fake
// timers do NOT fake promises, so awaiting real microtasks still works.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

let getPayload: { notifications?: AppNotification[]; unreadCount?: number };
let fetchMock: ReturnType<typeof vi.fn>;

function lastPatchBody(): unknown {
  const patchCall = [...fetchMock.mock.calls]
    .reverse()
    .find((call) => (call[1] as FetchInit)?.method === "PATCH");
  if (!patchCall) return undefined;
  return JSON.parse((patchCall[1] as { body: string }).body);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  getPayload = { notifications: [] };
  fetchMock = vi.fn(async (_url: string, init: FetchInit) => {
    if (init?.method === "PATCH") {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => getPayload };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("notifications store — poll", () => {
  it("fetches the notifications list on start and exposes it in the snapshot", async () => {
    getPayload = { notifications: [notification({ id: "a" })] };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith("/api/notifications", {
      method: "GET",
      cache: "no-store",
    });
    expect(store.getSnapshot().notifications.map((n) => n.id)).toEqual(["a"]);
    stop();
  });

  it("re-fetches on the poll interval and on window focus", async () => {
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();
    const afterStart = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterStart);

    const beforeFocus = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("skips the poll fetch while the document is hidden", async () => {
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();
    const afterStart = fetchMock.mock.calls.length;

    const hiddenSpy = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(NOTIFICATIONS_POLL_INTERVAL_MS);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(afterStart);
    hiddenSpy.mockRestore();
    stop();
  });

  it("a torn-down start()'s in-flight GET does not clobber a restarted lifecycle (Strict Mode)", async () => {
    // Lifecycle #1: a GET we hold open, then tear the lifecycle down while it
    // is still in flight (React Strict Mode's setup -> cleanup -> setup on the
    // same persisted store instance).
    let resolveFirst: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void = () => {};
    const firstGet = new Promise<{
      ok: boolean;
      json: () => Promise<unknown>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock.mockImplementation((_url: string, init: FetchInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return firstGet;
    });
    const store = createNotificationsStore();
    const stop1 = store.start();
    stop1(); // teardown lifecycle #1 while its GET is still pending

    // Lifecycle #2: an immediately-resolving GET with fresh data.
    fetchMock.mockImplementation((_url: string, init: FetchInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ notifications: [notification({ id: "second" })] }),
      });
    });
    const stop2 = store.start();
    await flush();
    expect(store.getSnapshot().notifications.map((n) => n.id)).toEqual([
      "second",
    ]);

    // The stale lifecycle-#1 GET now resolves with different data. It must be
    // dropped by the per-start() cancellation token, NOT applied over #2.
    resolveFirst({
      ok: true,
      json: async () => ({
        notifications: [notification({ id: "first-stale" })],
      }),
    });
    await flush();
    expect(store.getSnapshot().notifications.map((n) => n.id)).toEqual([
      "second",
    ]);
    stop2();
  });

  it("notifies subscribers when the list changes and detaches on stop", async () => {
    const store = createNotificationsStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    getPayload = { notifications: [notification({ id: "a" })] };
    const stop = store.start();
    await flush();
    expect(listener).toHaveBeenCalled();

    unsub();
    stop();
    const source = FakeEventSource.instances.at(-1);
    expect(source?.closed).toBe(true);
  });
});

describe("notifications store — SSE", () => {
  it("prepends a pushed notification via applySseNotification and dedupes by id", async () => {
    getPayload = { notifications: [notification({ id: "a" })] };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    const source = FakeEventSource.instances.at(-1);
    expect(source).toBeDefined();
    expect(source?.url).toBe("/api/notifications/stream");

    // New id -> prepended (newest first).
    source?.emit("notification", {
      data: JSON.stringify(notification({ id: "b" })),
    });
    expect(store.getSnapshot().notifications.map((n) => n.id)).toEqual([
      "b",
      "a",
    ]);

    // Same id again -> no-op, snapshot reference is unchanged (no re-render).
    const before = store.getSnapshot();
    source?.emit("notification", {
      data: JSON.stringify(notification({ id: "b" })),
    });
    expect(store.getSnapshot()).toBe(before);
    stop();
  });

  it("ignores malformed SSE payloads (bad JSON / missing id or title)", async () => {
    getPayload = { notifications: [notification({ id: "a" })] };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();
    const source = FakeEventSource.instances.at(-1);
    const before = store.getSnapshot();

    source?.emit("notification", { data: "not-json{" });
    source?.emit("notification", { data: JSON.stringify({ title: "no id" }) });
    source?.emit("notification", { data: JSON.stringify({ id: "x" }) });
    source?.emit("notification", { data: "" });

    expect(store.getSnapshot()).toBe(before);
    stop();
  });
});

describe("notifications store — mutations", () => {
  it("markRead optimistically sets readAt and PATCHes { id }", async () => {
    getPayload = { notifications: [notification({ id: "a" })] };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    store.markRead("a");
    expect(store.getSnapshot().notifications[0]?.readAt).toBeTruthy();
    expect(lastPatchBody()).toEqual({ id: "a" });
    stop();
  });

  it("markAllRead optimistically sets readAt on every row and PATCHes { all: true }", async () => {
    getPayload = {
      notifications: [notification({ id: "a" }), notification({ id: "b" })],
    };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    store.markAllRead();
    expect(store.getSnapshot().notifications.every((n) => n.readAt)).toBe(true);
    expect(lastPatchBody()).toEqual({ all: true });
    stop();
  });

  it("markReadByPathname marks matching unread rows + PATCHes { href }, and no-ops otherwise", async () => {
    const rows = [
      notification({ id: "a", href: "/foo" }),
      notification({ id: "b", href: "/bar" }),
    ];
    getPayload = { notifications: rows };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    const patchesBefore = fetchMock.mock.calls.filter(
      (c) => (c[1] as FetchInit)?.method === "PATCH",
    ).length;

    // No match -> no PATCH, no re-render.
    const before = store.getSnapshot();
    store.markReadByPathname("/unrelated", store.getSnapshot().notifications);
    expect(store.getSnapshot()).toBe(before);
    expect(
      fetchMock.mock.calls.filter(
        (c) => (c[1] as FetchInit)?.method === "PATCH",
      ).length,
    ).toBe(patchesBefore);

    // Match on /foo -> row "a" gets readAt, PATCH { href }.
    store.markReadByPathname("/foo", store.getSnapshot().notifications);
    const snap = store.getSnapshot();
    expect(snap.notifications.find((n) => n.id === "a")?.readAt).toBeTruthy();
    expect(snap.notifications.find((n) => n.id === "b")?.readAt).toBeFalsy();
    expect(lastPatchBody()).toEqual({ href: "/foo" });
    stop();
  });

  it("drops a stale GET whose fetch started before a mark mutation (version guard)", async () => {
    // A deferred GET we resolve manually, to interleave a markRead between the
    // fetch start and its resolution.
    let resolveGet: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void = () => {};
    const deferredGet = new Promise<{
      ok: boolean;
      json: () => Promise<unknown>;
    }>((resolve) => {
      resolveGet = resolve;
    });
    fetchMock.mockImplementation((_url: string, init: FetchInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return deferredGet;
    });

    const store = createNotificationsStore();
    const stop = store.start(); // kicks off the deferred GET
    // Seed a row locally through SSE so markRead has something to flip.
    const source = FakeEventSource.instances.at(-1);
    source?.emit("notification", {
      data: JSON.stringify(notification({ id: "seed" })),
    });

    // Mutation happens while the initial GET is still in flight.
    store.markRead("seed");
    expect(store.getSnapshot().notifications[0]?.readAt).toBeTruthy();

    // Now resolve the stale GET with a snapshot that would clobber the
    // optimistic readAt if the version guard were absent.
    resolveGet({
      ok: true,
      json: async () => ({ notifications: [notification({ id: "seed" })] }),
    });
    await flush();

    // The optimistic readAt survived — the stale GET was dropped.
    expect(store.getSnapshot().notifications[0]?.readAt).toBeTruthy();
    stop();
  });
});

describe("notifications store — revalidate + exact unread + derivations", () => {
  it("revalidate() issues a version-guarded GET reload", async () => {
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();
    const before = fetchMock.mock.calls.length;

    getPayload = { notifications: [notification({ id: "fresh" })] };
    store.revalidate();
    await flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(store.getSnapshot().notifications.map((n) => n.id)).toEqual([
      "fresh",
    ]);
    stop();
  });

  it("exposes exactUnreadCount only when the payload carries unreadCount (null otherwise)", async () => {
    getPayload = { notifications: [notification({ id: "a" })] };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();
    // No unreadCount field on the current endpoint -> stays null (badge uses
    // the derived count; byte-identical).
    expect(store.getExactUnreadCount()).toBeNull();
    expect(store.getSnapshot().exactUnreadCount).toBeNull();

    getPayload = { notifications: [notification({ id: "a" })], unreadCount: 512 };
    store.revalidate();
    await flush();
    expect(store.getExactUnreadCount()).toBe(512);
    stop();
  });

  it("derivation selectors reuse the flyout-state helpers (collapsed/unread/in-progress)", async () => {
    getPayload = {
      notifications: [
        notification({ id: "read", href: "/x", readAt: "2026-07-15T00:00:00.000Z" }),
        notification({ id: "unread", href: "/y" }),
        notification({
          id: "running",
          kind: "info",
          sourceJobId: "job-1",
          metadata: { category: "background_process", progress: { status: "running" } },
        }),
      ],
    };
    const store = createNotificationsStore();
    const stop = store.start();
    await flush();

    expect(store.getCollapsed().length).toBe(3);
    // "read" is read; "running" is in-progress (auto-read); only "unread" counts.
    expect(store.getUnread().map((n) => n.id)).toEqual(["unread"]);
    expect(store.getDerivedUnreadCount()).toBe(1);
    // currentPathname === the unread row's href excludes it from the count.
    expect(store.getDerivedUnreadCount("/y")).toBe(0);
    expect(store.getInProgress().map((n) => n.id)).toEqual(["running"]);
    stop();
  });
});
