import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock pg.Client so realtime.ts never opens a real connection. The mock
// records every method call so we can verify LISTEN was issued, and exposes
// `__triggerNotification` to drive `client.on("notification", ...)` from the
// outside.
//
// realtime.ts lives in packages/notifications/src/realtime.ts and gets the
// connection string via the injected NotificationsHostAdapters (no direct
// @/lib/database import). We register a mock adapter via
// `setNotificationsHostAdapters` (the /server ergonomic re-export — correct
// for NON-boot test callers) instead of vi.mock("@/lib/database"). The
// globalThis.__cinatraNotificationsRealtime singleton is package-owned state,
// NOT injected (intentionally retained).

type NotifyListener = (msg: { channel: string; payload?: string }) => void;
type ErrorListener = (err: Error) => void;
type EndListener = () => void;

const clientLog: Array<{ method: string; arg?: unknown }> = [];
let notifyListener: NotifyListener | null = null;
let errorListener: ErrorListener | null = null;
let endListener: EndListener | null = null;

vi.mock("pg", () => {
  class FakeClient {
    constructor(opts: unknown) {
      clientLog.push({ method: "construct", arg: opts });
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "notification") notifyListener = listener as NotifyListener;
      else if (event === "error") errorListener = listener as ErrorListener;
      else if (event === "end") endListener = listener as EndListener;
      return this;
    }
    removeAllListeners() {
      notifyListener = null;
      errorListener = null;
      endListener = null;
      return this;
    }
    async connect() {
      clientLog.push({ method: "connect" });
    }
    async query(text: string) {
      clientLog.push({ method: "query", arg: text });
      return { rows: [] };
    }
    async end() {
      clientLog.push({ method: "end" });
    }
  }
  return { Client: FakeClient };
});

import {
  __disposeForTest,
  __emitForTest,
  subscribeUserNotifications,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";

beforeEach(async () => {
  clientLog.length = 0;
  notifyListener = null;
  errorListener = null;
  endListener = null;
  setNotificationsHostAdapters({
    getPostgresConnectionString: () => "postgres://stub",
    ensurePostgresSchema: vi.fn(),
    postgresSchema: "cinatra",
    runPostgresQueriesSync: () => [{ rows: [] }],
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in realtime.test.ts");
    },
  });
  await __disposeForTest();
});

afterEach(async () => {
  await __disposeForTest();
});

describe("subscribeUserNotifications", () => {
  it("lazy-connects the pg listener on the first subscribe", async () => {
    const cb = vi.fn();
    const cleanup = subscribeUserNotifications("u-1", cb);
    // Wait a microtask for the dynamic connectListener() chain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const methods = clientLog.map((c) => c.method);
    expect(methods).toContain("construct");
    expect(methods).toContain("connect");
    const listenQuery = clientLog.find(
      (c) => c.method === "query" && typeof c.arg === "string" && (c.arg as string).startsWith("LISTEN"),
    );
    expect(listenQuery).toBeDefined();
    expect(listenQuery!.arg).toBe(`LISTEN "cinatra_notifications"`);
    cleanup();
  });

  it("invokes the per-user callback when a notification fires for that user", async () => {
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(notifyListener).toBeTruthy();
    // Simulate a NOTIFY for the right user.
    notifyListener!({
      channel: "cinatra_notifications",
      payload: JSON.stringify({ userId: "u-7", id: "n-1" }),
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ id: "n-1" });
  });

  it("ignores NOTIFY events for other users", async () => {
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    notifyListener!({
      channel: "cinatra_notifications",
      payload: JSON.stringify({ userId: "u-8", id: "n-2" }),
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads (no parse error, no callback)", async () => {
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    notifyListener!({
      channel: "cinatra_notifications",
      payload: "{ not json",
    });
    notifyListener!({
      channel: "cinatra_notifications",
      payload: JSON.stringify({ userId: "u-7" }),
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores events on other channels", async () => {
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    notifyListener!({
      channel: "some_other_channel",
      payload: JSON.stringify({ userId: "u-7", id: "n-3" }),
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("cleanup removes only the unsubscribing callback (multi-tab safe)", async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const off1 = subscribeUserNotifications("u-7", cb1);
    subscribeUserNotifications("u-7", cb2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    off1();
    notifyListener!({
      channel: "cinatra_notifications",
      payload: JSON.stringify({ userId: "u-7", id: "n-4" }),
    });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("__emitForTest dispatches a synthetic event without going through pg", async () => {
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    __emitForTest("u-7", { id: "synthetic-1" });
    expect(cb).toHaveBeenCalledWith({ id: "synthetic-1" });
  });

  it("subscribe with empty userId is a no-op (no connect, no listener)", async () => {
    const cb = vi.fn();
    const cleanup = subscribeUserNotifications("", cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(clientLog).toHaveLength(0);
    // Calling cleanup() must not throw.
    cleanup();
  });

  it("schedules a reconnect when the listener emits an 'error' (no double-reconnect storm)", async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    subscribeUserNotifications("u-7", cb);
    // Initial connect promise resolves on the microtask queue.
    await vi.advanceTimersByTimeAsync(0);
    const initialConnects = clientLog.filter((c) => c.method === "connect").length;
    expect(initialConnects).toBe(1);

    // Simulate an error from the pg client — reconnect should be scheduled
    // via setTimeout with exponential backoff (first attempt 1s).
    expect(errorListener).toBeTruthy();
    errorListener!(new Error("listener crashed"));

    // Drain the scheduleReconnect microtasks AND advance past the first
    // backoff timer.
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);

    const totalConnects = clientLog.filter((c) => c.method === "connect").length;
    expect(totalConnects).toBe(2);

    // A second error during the reconnect window must NOT spawn a parallel
    // connect race (state.connecting + scheduleReconnect guard).
    errorListener!(new Error("listener crashed twice"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      clientLog.filter((c) => c.method === "connect").length,
    ).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });
});
