import "server-only";

// In-process sliding-window rate limiter for the cinatra#221 connect token
// endpoint (§6). Two independent buckets:
//   - per IP   — blunts distributed scanning / brute force of install codes
//   - per code — caps attempts against a single code/install-code hash
//
// Single-instance in-memory is sufficient for the threat (the real defenses are
// the one-use atomic consume + short TTLs + generic errors); this limiter is a
// brute-force speed bump, not a distributed quota. State lives on globalThis so
// Turbopack HMR / multiple route compilations in dev share one map instead of
// resetting the window on every recompile.

type Bucket = { count: number; resetAt: number };

declare global {
  var __cinatraConnectRateBuckets: Map<string, Bucket> | undefined;
}

function buckets(): Map<string, Bucket> {
  if (!globalThis.__cinatraConnectRateBuckets) {
    globalThis.__cinatraConnectRateBuckets = new Map();
  }
  return globalThis.__cinatraConnectRateBuckets;
}

const IP_WINDOW_MS = 60_000;
const IP_MAX = 30; // 30 token POSTs / min / IP
const CODE_WINDOW_MS = 60_000;
const CODE_MAX = 5; // 5 attempts / min against one code hash

function hit(key: string, windowMs: number, max: number, now: number): boolean {
  const map = buckets();
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

/**
 * Returns true if the request is ALLOWED. Charges both the IP bucket and the
 * code bucket; either being exhausted denies. `codeKey` should be a hash (never
 * the plaintext code) so the limiter never holds a live secret.
 */
export function allowConnectTokenRequest(input: {
  ip: string;
  codeKey: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const ipOk = hit(`ip:${input.ip}`, IP_WINDOW_MS, IP_MAX, now);
  const codeOk = hit(`code:${input.codeKey}`, CODE_WINDOW_MS, CODE_MAX, now);
  return ipOk && codeOk;
}

/**
 * Charge ONE named bucket and answer whether the request is allowed
 * (cinatra#2674; codex confirming round).
 *
 * WHY THIS EXISTS. `allowConnectTokenRequest` always charges BOTH buckets, which
 * is right for a code-redeem — every such request has an IP and a code. It is
 * wrong for a caller that wants a SECOND, independent dimension: charging the
 * pair again would double-charge the IP bucket for one request, and passing a
 * constant where a code hash belongs would turn the 5/min code bucket into a
 * GLOBAL cap that one caller could exhaust for everybody. The widget frame's
 * per-site limit needs exactly one bucket, so it gets a function that charges
 * exactly one.
 *
 * `windowMs`/`max` default to the code bucket's, which is the right shape for
 * "attempts against one named thing".
 */
export function allowNamedRateLimit(input: {
  key: string;
  now?: number;
  windowMs?: number;
  max?: number;
}): boolean {
  return hit(
    `named:${input.key}`,
    input.windowMs ?? CODE_WINDOW_MS,
    input.max ?? CODE_MAX,
    input.now ?? Date.now(),
  );
}

/** Test seam: clear all buckets. */
export function __resetConnectRateLimitForTests(): void {
  buckets().clear();
}
