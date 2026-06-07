// SSE endpoint for real-time notifications flyout updates.
//
// Connects the per-tab EventSource to the process-level pg LISTEN client
// in src/lib/notifications/realtime.ts. Per-user fanout happens in process
// (NOT via per-user LISTEN channels) — see the long-form comment in
// realtime.ts for rationale.
//
// Contract:
//   - Requires a better-auth session. 401 without one.
//   - On NOTIFY for the session's userId, re-reads the notification row
//     (scoped to user_id = session.user.id), then emits an SSE `event: notification`
//     with `data: <AppNotification JSON>`.
//   - Heartbeat comment every 25s to defeat idle-proxy timeouts.
//   - 30-minute soft max lifetime so logout/session revocation eventually
//     re-auths via reconnect.
//   - Cleans up on request.signal abort.
//
// Hybrid fallback: the client (app-shell.tsx) still polls /api/notifications
// on visibilitychange/focus and at a 30s backstop interval. If SSE fails,
// the inbox stays usable.

import { NextResponse } from "next/server";

// Side-effect import: this route imports @cinatra-ai/notifications/server
// directly (bypassing the facade), so the host adapters must be registered
// here before the first /server use.
import "@/lib/notifications-host";

import { getAuthSession } from "@/lib/auth-session";
import {
  listNotificationsForUser,
  subscribeUserNotifications,
} from "@cinatra-ai/notifications/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 25_000;
const SOFT_MAX_STREAM_MS = 30 * 60 * 1000;

export async function GET(request: Request) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const encoder = new TextEncoder();
  // Lifecycle handles shared between `start()` and `cancel()` so both the
  // request.signal abort path AND the ReadableStream consumer-cancel path
  // converge on the same cleanup closure.
  const cleanups: Array<() => void> = [];
  let closed = false;
  let close: () => void = () => {
    closed = true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller may already be closed by an abort race.
        }
      };

      close = () => {
        if (closed) return;
        closed = true;
        for (const fn of cleanups) {
          try {
            fn();
          } catch {
            // ignore
          }
        }
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      // Send a ready event so the client can flip from polling to live mode.
      safeEnqueue(`event: ready\ndata: {}\n\n`);

      // Heartbeat (SSE comment lines start with `:`).
      const heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);
      cleanups.push(() => clearInterval(heartbeat));

      // Soft cap on stream lifetime — forces a reconnect so logout / session
      // revocation eventually picks up a 401 and the client falls back to
      // polling for unauthenticated users.
      const lifetimeTimer = setTimeout(close, SOFT_MAX_STREAM_MS);
      cleanups.push(() => clearTimeout(lifetimeTimer));

      // Subscribe to the in-process emitter. Use a synchronous handler that
      // schedules the DB lookup so we don't block the listener loop.
      const unsubscribe = subscribeUserNotifications(userId, (event) => {
        Promise.resolve()
          .then(async () => {
            // Re-read scoped to the session's user_id. This is defence in
            // depth: the trigger payload already carries our userId, but
            // the DB read is the single source of truth and prevents any
            // cross-user mis-attribution if the in-process emitter ever
            // misroutes (e.g. due to a refactor bug).
            const records = listNotificationsForUser(userId);
            const found = records.find((r) => r.id === event.id);
            if (!found) return;
            const payload = JSON.stringify(found);
            safeEnqueue(`event: notification\ndata: ${payload}\n\n`);
          })
          .catch((err) => {
            console.warn(
              "[notifications/stream] failed to push event:",
              err instanceof Error ? err.message : err,
            );
          });
      });
      cleanups.push(unsubscribe);

      // Close when the client disconnects.
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      // ReadableStream consumer cancelled (e.g. tab close without a clean
      // abort). Route through the same close() closure as request.signal.
      // close() is idempotent — calling it twice is safe.
      close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
