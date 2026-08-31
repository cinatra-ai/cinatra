/**
 * The connecting socket's peer address, made readable from inside a route
 * handler.
 *
 * WHY THIS EXISTS. A route handler receives a Fetch-API `Request`, which
 * carries headers and a URL and nothing about the TCP connection that
 * delivered it. Every "is this caller local?" signal reachable from that object
 * — the URL authority, `Host`, the forwarded chain — is written by whoever is
 * speaking. The one fact a caller cannot write is the address at the other end
 * of the socket, and this module is the only place that reads it.
 *
 * HOW. `installLocalConnectionCapture()` wraps `http.Server.prototype.emit` so
 * that every `"request"` event runs inside an `AsyncLocalStorage` context
 * carrying `socket.remoteAddress`. The store is established BEFORE any listener
 * runs, so it is in scope for the whole asynchronous request pipeline —
 * exactly as the framework's own per-request context is — and a handler reads
 * it with `getLocalConnectionPeer()`.
 *
 * IT ALSO SNAPSHOTS THE FORWARDED HEADERS AT INGRESS, and that is not an extra
 * convenience — it is the only place the question can be asked truthfully. The
 * development server SYNTHESISES `x-forwarded-for` / `-host` / `-proto` on the
 * way into a route handler (measured, and written down in
 * `src/lib/test-support/lifecycle-seed-fence.ts`), so by the time a handler
 * reads its `Request` headers the chain is ALWAYS there and says nothing about
 * a proxy. Asked here — on the raw `IncomingMessage`, before the framework has
 * touched it — the answer is the truth about what the caller actually sent.
 *
 * The capture is a READ. It never mutates the request, never adds a header, and
 * never changes what any listener receives, so nothing downstream can be
 * spoofed into or out of it: a client has no way to write an
 * `AsyncLocalStorage` frame.
 *
 * FAIL-CLOSED. `getLocalConnectionPeer()` returns `null` when no capture is in
 * scope — the hook was never installed, or the request did not arrive over a
 * Node HTTP server. A `null` peer is NOT loopback, so every consumer refuses.
 * Installation is skipped entirely in production builds: the only consumer is
 * the development admin bypass, which is itself off in production.
 *
 * The storage lives in a `globalThis` slot keyed by a registered symbol so a
 * bundler that emits more than one copy of this module (the boot graph and the
 * route graph are compiled separately) still shares ONE context.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";

import { hasForwardedHeader } from "./dev-admin-bypass";

/** What the capture records about a connection, as it arrived. */
export type LocalConnectionInfo = {
  /** `socket.remoteAddress` as the runtime reported it, or null. */
  remoteAddress: string | null;
  /**
   * Whether the request carried ANY forwarded header AS IT ARRIVED — read off
   * the raw `IncomingMessage` at ingress, before the framework synthesises its
   * own chain. This is the only truthful reading of that question; see the
   * module header.
   */
  forwardedHeaderPresent: boolean;
};

type CaptureSlot = {
  storage: AsyncLocalStorage<LocalConnectionInfo>;
  installed: boolean;
};

const SLOT_KEY = Symbol.for("cinatra.mcp-server.local-connection-capture");

function captureSlot(): CaptureSlot {
  const registry = globalThis as unknown as Record<symbol, CaptureSlot | undefined>;
  let slot = registry[SLOT_KEY];
  if (!slot) {
    slot = { storage: new AsyncLocalStorage<LocalConnectionInfo>(), installed: false };
    registry[SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Install the peer capture on the Node HTTP server prototype. Idempotent —
 * a second call is a no-op and returns false. Patching the PROTOTYPE (rather
 * than one server instance) means the capture covers every server this process
 * creates, whenever it is created.
 *
 * Returns true when this call performed the installation.
 */
export function installLocalConnectionCapture(env = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  const slot = captureSlot();
  if (slot.installed) return false;
  slot.installed = true;

  const serverPrototype = http.Server.prototype as unknown as {
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  const originalEmit = serverPrototype.emit;

  serverPrototype.emit = function capturingEmit(
    this: unknown,
    event: string,
    ...args: unknown[]
  ): boolean {
    if (event !== "request") {
      return originalEmit.call(this, event, ...args);
    }
    const incoming = args[0] as
      | {
          socket?: { remoteAddress?: string | null } | null;
          headers?: Record<string, unknown> | null;
        }
      | undefined;
    const rawHeaders = incoming?.headers ?? null;
    const info: LocalConnectionInfo = {
      remoteAddress: incoming?.socket?.remoteAddress ?? null,
      // Presence at INGRESS, through the SAME predicate the policy exports, so
      // the header set has one definition. A header the framework adds later is
      // not the caller's; a header the caller sent is here whatever it says.
      forwardedHeaderPresent:
        rawHeaders != null &&
        hasForwardedHeader({
          get: (name: string) => {
            const value = rawHeaders[name.toLowerCase()];
            if (value === undefined || value === null) return null;
            return Array.isArray(value) ? (value[0] ?? null) : String(value);
          },
        }),
    };
    return slot.storage.run(info, () => originalEmit.call(this, event, ...args));
  };

  return true;
}

/**
 * The peer address of the socket that delivered the in-flight request, or null
 * when it is not knowable here. Null is the fail-closed answer: it is not a
 * loopback address, so every trust decision that reads it refuses.
 */
export function getLocalConnectionPeer(): string | null {
  return captureSlot().storage.getStore()?.remoteAddress ?? null;
}

/**
 * The whole ingress snapshot for the in-flight request, or null when there is
 * none. Null is the fail-closed answer and every consumer must treat it as
 * such: an unknown peer AND an assumed forwarded hop.
 */
export function getLocalConnectionInfo(): LocalConnectionInfo | null {
  return captureSlot().storage.getStore() ?? null;
}

/**
 * Run `fn` with an explicit connection context. The capture hook uses this for
 * real connections; tests use it to drive a handler under a chosen peer without
 * opening a socket.
 */
export function runWithLocalConnection<T>(
  info: LocalConnectionInfo,
  fn: () => T,
): T {
  return captureSlot().storage.run(info, fn);
}
