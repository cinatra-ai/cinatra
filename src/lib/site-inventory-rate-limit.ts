import "server-only";

// In-process rate/backpressure guards for the cinatra#2021 S6-absorbed
// cinatra#2018 S3 PR-D site-inventory intake route
// (`POST /api/connect/site-inventory`). Two independent controls, mirroring
// connect-rate-limit.ts's per-IP/per-code shape but keyed for THIS route's own
// threat model:
//
//   - `allowSiteInventoryIpRequest` — a pre-auth, IP-only sliding-window
//     bucket. Runs BEFORE any credential is validated or the body is even
//     read, so it blunts scanning/flooding without amplifying an
//     unauthenticated caller's request into DB or parsing work.
//   - `checkSiteInventoryDebounce` — the contract-documented post-auth
//     per-site 60s debounce
//     (`docs/internals/contracts/wp-site-inventory-contract.md` "Channel":
//     "Per-site debounce: 60 s (`429` + `Retry-After`)"). Keyed by the
//     VERIFIED siteId (never an attacker-controlled value pre-auth) so it
//     cannot be used to enumerate or grief other sites. Returns the exact
//     `Retry-After` seconds so a compliant sender backs off precisely instead
//     of retry-storming; only an ALLOWED call advances the site's window (a
//     denied call never resets the clock, so a burst cannot extend its own
//     lockout).
//
// Single-instance in-memory state (globalThis-cached, mirroring
// connect-rate-limit.ts so Turbopack HMR / multiple route compilations in dev
// share one map) is sufficient: the actual correctness backstop against
// replay/out-of-order delivery is the atomic anti-replay upsert
// (`tryAdvanceSiteInventory`), not this limiter — this module is a brute-force
// / hammering speed bump, never a distributed quota.

type IpBucket = { count: number; resetAt: number };

declare global {
  var __cinatraSiteInventoryIpBuckets: Map<string, IpBucket> | undefined;
  var __cinatraSiteInventoryDebounce: Map<string, number> | undefined;
}

function ipBuckets(): Map<string, IpBucket> {
  if (!globalThis.__cinatraSiteInventoryIpBuckets) {
    globalThis.__cinatraSiteInventoryIpBuckets = new Map();
  }
  return globalThis.__cinatraSiteInventoryIpBuckets;
}

function debounceMap(): Map<string, number> {
  if (!globalThis.__cinatraSiteInventoryDebounce) {
    globalThis.__cinatraSiteInventoryDebounce = new Map();
  }
  return globalThis.__cinatraSiteInventoryDebounce;
}

const IP_WINDOW_MS = 60_000;
const IP_MAX = 30; // 30 intake POSTs / min / IP — a brute-force speed bump;
// the real authentication happens inside the handler regardless.

/** The contract-documented per-site debounce window (§"Channel"). */
export const SITE_INVENTORY_DEBOUNCE_MS = 60_000;

/**
 * Pre-auth, per-IP sliding-window limiter. Returns `true` when the request is
 * ALLOWED. Deliberately runs before any credential validation, body read, or
 * DB call — an IP that floods this route never gets to amplify that flood
 * into parsing or database work.
 */
export function allowSiteInventoryIpRequest(input: { ip: string; now?: number }): boolean {
  const now = input.now ?? Date.now();
  const map = ipBuckets();
  const key = `ip:${input.ip}`;
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
    return true;
  }
  if (existing.count >= IP_MAX) return false;
  existing.count += 1;
  return true;
}

export type SiteInventoryDebounceResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Post-auth, per-site 60s debounce (contract-required `429` + `Retry-After`).
 * `siteId` MUST be the credential-verified site id (never a raw header/body
 * value) — this is a backpressure control on an authenticated sender, not an
 * auth check itself. Only an ALLOWED call advances the window.
 */
export function checkSiteInventoryDebounce(input: {
  siteId: string;
  now?: number;
}): SiteInventoryDebounceResult {
  const now = input.now ?? Date.now();
  const map = debounceMap();
  const last = map.get(input.siteId);
  if (last === undefined || now - last >= SITE_INVENTORY_DEBOUNCE_MS) {
    map.set(input.siteId, now);
    return { allowed: true };
  }
  const retryAfterMs = SITE_INVENTORY_DEBOUNCE_MS - (now - last);
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/** Test seam: clear all in-process rate/debounce state. */
export function __resetSiteInventoryRateLimitForTests(): void {
  ipBuckets().clear();
  debounceMap().clear();
}
