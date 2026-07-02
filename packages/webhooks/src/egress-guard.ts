// SSRF / egress guard for the OUTBOUND webhook engine (engineering#370).
//
// The outbound target URL is operator-configured (an assistant profile's
// `webhookUrl`), so this is a LOW-severity hardening rather than an
// arbitrary-user SSRF sink — but a compromised/misconfigured target, an open
// redirect, or a DNS-rebind can still coerce the host into POSTing a SIGNED
// payload at an internal address (cloud metadata, RFC1918, loopback…). This
// module is the single egress-policy authority `deliverOutbound` consults
// BEFORE it sends.
//
// Defense, in layers (codex-converged, gpt-5.5):
//   1. SYNC guard (always, even under a stubbed transport): parse the URL,
//      allow only http/https, reject embedded credentials, reject well-known
//      internal host aliases, and — when the host is a LITERAL IP — classify it
//      directly against the deny ranges (no DNS).
//   2. DNS guard: resolve the hostname (injectable `lookup`, default
//      `dns.lookup` with `{ all: true }`) and block if ANY resolved A/AAAA
//      address is in a deny range, or if resolution is empty (fail closed).
//   3. CONNECT pinning (DNS-rebind defense / TOCTOU close): the dispatcher this
//      module builds resolves the hostname ONCE via the SAME guarded `lookup`
//      and connects only to a validated address. The hostname (and thus Host
//      header, SNI, and certificate validation) is preserved. A connect-time
//      re-resolution to an internal address surfaces as an `EgressBlockedError`
//      carried on the fetch error's `cause` chain.
//
// A block is a PERMANENT failure (the host dead-letters it, no retry storm):
// re-POSTing the same bytes at the same blocked target will keep failing.

import { isIP } from "node:net";
import { lookup as dnsLookupCb } from "node:dns";
import { Agent, buildConnector } from "undici";

/** Stable marker so a connect-time block is recognizable through `err.cause`. */
export const EGRESS_BLOCKED = Symbol.for("cinatra.egress.blocked");

/** Thrown (or set as a fetch error `cause`) when a target is denied by policy. */
export class EgressBlockedError extends Error {
  readonly code = "CINATRA_EGRESS_BLOCKED";
  readonly [EGRESS_BLOCKED] = true as const;
  constructor(reason: string) {
    super(`egress blocked: ${reason}`);
    this.name = "EgressBlockedError";
  }
}

/** True if `err` (or anything on its `cause` chain) is an egress block. */
export function isEgressBlock(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (typeof cur === "object" && (cur as Record<PropertyKey, unknown>)[EGRESS_BLOCKED]) {
      return true;
    }
    if (
      typeof cur === "object" &&
      (cur as { code?: unknown }).code === "CINATRA_EGRESS_BLOCKED"
    ) {
      return true;
    }
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** One resolved address, in the shape `dns.lookup(host, { all: true })` returns. */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/** Injectable resolver. Default resolves A+AAAA via `dns.lookup({ all: true })`. */
export type EgressLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

const defaultLookup: EgressLookup = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as LookupAddress[]);
    });
  });

// ---------------------------------------------------------------------------
// IP range classification
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// Host aliases that must never reach DNS (case-insensitive, trailing-dot tolerant).
const DENY_HOST_ALIASES = new Set([
  "localhost",
  "metadata", // single-label cloud metadata alias
  "metadata.google.internal", // GCP metadata
  "metadata.goog",
]);

/** ipv4 dotted-quad string -> 32-bit unsigned int, or null if not 4 octets in range. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

interface V4Range {
  readonly net: number;
  readonly bits: number;
  readonly label: string;
}

function v4(cidr: string, label: string): V4Range {
  const [ip, bitsStr] = cidr.split("/");
  const net = ipv4ToInt(ip);
  if (net === null) throw new Error(`bad CIDR ${cidr}`);
  const bits = Number(bitsStr);
  // mask the base to the prefix so the membership test is a pure prefix-compare
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (net & mask) >>> 0, bits, label };
}

// IPv4 deny ranges (special-use + private + link-local + metadata, RFC 6890 et al).
const V4_DENY: readonly V4Range[] = [
  v4("0.0.0.0/8", "this-network"),
  v4("10.0.0.0/8", "rfc1918-private"),
  v4("100.64.0.0/10", "cgnat"),
  v4("127.0.0.0/8", "loopback"),
  v4("169.254.0.0/16", "link-local (incl. 169.254.169.254 metadata)"),
  v4("172.16.0.0/12", "rfc1918-private"),
  v4("192.0.0.0/24", "ietf-protocol"),
  v4("192.0.2.0/24", "documentation"),
  v4("192.88.99.0/24", "6to4-relay-anycast"),
  v4("192.168.0.0/16", "rfc1918-private"),
  v4("198.18.0.0/15", "benchmarking"),
  v4("198.51.100.0/24", "documentation"),
  v4("203.0.113.0/24", "documentation"),
  v4("224.0.0.0/4", "multicast"),
  v4("240.0.0.0/4", "reserved"),
  v4("255.255.255.255/32", "broadcast"),
];

function classifyV4(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  for (const r of V4_DENY) {
    const mask = r.bits === 0 ? 0 : (0xffffffff << (32 - r.bits)) >>> 0;
    if (((n & mask) >>> 0) === r.net) return r.label;
  }
  return null;
}

/** Expand a (possibly compressed) IPv6 literal to 8 hextets; null if malformed. */
function expandV6(ip: string): number[] | null {
  // Drop a zone id (fe80::1%eth0) if present.
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4 / 64:ff9b::1.2.3.4).
  let tailV4: number[] | null = null;
  const lastColon = ip.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    tailV4 = [(n >>> 16) & 0xffff, n & 0xffff];
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }
  const dbl = ip.indexOf("::");
  let headParts: string[];
  let tailParts: string[];
  if (dbl !== -1) {
    headParts = ip.slice(0, dbl).split(":").filter((s) => s.length > 0);
    tailParts = ip.slice(dbl + 2).split(":").filter((s) => s.length > 0);
  } else {
    headParts = ip.split(":");
    tailParts = [];
  }
  const fill = 8 - (headParts.length + tailParts.length);
  if (dbl === -1 && fill !== 0) return null;
  if (fill < 0) return null;
  const groups = [...headParts, ...Array(fill).fill("0"), ...tailParts];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  if (tailV4) {
    out[6] = tailV4[0];
    out[7] = tailV4[1];
  }
  return out;
}

/** The dotted-quad of the LOW 32 bits (groups[6],groups[7]). */
function lowV4(groups: number[]): string {
  const a = (groups[6] >> 8) & 0xff;
  const b = groups[6] & 0xff;
  const c = (groups[7] >> 8) & 0xff;
  const d = groups[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Returns the embedded dotted-quad if `groups` is an IPv4-mapped/compat or
 * NAT64-well-known v6 form, else null. (The NAT64 LOCAL-use prefix
 * `64:ff9b:1::/48` is denied outright in classifyV6, not unwrapped, since its
 * embedded-v4 position is variable — RFC 8215.)
 */
function embeddedV4(groups: number[]): string | null {
  // ::w.x.y.z (IPv4-compatible, deprecated) and ::ffff:w.x.y.z (IPv4-mapped)
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return lowV4(groups);
  }
  // ::ffff:0:w.x.y.z — IPv4-translated, ::ffff:0:0/96 (RFC 8215 / IANA
  // special-use, not globally routable). Unwrap so the embedded v4 is checked.
  if (
    groups.slice(0, 4).every((g) => g === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  ) {
    return lowV4(groups);
  }
  // 64:ff9b::w.x.y.z (NAT64 well-known prefix, RFC 6052 — embedded v4 in low 32)
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((g) => g === 0)
  ) {
    return lowV4(groups);
  }
  return null;
}

function classifyV6(ip: string): string | null {
  const g = expandV6(ip);
  if (!g) return "unparseable-ipv6";
  // Unwrap embedded IPv4 and re-classify against the v4 ranges.
  const v4tail = embeddedV4(g);
  if (v4tail) {
    const v4label = classifyV4(v4tail);
    if (v4label) return `${v4label} (via embedded ipv4 ${v4tail})`;
    // a mapped/compat PUBLIC v4 is allowed
    return null;
  }
  const [h0, h1, h2] = g;
  if (g.every((x) => x === 0)) return "unspecified (::)";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback (::1)";
  if ((h0 & 0xfe00) === 0xfc00) return "ula (fc00::/7)";
  if ((h0 & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((h0 & 0xff00) === 0xff00) return "multicast (ff00::/8)";
  // NAT64 local-use prefix (RFC 8215). Embedded-v4 position is variable, so the
  // whole /48 is denied outright (it translates to an operator-internal v4).
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0x0001) return "nat64-local (64:ff9b:1::/48)";
  if (h0 === 0x2001 && h1 === 0x0db8) return "documentation (2001:db8::/32)";
  // IETF protocol-assignments 2001::/23 (Teredo 2001::/32, ORCHIDv2 2001:20::/28, etc.)
  if (h0 === 0x2001 && (h1 & 0xfe00) === 0x0000) return "ietf-protocol (2001::/23)";
  if (h0 === 0x0100 && h1 === 0x0000) return "discard-only (100::/64)";
  if (h0 === 0x2002) return "6to4 (2002::/16)";
  return null;
}

/**
 * Classify a LITERAL IP string (v4 or v6, brackets already stripped) against the
 * deny ranges. Returns a human reason if denied, else null (allowed).
 */
export function classifyIpLiteral(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) return classifyV4(ip);
  if (fam === 6) return classifyV6(ip);
  return "not-an-ip";
}

/** Strip surrounding brackets from a bracketed IPv6 host (`[::1]` -> `::1`). */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Normalize a hostname for alias comparison: lowercase, strip one trailing dot. */
function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export interface EgressGuardOptions {
  /** Injectable DNS resolver. Default `dns.lookup(host, { all: true })`. */
  readonly lookup?: EgressLookup;
}

/**
 * The SYNC + DNS portion of the guard. Throws `EgressBlockedError` when the URL
 * is denied. On success returns the validated resolved addresses (for a literal
 * IP, the single literal; for a name, the DNS answers — all already validated)
 * so the caller can pin the connection to them.
 */
export async function assertEgressAllowed(
  rawUrl: string,
  opts?: EgressGuardOptions,
): Promise<readonly LookupAddress[]> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlockedError(`unparseable URL`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new EgressBlockedError(`scheme "${url.protocol}" not in {http,https}`);
  }
  if (url.username || url.password) {
    throw new EgressBlockedError(`embedded credentials are not allowed`);
  }

  const hostRaw = stripBrackets(url.hostname);
  const hostNorm = normalizeHost(hostRaw);

  if (DENY_HOST_ALIASES.has(hostNorm) || hostNorm.endsWith(".localhost")) {
    throw new EgressBlockedError(`host alias "${hostNorm}" is internal`);
  }

  // Literal IP host: classify directly, no DNS.
  const litFamily = isIP(hostRaw);
  if (litFamily !== 0) {
    const reason = classifyIpLiteral(hostRaw);
    if (reason) throw new EgressBlockedError(`literal IP ${hostRaw}: ${reason}`);
    return [{ address: hostRaw, family: litFamily }];
  }

  // DNS name: resolve and validate EVERY answer (fail closed on empty/error).
  const lookup = opts?.lookup ?? defaultLookup;
  let addrs: readonly LookupAddress[];
  try {
    addrs = await lookup(hostNorm);
  } catch (err) {
    // A real resolver failure (NXDOMAIN/EAI_AGAIN) is NOT an egress block — let
    // it propagate as a normal network error (the caller classifies retryable).
    throw err;
  }
  if (!addrs || addrs.length === 0) {
    throw new EgressBlockedError(`host "${hostNorm}" resolved to no addresses`);
  }
  for (const a of addrs) {
    const reason = classifyIpLiteral(a.address);
    if (reason) {
      throw new EgressBlockedError(
        `host "${hostNorm}" resolves to ${a.address}: ${reason}`,
      );
    }
  }
  return addrs;
}

/**
 * Build a per-attempt undici Agent that PINS the connection to the
 * already-validated addresses. The dispatcher's `lookup` re-validates at
 * connect time (rebind defense) and only ever yields a validated address, so
 * the TCP connect cannot reach a re-resolved internal IP. A connect-time block
 * surfaces as an `EgressBlockedError` on the fetch error's `cause` chain.
 *
 * `connectTimeoutMs` bounds the TCP/TLS connect; the overall request deadline
 * is still owned by the caller's AbortSignal.
 */
export function buildPinnedAgent(
  validated: readonly LookupAddress[],
  connectTimeoutMs = 10_000,
): Agent {
  const allowed = new Set(validated.map((a) => a.address));
  return new Agent({
    connect: buildConnector({
      timeout: connectTimeoutMs,
      lookup: (hostname, _opts, cb) => {
        // Re-resolve through the guarded path; only hand back validated addrs.
        assertEgressAllowed(`https://${hostname}`, undefined).then(
          (addrs) => {
            const safe = addrs.filter((a) => allowed.has(a.address));
            const pool = safe.length > 0 ? safe : addrs;
            // Final guard: never return an address that fails classification.
            for (const a of pool) {
              if (classifyIpLiteral(a.address)) {
                cb(
                  new EgressBlockedError(
                    `connect-time rebind: ${hostname} -> ${a.address}`,
                  ),
                  [],
                );
                return;
              }
            }
            cb(null, pool.map((a) => ({ address: a.address, family: a.family })));
          },
          (err) => {
            // An EgressBlockedError here means the re-resolution landed on an
            // internal/denied address (the rebind defense) — surface the block
            // (permanent). A *transient* resolver failure (NXDOMAIN/EAI_AGAIN)
            // is NOT a block: pass the raw error through so deliverOutbound
            // classifies it retryable rather than wrongly permanent-DLQ'ing a
            // deliverable target on a DNS hiccup.
            cb(err as Error, []);
          },
        );
      },
    }),
  });
}
