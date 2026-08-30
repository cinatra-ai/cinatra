/**
 * Dev-only MCP admin bypass policy.
 *
 * When every guard below passes, the MCP request store's `platformRole` is
 * forced to `"platform_admin"`, letting admin-gated handlers (e.g.
 * `skills_match_batch_run_now`) succeed without an OAuth admin claim. The same
 * decision admits a caller to the `/api/cli/*` control plane.
 *
 * WHAT THE TRUST DECISION READS — AND WHAT IT REFUSES TO READ:
 *
 * The decision reads the CONNECTING SOCKET's peer address and a per-boot local
 * credential. It NEVER reads the request's `Host` header, the URL authority
 * derived from it, or any forwarded header.
 *
 * The reason is measurable: `new URL(request.url).hostname` reflects the HOST
 * HEADER, not the peer of the TCP connection, and the framework's development
 * server synthesises `x-forwarded-for` / `-host` / `-proto` on the way into a
 * route handler from that same request. So a reverse proxy or tunnel that
 * terminates on this machine and connects to the loopback listener presents a
 * request indistinguishable, at the header level, from one typed on this
 * machine — any remote caller who can reach such a listener need only send
 * `Host: localhost`. A header can be written by whoever is speaking; the socket
 * peer cannot.
 *
 * FOUR GUARDS, ALL REQUIRED:
 *   1. `NODE_ENV !== "production"` — never elevate in production builds.
 *   2. `CINATRA_MCP_DEV_ADMIN_BYPASS === "true"` — explicit opt-in env
 *      (distinct from `A2A_DEV_BYPASS` / `BETTER_AUTH_DEV_BYPASS` so an
 *      accidental enable of an existing flag does not also unlock MCP admin).
 *   3. NO forwarded header ON THE CONNECTION AS IT ARRIVED. `x-forwarded-for`,
 *      `x-forwarded-host`, `x-forwarded-proto` and `forwarded` each REFUSE the
 *      bypass outright, present at any value. A request that travelled a proxy
 *      chain is by definition not the local operator, and the synthesised-header
 *      case above means a "chain that only names loopback" proves nothing.
 *
 *      WHERE THAT QUESTION IS ASKED MATTERS, and getting it wrong breaks the
 *      bypass rather than widening it: the development server SYNTHESISES the
 *      forwarded chain on the way into a route handler, so by the time a
 *      handler reads its own `Request` headers the chain is ALWAYS present and
 *      a presence check there would refuse every request there is. The presence
 *      is therefore read from the INGRESS snapshot taken with the socket peer
 *      (see `./local-connection`), on the raw connection, before the framework
 *      has touched it. `hasForwardedHeader` below is the shared predicate over
 *      an arbitrary header view; the request-level composition applies it at
 *      ingress and never to the route handler's headers.
 *   4. The connecting socket's peer address is loopback AND the request carries
 *      the per-boot local credential in `x-cinatra-dev-local-token`, matching
 *      the token this process minted at boot, compared in constant time.
 *
 * THE PER-BOOT LOCAL CREDENTIAL is a random token minted once per process at
 * boot and written `0600` into the instance data directory (see
 * `./dev-local-token`). Only a caller that can READ that file — i.e. a process
 * running as the operator on this machine — can present it. UNSET MEANS OFF:
 * when no token was minted (the boot hook did not run, or the opt-in flag is
 * off) the decision REFUSES. It never falls back to a header-derived signal.
 *
 * The socket peer is the network fact and the credential is the possession
 * proof; neither alone admits. The peer address is obtained from the runtime's
 * connection info (see `./local-connection`), never from a header a caller
 * could write, and an unknown peer REFUSES.
 *
 * Pure functions so they can be unit-tested without mounting the MCP server.
 * The request-level composition (reading the peer, the minted token and the
 * headers) lives in `./dev-admin-bypass-request` — ONE implementation, used by
 * the MCP transport and by the `/api/cli/*` guard alike.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * The header a local client presents the per-boot credential in. The published
 * `cinatra` CLI reads the token file (`./dev-local-token`) and sends this
 * header; nothing else on the request is consulted for trust.
 */
export const DEV_LOCAL_TOKEN_HEADER = "x-cinatra-dev-local-token";

/**
 * Forwarded headers whose mere PRESENCE refuses the bypass. Presence, not
 * value: the development server synthesises these from the request's own Host
 * header, so a value that names only loopback is not evidence of a local
 * caller — and a real proxy hop is evidence of a remote one.
 */
export const FORWARDED_HEADER_NAMES = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
] as const;

/** Minimal read-only view of a request's headers. */
export type HeaderReader = { get(name: string): string | null };

/**
 * Normalize a host string to its comparable form:
 *   - reject inputs that look like URLs (contain `://`) — these are not
 *     hostnames; treating their colon as a port separator would yield a
 *     wrong token (e.g. `https://example.test` → `"https"`).
 *   - strip surrounding `[...]` (IPv6 bracketed form)
 *   - strip a single trailing `:<port>` from plain hostnames
 *   - lowercase
 * Returns null for empty / whitespace-only / URL-shaped input.
 *
 * Retained for request-shaping and diagnostics ONLY. No trust decision in this
 * module consults a hostname.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let host = raw.trim();
  if (host === "") return null;
  // Reject anything that looks like a URL (`scheme://...`). A bare hostname
  // never contains `://`, so any input that does is a misuse — drop it
  // rather than risk producing a token that matches something else (e.g.
  // `https://example.test` would otherwise normalize to `"https"`).
  if (host.includes("://")) return null;
  // Strip an IPv6 bracketed form: `[::1]` or `[::1]:3000`. Reject malformed
  // suffixes such as `[::1]evil.com` — only an empty suffix or `:<port>`
  // is accepted.
  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx <= 0) return null;
    const inside = host.slice(1, closeIdx);
    const after = host.slice(closeIdx + 1);
    if (after !== "" && !/^:\d+$/.test(after)) return null;
    host = inside;
  } else if (host.includes(":")) {
    // Plain `host:port` — strip the rightmost `:<port>` only when the port
    // is all digits. Skip when the string has multiple colons (raw IPv6
    // like `::1` without brackets) — leave such inputs to fail downstream
    // rather than mangling them. Reject when a single-colon suffix is
    // non-numeric (e.g. `localhost:notaport`).
    const colonCount = (host.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const idx = host.indexOf(":");
      const suffix = host.slice(idx + 1);
      if (!/^\d+$/.test(suffix)) return null;
      host = host.slice(0, idx);
    }
  }
  host = host.toLowerCase();
  return host === "" ? null : host;
}

/**
 * Resolve the URL-only request host. Diagnostics and request shaping only —
 * this is the HOST HEADER's view of the world and is never a trust signal.
 */
export function urlRequestHost(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Pluck the first value from a possibly multi-valued `x-forwarded-host`
 * header and normalize it. Returns null when absent / unparseable.
 */
export function forwardedRequestHost(headers: HeaderReader): string | null {
  const raw = headers.get("x-forwarded-host");
  if (!raw) return null;
  const first = raw.split(",")[0];
  return normalizeHost(first);
}

/**
 * Proxy-aware view of the request host for call sites that need
 * localhost-shaped request handling: forwarded-host wins when present, URL
 * fallback when not. NOT a trust signal and never used as one.
 */
export function effectiveRequestHost(
  headers: HeaderReader,
  url: string,
): string | null {
  const forwarded = forwardedRequestHost(headers);
  if (forwarded) return forwarded;
  return urlRequestHost(url);
}

/**
 * Parse a comma-separated hostname list into a Set of normalized hostnames.
 * Entries that fail to normalize (empty, malformed, scheme-prefixed) are
 * skipped. Retained for diagnostics; no trust decision reads a hostname list.
 */
export function parseTrustedHosts(raw: string | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(",")) {
    const normalized = normalizeHost(part);
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * True when ANY forwarded header is present on the request, at any value.
 * Presence alone refuses the bypass (guard 3).
 */
export function hasForwardedHeader(headers: HeaderReader): boolean {
  return FORWARDED_HEADER_NAMES.some((name) => headers.get(name) !== null);
}

/**
 * True when a SOCKET PEER ADDRESS is a loopback address. The input is the
 * address of the other end of the TCP connection as the runtime reports it —
 * never a header, never a URL authority.
 *
 * Accepts the IPv4 loopback block (`127.0.0.0/8`, which is what a local
 * connection reports on every platform), the IPv6 loopback `::1` in its
 * expanded and bracketed forms, and the IPv4-mapped IPv6 form Node reports on
 * a dual-stack listener (`::ffff:127.0.0.1`). Everything else — including a
 * private-range LAN address, a container bridge address and an absent value —
 * is NOT loopback.
 */
export function isLoopbackPeerAddress(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  let address = raw.trim().toLowerCase();
  if (address === "") return false;
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  // Strip a zone index (`fe80::1%en0`) before comparing.
  const zoneIdx = address.indexOf("%");
  if (zoneIdx >= 0) address = address.slice(0, zoneIdx);
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/**
 * Constant-time compare of two credentials of possibly different length.
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so both sides are padded to the longer width and the length
 * difference is folded into the result.
 */
export function localTokensMatch(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const width = Math.max(a.length, b.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/**
 * The trust tier for the dev-admin bypass: is this request the LOCAL OPERATOR
 * on this machine?
 *
 * Every input is a fact the caller cannot write:
 *   - `peerAddress` — the connecting socket's peer, from the runtime's
 *     connection info. `null` (unknown) REFUSES; there is no header fallback.
 *   - `forwardedHeaderPresent` — computed by `hasForwardedHeader`. `true`
 *     REFUSES outright, whatever the value said.
 *   - `expectedToken` — the credential THIS process minted at boot and wrote
 *     `0600` into the instance data directory. Absent REFUSES (unset = off).
 *   - `presentedToken` — what the caller sent; matched in constant time.
 */
export function isTrustedDevPeer(opts: {
  nodeEnv: string | undefined;
  envBypassFlag: string | undefined;
  peerAddress: string | null;
  forwardedHeaderPresent: boolean;
  presentedToken: string | null;
  expectedToken: string | null;
}): boolean {
  if (opts.nodeEnv === "production") return false;
  if (opts.envBypassFlag !== "true") return false;
  // Guard 3 — a forwarded header at ANY value means the request did not
  // arrive from the local operator's own client, or the development server
  // synthesised a chain that says nothing. Either way: refuse.
  if (opts.forwardedHeaderPresent) return false;
  // Guard 4a — the network fact.
  if (!isLoopbackPeerAddress(opts.peerAddress)) return false;
  // Guard 4b — the possession proof.
  return localTokensMatch(opts.presentedToken, opts.expectedToken);
}

/**
 * Decide whether to grant platform_admin on a request that already passed the
 * trust tier check. The boolean argument carries the trust decision (loopback
 * socket peer + per-boot local credential) — kept opaque here so the policy
 * remains pure and unit-testable.
 */
export function shouldGrantDevAdminBypass(opts: {
  nodeEnv: string | undefined;
  envBypassFlag: string | undefined;
  isTrustedDevPeer: boolean;
}): boolean {
  if (opts.nodeEnv === "production") return false;
  if (opts.envBypassFlag !== "true") return false;
  if (!opts.isTrustedDevPeer) return false;
  return true;
}
