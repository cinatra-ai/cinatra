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

/** Test seam: clear all buckets. */
export function __resetConnectRateLimitForTests(): void {
  buckets().clear();
}
