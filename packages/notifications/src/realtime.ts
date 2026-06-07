import "server-only";

import { EventEmitter } from "node:events";
import { Client } from "pg";

import { getNotificationsHostAdapters } from "./host-adapters";

// ---------------------------------------------------------------------------
// Realtime notifications fanout.
//
// Single process-level pg.Client subscribes once to the `cinatra_notifications`
// LISTEN channel. The trigger in the host's src/lib/drizzle-store.ts publishes
//   { "userId": "...", "id": "..." }
// on every INSERT into cinatra.notifications. This module parses the payload
// and emits an in-process EventEmitter event keyed by userId so per-tab SSE
// route handlers (src/app/api/notifications/stream/route.ts) can subscribe
// without each opening their own pg connection.
//
// Resilience:
//   - The listener client auto-reconnects with exponential backoff on
//     `error` or `end`. SSE handlers stay connected to the emitter; they
//     just briefly miss events during a reconnect window.
//   - The hybrid client falls back to the 60s polling backstop in the
//     app shell if the SSE socket itself drops.
//   - Per-tab subscribe/unsubscribe is cheap: register a listener on a
//     channel-typed EventEmitter, return a cleanup function.
//
// State:
//   - One pg.Client per Node process. `globalThis.__cinatraNotificationsRealtime`
//     is PACKAGE-OWNED singleton state (survives Turbopack HMR module
//     re-evaluation) — it is NOT a host-adapter dependency and is
//     intentionally RETAINED as-is in the moved module. The ONLY host
//     coupling here is the connection string, which IS injected via
//     `getNotificationsHostAdapters()`.
//   - One EventEmitter shared across all SSE handlers in the process.
//
// Why no per-user channels: PostgreSQL identifier limit is 63 bytes; better-
// auth user ids are text (not a hard UUID contract); `LISTEN` cannot be
// parameterised and identifier quoting is fragile. One channel + in-process
// fanout is strictly simpler and per-payload routing is O(listeners on that
// user-id) which is small per process.
// ---------------------------------------------------------------------------

const CHANNEL = "cinatra_notifications";

type NotificationEvent = { id: string };

declare global {
  var __cinatraNotificationsRealtime:
    | {
        emitter: EventEmitter;
        client: Client | null;
        connecting: Promise<void> | null;
        reconnectAttempt: number;
        disposed: boolean;
      }
    | undefined;
}

function getState() {
  if (!globalThis.__cinatraNotificationsRealtime) {
    const emitter = new EventEmitter();
    // SSE handlers + the listener can all attach — bump from the default 10
    // so a single dev session with multiple tabs doesn't trip the warning.
    emitter.setMaxListeners(0);
    globalThis.__cinatraNotificationsRealtime = {
      emitter,
      client: null,
      connecting: null,
      reconnectAttempt: 0,
      disposed: false,
    };
  }
  return globalThis.__cinatraNotificationsRealtime;
}

function eventKey(userId: string): string {
  return `notification:${userId}`;
}

async function connectListener(): Promise<void> {
  const state = getState();
  if (state.disposed) return;
  if (state.client) return;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    const client = new Client({
      connectionString:
        getNotificationsHostAdapters().getPostgresConnectionString(),
      application_name: "cinatra-notifications-listener",
    });

    client.on("error", (err) => {
      console.warn(
        "[notifications/realtime] listener client error — scheduling reconnect:",
        err instanceof Error ? err.message : err,
      );
      void scheduleReconnect();
    });

    client.on("end", () => {
      // `end` fires when the connection closes for any reason. We only need
      // to reconnect if we didn't dispose() intentionally.
      if (!state.disposed) {
        void scheduleReconnect();
      }
    });

    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL) return;
      const payload = msg.payload;
      if (!payload) return;
      let parsed: { userId?: unknown; id?: unknown } | null = null;
      try {
        parsed = JSON.parse(payload) as { userId?: unknown; id?: unknown };
      } catch {
        return;
      }
      if (
        typeof parsed?.userId !== "string" ||
        typeof parsed?.id !== "string"
      ) {
        return;
      }
      const event: NotificationEvent = { id: parsed.id };
      state.emitter.emit(eventKey(parsed.userId), event);
    });

    await client.connect();
    await client.query(`LISTEN ${quoteIdent(CHANNEL)}`);
    state.client = client;
    state.reconnectAttempt = 0;
    state.connecting = null;
    console.info("[notifications/realtime] listener connected (LISTEN cinatra_notifications)");
  })().catch((err) => {
    state.connecting = null;
    console.warn(
      "[notifications/realtime] listener connect failed:",
      err instanceof Error ? err.message : err,
    );
    void scheduleReconnect();
  });

  return state.connecting ?? undefined;
}

async function scheduleReconnect(): Promise<void> {
  const state = getState();
  if (state.disposed) return;
  // Drop the old client (best-effort).
  const old = state.client;
  state.client = null;
  if (old) {
    try {
      old.removeAllListeners();
      await old.end().catch(() => undefined);
    } catch {
      // ignore
    }
  }
  if (state.connecting) return;
  state.reconnectAttempt += 1;
  // Exponential backoff capped at 30s.
  const delayMs = Math.min(30_000, 500 * 2 ** Math.min(state.reconnectAttempt, 6));
  setTimeout(() => {
    if (state.disposed) return;
    void connectListener();
  }, delayMs);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Subscribe to insert-time notifications for a single user.
 * Returns a cleanup function that unsubscribes the listener and is safe to
 * call from a request abort handler.
 *
 * The first subscriber lazily starts the process-level pg listener.
 */
export function subscribeUserNotifications(
  userId: string,
  cb: (event: NotificationEvent) => void,
): () => void {
  if (!userId) return () => {};
  const state = getState();
  state.emitter.on(eventKey(userId), cb);
  void connectListener();
  return () => {
    state.emitter.off(eventKey(userId), cb);
  };
}

/**
 * Test-only — synchronously emit an event into the in-process emitter.
 * Used by SSE route tests to drive the stream without round-tripping
 * through Postgres. Not exported from any production callsite.
 */
export function __emitForTest(
  userId: string,
  event: NotificationEvent,
): void {
  getState().emitter.emit(eventKey(userId), event);
}

/**
 * Test/dev-only — tear down the listener and emitter. Useful in vitest
 * isolation. Production callers should not invoke this; the singleton lives
 * for the process lifetime.
 */
export async function __disposeForTest(): Promise<void> {
  const state = getState();
  state.disposed = true;
  state.emitter.removeAllListeners();
  if (state.client) {
    try {
      await state.client.end();
    } catch {
      // ignore
    }
    state.client = null;
  }
  globalThis.__cinatraNotificationsRealtime = undefined;
}
