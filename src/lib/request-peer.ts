// ---------------------------------------------------------------------------
// THE CONNECTING SOCKET, made readable from a route handler.
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. A route handler is handed a Web `Request`, and a Web
// `Request` knows nothing about the connection it arrived on. Every
// "is this call local?" check in this codebase therefore asked
// `new URL(request.url).hostname` — which is the `Host` HEADER, a string the
// caller writes. A dev server listening on a LAN or container interface answers
// `Host: localhost` from anywhere, so that check separated nothing: it admitted
// any caller polite enough to type the right host name.
//
// The socket's peer address is the fact that header was standing in for, and it
// is available exactly once — at the moment Node's HTTP server accepts the
// request, before any framework code runs. So this module subscribes to Node's
// `http.server.request.start` diagnostics channel and STAMPS the two facts onto
// the incoming request's own header bag, where the handler can read them back:
//
//   x-cinatra-socket-peer      the socket's remote address
//   x-cinatra-client-forwarded the forwarded headers the CLIENT actually sent
//
// Both stamps are written UNCONDITIONALLY, so a caller who sends either header
// has it overwritten before anything reads it. They are outputs of this process,
// never inputs to it.
//
// WHY THE SECOND STAMP — and it is the whole reason the first draft of this
// check "refused everything under the dev server". Next.js normalises the
// forwarded headers on the way into a route handler (next/dist/server/
// base-server.js: `req.headers['x-forwarded-host'] ??= …`, `-port`, `-proto`,
// and `x-forwarded-for ??= originalRequest.socket.remoteAddress`). MEASURED on
// a live dev server on this branch: a plain `curl` that sends no forwarded
// header at all reaches the handler carrying `x-forwarded-for`,
// `x-forwarded-host`, `x-forwarded-port` and `x-forwarded-proto`. A check that
// disqualifies on PRESENCE therefore refuses every request there is — the
// accident that made these routes look guarded while they were merely broken.
//
// Because `??=` only fills a header the client did NOT send, the framework also
// cannot tell the two cases apart afterwards. The stamp is taken BEFORE that
// normalisation, so it records what actually came off the wire — and the policy
// then means what it says: ANY forwarded header the caller sent is a refusal,
// while the ones Next writes for itself are invisible to it.
//
// This module is deliberately dependency-light and holds NO filesystem or
// environment access, so it can be imported from the instrumentation entry point
// and from a bare unit test alike. The per-boot credential lives next door in
// `@/lib/boot-credential`, and the ONE decision the callers take lives in
// `@/lib/local-caller-gate`.
//
// NOTE FOR THE PARALLEL WORK ON `packages/mcp-server/src/dev-admin-bypass.ts`:
// that module's `normalizeHost()` road has the identical defect and is being
// changed on its own branch. This helper is the shared one to adopt — it is
// intentionally free of app imports so any surface can take it.
// ---------------------------------------------------------------------------

import { channel } from "node:diagnostics_channel";

/** The header this process stamps with the connecting socket's peer address. */
export const SOCKET_PEER_HEADER = "x-cinatra-socket-peer";

/** The header this process stamps with the forwarded headers the CLIENT sent. */
export const CLIENT_FORWARDED_HEADER = "x-cinatra-client-forwarded";

/** Written into {@link CLIENT_FORWARDED_HEADER} when the client sent none. A
 *  sentinel rather than an empty value, so "the stamp ran and saw nothing" and
 *  "the stamp never ran" stay distinguishable — the second one has to refuse. */
export const NO_CLIENT_FORWARDED = "none";

/** The forwarded headers named explicitly in the policy. This list DOCUMENTS
 *  the common ones; it is not the rule. The rule is
 *  {@link isForwardedHeaderName}, so a spelling nobody listed here — including
 *  `x-forwarded-port`, which the framework also synthesises — still counts. */
export const FORWARDED_HEADER_NAMES = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "forwarded",
] as const;

/**
 * Is this the name of a header a caller uses to CLAIM it was forwarded?
 *
 * The policy is "ANY forwarded header the caller sent refuses", so this is a
 * SHAPE test rather than a list membership test: the standard `Forwarded`
 * header, and every `x-forwarded-*` spelling there is. A closed list would let
 * an unlisted spelling (`x-forwarded-port`, `x-forwarded-server`, whatever a
 * proxy invents next) through the fence while the policy claimed otherwise.
 * Names arrive from Node already lower-cased; lower-cased again here so a
 * caller of this function cannot be surprised by its own casing.
 */
export function isForwardedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "forwarded" || lower.startsWith("x-forwarded-");
}

/** The shape a `Headers`, a `NextRequest.headers` and a test double all satisfy. */
export type HeaderBag = { get(name: string): string | null };

export type PeerVerdict =
  | { ok: true; peer: string }
  | { ok: false; reason: string };

/**
 * Is this address on this machine?
 *
 * Deliberately narrow: an ADDRESS, never a host name. `localhost` and
 * `host.docker.internal` are names a resolver maps somewhere, and the second one
 * maps OFF this machine from inside a container — both were accepted by the
 * `Host`-header checks this replaces, and neither is accepted here.
 *
 * The whole 127.0.0.0/8 block counts (a resolver stub commonly answers on
 * 127.0.0.53), as do `::1`, its bracketed form, and the IPv4-mapped form Node
 * reports for an IPv4 client on a dual-stack listener.
 */
export function isLoopbackPeerAddress(raw: string): boolean {
  let value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return false;
    value = value.slice(1, close);
  }
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  if (value === "::1") return true;
  // An IPv4 dotted quad in 127.0.0.0/8 — parsed strictly, so no trailing text,
  // no embedded whitespace and no out-of-range octet slips through.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!quad) return false;
  const octets = quad.slice(1).map((part) => Number(part));
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * THE CONNECTION, as this process stamped it.
 *
 * Order matters. The forwarded stamp is read first: a caller that announced a
 * proxy hop is refused whatever its socket says, because the announcement means
 * the request was composed somewhere this process cannot see. An ABSENT stamp is
 * a refusal too — it means the request reached the handler through a path this
 * module never observed, and an unobserved connection proves nothing.
 */
export function socketPeerVerdict(headers: HeaderBag): PeerVerdict {
  const forwarded = headers.get(CLIENT_FORWARDED_HEADER);
  const peer = headers.get(SOCKET_PEER_HEADER);
  if (forwarded === null || peer === null || peer.length === 0) {
    return { ok: false, reason: "socket-peer-not-stamped" };
  }
  if (forwarded !== NO_CLIENT_FORWARDED) {
    return { ok: false, reason: `client-forwarded-header:${forwarded}` };
  }
  if (!isLoopbackPeerAddress(peer)) {
    return { ok: false, reason: "non-loopback-socket-peer" };
  }
  return { ok: true, peer };
}

let installed = false;

/**
 * Subscribe to `http.server.request.start` and stamp every incoming request.
 *
 * Node publishes that channel from inside its own HTTP server, before the
 * `request` event reaches any listener, so the stamp is in place before the
 * framework reads or rewrites a single header.
 *
 * Idempotent: returns `true` the first time and `false` afterwards, so a hot
 * reload cannot pile subscribers onto the channel.
 */
export function installSocketPeerStamp(): boolean {
  if (installed) return false;
  installed = true;
  channel("http.server.request.start").subscribe((message) => {
    const request = (message as { request?: IncomingLike } | undefined)?.request;
    const headers = request?.headers;
    if (!headers) return;
    // Taken BEFORE the framework's own `??=` normalisation — see the header.
    // Read off the request's OWN header names rather than a fixed list, so an
    // unlisted `x-forwarded-*` spelling is caught too (see
    // isForwardedHeaderName). Sorted so the stamp is deterministic.
    const sent = Object.keys(headers)
      .filter((name) => headers[name] !== undefined && isForwardedHeaderName(name))
      .sort();
    // Assigned, never merged: a client-supplied value of either header is
    // destroyed here rather than trusted.
    headers[CLIENT_FORWARDED_HEADER] =
      sent.length === 0 ? NO_CLIENT_FORWARDED : sent.join(",");
    const peer = request.socket?.remoteAddress;
    if (typeof peer === "string" && peer.length > 0) {
      headers[SOCKET_PEER_HEADER] = peer;
    } else {
      // No peer to report (a synthetic or unix-socket request): leave NOTHING
      // behind, so the verdict is "not stamped" rather than a stale claim.
      delete headers[SOCKET_PEER_HEADER];
    }
  });
  return true;
}

/** The slice of Node's IncomingMessage this module touches. */
type IncomingLike = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
};
