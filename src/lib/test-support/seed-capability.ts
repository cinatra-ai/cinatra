// ---------------------------------------------------------------------------
// THE SHARED PRIMITIVES BEHIND EVERY SEED CAPABILITY FENCE.
//
// Two test-only routes on this app perform real writes and are deliberately
// exempt from the sign-in redirect, so each is fenced by a PRESENTED CAPABILITY:
// the in-process lifecycle seed (`lifecycle-seed-fence.ts`) and the
// design-conformance seed (`conformance-seed-fence.ts`). The fences differ —
// they guard different routes, on different builds, and they answer differently
// — but the two things a capability fence must get EXACTLY right are the same
// for both: comparing a secret without leaking its length through timing, and
// deciding whether the hops a request advertises are all on this machine.
//
// Those two live here, once. A second copy of a constant-time compare is not
// redundancy, it is a second thing to keep correct — and the one that is not
// being read is the one that drifts.
//
// Deliberately dependency-light (node:crypto and nothing else) so a fence built
// on it can be evaluated on every call, and so the negative controls can drive
// it under a production-shaped environment without loading a server module.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";

/** An environment as a fence reads it — `process.env`, or a literal in a test. */
export type SeedFenceEnv = Record<string, string | undefined>;

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when a single forwarded-chain entry names an address on this machine.
 * Strips RFC 7239 quoting, IPv6 brackets, a trailing `:port`, and the IPv4
 * mapped-in-IPv6 prefix. An unparseable or empty entry is NOT loopback — fail
 * closed.
 */
export function isLoopbackAddress(raw: string): boolean {
  let value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  value = value.replace(/^"|"$/g, "");
  if (value.startsWith("[")) {
    value = value.slice(1, value.indexOf("]") === -1 ? undefined : value.indexOf("]"));
  } else if ((value.match(/:/g)?.length ?? 0) === 1) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return LOOPBACK_HOSTS.has(value);
}

/**
 * THE FORWARDED CHAIN MUST BE LOCAL — not absent.
 *
 * Disqualifying on PRESENCE refuses every request there is: Next's own dev
 * server synthesises `x-forwarded-for` / `-host` / `-proto` on the way into a
 * route handler, so the chain is always there and the header says nothing about
 * a proxy the operator installed. The check that is actually MEANT is "no hop
 * from off this machine", so that is what this asks.
 *
 * IT IS A NARROWING SIGNAL, NEVER A PROOF, and the distinction matters because a
 * caller can also just send these headers. It is deliberately one-directional: a
 * chain that names a REMOTE hop refuses; a chain that names only loopback does
 * not thereby prove anything. The presented capability is the proof.
 *
 * True when every hop the request advertises is on this machine. An UNPARSEABLE
 * or empty entry counts as remote — fail closed.
 */
export function forwardedChainIsLocal(headers: {
  get(name: string): string | null;
}): boolean {
  const xff = headers.get("x-forwarded-for");
  if (xff !== null) {
    const hops = xff.split(",").map((h) => h.trim());
    if (hops.length === 0 || !hops.every(isLoopbackAddress)) return false;
  }
  const xfh = headers.get("x-forwarded-host");
  if (xfh !== null && !isLoopbackAddress(xfh)) return false;
  const fwd = headers.get("forwarded");
  if (fwd !== null) {
    const fors = [...fwd.matchAll(/for=([^;,\s]+)/gi)].map((m) => m[1]);
    if (fors.length === 0 || !fors.every(isLoopbackAddress)) return false;
  }
  return true;
}

/** Constant-time compare of two secrets of possibly different length. */
export function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length; compare fixed-width digests of equal size instead by padding to the
  // longer of the two and folding the length difference into the result.
  const width = Math.max(a.length, b.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/**
 * The capability a caller presents, or "" when it presented none. `Bearer` is
 * matched case-insensitively (RFC 7235 makes the scheme case-insensitive).
 */
export function presentedBearer(headers: { get(name: string): string | null }): string {
  const authorization = headers.get("authorization") ?? "";
  return /^Bearer (.+)$/i.exec(authorization)?.[1] ?? "";
}
