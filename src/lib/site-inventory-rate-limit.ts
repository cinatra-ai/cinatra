import "server-only";

// In-process rate/backpressure guards for the cinatra#2021 S6-absorbed
// cinatra#2018 S3 PR-D site-inventory intake route
// (`POST /api/connect/site-inventory`). Two independent controls, mirroring
// connect-rate-limit.ts's per-IP/per-code shape but keyed for THIS route's own
// threat model:
//
//   - `allowSiteInventoryRequest` — a pre-auth sliding-window limiter charging
//     TWO buckets per request (either exhausted denies, mirroring
//     `allowConnectTokenRequest`'s ip+codeKey pairing):
//       * an IP bucket — best-effort (the forwarded-for chain is
//         caller-influencable on a public route), blunts naive flooding;
//       * a CREDENTIAL-HASH bucket — the stable secondary key: rotating the
//         forwarded-for header under one presented credential no longer
//         evades the limiter, because the credential's own bucket still
//         charges (the same pre-validation pairing /api/widget-auth/init
//         uses). The caller passes a HASH of the presented credential, never
//         the plaintext, so the limiter never holds a live secret.
//     BOUNDED (fail-closed budget): the bucket map is capped at
//     SITE_INVENTORY_MAX_TRACKED_BUCKETS. At the cap, a new-key insert first
//     sweeps expired buckets; if the map is still saturated the request is
//     DENIED rather than tracked-unboundedly or waved through — a
//     key-rotation flood therefore saturates the table and draws 429s, not
//     unlimited passes. Established buckets keep working at the cap.
//   - `checkSiteInventoryDebounce` + `markSiteInventoryAccepted` — the
//     contract-documented post-auth per-site 60s debounce
//     (`docs/internals/contracts/wp-site-inventory-contract.md` "Channel":
//     "Per-site debounce: 60 s (`429` + `Retry-After`)"). Keyed by the
//     VERIFIED siteId (never an attacker-controlled value pre-auth). The
//     check is READ-ONLY; the window is recorded exclusively via
//     `markSiteInventoryAccepted`, which the route calls only after a
//     successful COMMIT — a send rejected at version/schema/anti-replay never
//     burns the site's retry slot, so a corrected retry is not punished.
//     Returns the exact `Retry-After` seconds so a compliant sender backs off
//     precisely instead of retry-storming.
//
// Single-instance in-memory state (globalThis-cached, mirroring
// connect-rate-limit.ts so Turbopack HMR / multiple route compilations in dev
// share one map) is sufficient: the actual correctness backstop against
// replay/out-of-order delivery is the atomic anti-replay upsert
// (`tryAdvanceSiteInventory`), not this limiter — this module is a brute-force
// / hammering speed bump, never a distributed quota.

type RateBucket = { count: number; resetAt: number };

declare global {
  var __cinatraSiteInventoryRateBuckets: Map<string, RateBucket> | undefined;
  var __cinatraSiteInventoryDebounce: Map<string, number> | undefined;
}

function rateBuckets(): Map<string, RateBucket> {
  if (!globalThis.__cinatraSiteInventoryRateBuckets) {
    globalThis.__cinatraSiteInventoryRateBuckets = new Map();
  }
  return globalThis.__cinatraSiteInventoryRateBuckets;
}

function debounceMap(): Map<string, number> {
  if (!globalThis.__cinatraSiteInventoryDebounce) {
    globalThis.__cinatraSiteInventoryDebounce = new Map();
  }
  return globalThis.__cinatraSiteInventoryDebounce;
}

const IP_WINDOW_MS = 60_000;
const IP_MAX = 30; // 30 intake POSTs / min / IP — best-effort speed bump; the
// credential-hash bucket below is the stable half of the pairing.
const CREDENTIAL_WINDOW_MS = 60_000;
const CREDENTIAL_MAX = 10; // 10 attempts / min under one presented credential —
// generous for a legit sender (≤1 accepted send/min by debounce, plus
// retries) while pinning a forwarded-for-rotating flood to its credential.

/** Hard cap on tracked rate buckets (both key families share one map). Keys
 * are attacker-mintable pre-auth, so the map can never grow the heap past
 * this; at the cap, expired buckets are swept and a still-saturated map
 * DENIES new keys (fail closed). */
export const SITE_INVENTORY_MAX_TRACKED_BUCKETS = 10_000;

/** The contract-documented per-site debounce window (§"Channel"). */
export const SITE_INVENTORY_DEBOUNCE_MS = 60_000;

/** Cap on tracked debounce sites — naturally bounded by real enrolled sites
 * (the key is a credential-VERIFIED siteId), capped anyway for hygiene. */
const DEBOUNCE_MAX_TRACKED_SITES = 10_000;

function sweepExpiredBuckets(map: Map<string, RateBucket>, now: number): void {
  for (const [key, bucket] of map) {
    if (bucket.resetAt <= now) map.delete(key);
  }
}

/** Charge one bucket. Returns false when the bucket is exhausted OR when the
 * map is saturated with live buckets and this would be a NEW key (fail
 * closed — saturation must never buy an untracked pass). */
function hit(
  map: Map<string, RateBucket>,
  key: string,
  windowMs: number,
  max: number,
  now: number,
): boolean {
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    if (!existing && map.size >= SITE_INVENTORY_MAX_TRACKED_BUCKETS) {
      sweepExpiredBuckets(map, now);
      if (map.size >= SITE_INVENTORY_MAX_TRACKED_BUCKETS) return false;
    }
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

/**
 * Pre-auth request limiter. Returns `true` when the request is ALLOWED.
 * Deliberately runs before any credential validation, body read, or DB call —
 * a flood never amplifies into parsing or database work. Charges BOTH the IP
 * bucket and the credential-hash bucket; either exhausted denies (so rotating
 * the forwarded-for header under one credential is still throttled, and a
 * fixed IP spraying credentials is still throttled). `credentialKey` MUST be
 * a hash of the presented credential (never the plaintext).
 */
export function allowSiteInventoryRequest(input: {
  ip: string;
  credentialKey: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const map = rateBuckets();
  const ipOk = hit(map, `ip:${input.ip}`, IP_WINDOW_MS, IP_MAX, now);
  const credOk = hit(map, `cred:${input.credentialKey}`, CREDENTIAL_WINDOW_MS, CREDENTIAL_MAX, now);
  return ipOk && credOk;
}

export type SiteInventoryDebounceResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Post-auth, per-site 60s debounce check (contract-required `429` +
 * `Retry-After`). READ-ONLY: this never records anything — the window starts
 * only when the route calls `markSiteInventoryAccepted` after a successful
 * COMMIT, so a send that later fails version/schema/anti-replay validation
 * does not burn the site's retry slot. `siteId` MUST be the
 * credential-verified site id (never a raw header/body value) — this is a
 * backpressure control on an authenticated sender, not an auth check itself.
 */
export function checkSiteInventoryDebounce(input: {
  siteId: string;
  now?: number;
}): SiteInventoryDebounceResult {
  const now = input.now ?? Date.now();
  const last = debounceMap().get(input.siteId);
  if (last === undefined || now - last >= SITE_INVENTORY_DEBOUNCE_MS) {
    return { allowed: true };
  }
  const retryAfterMs = SITE_INVENTORY_DEBOUNCE_MS - (now - last);
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/**
 * Record an ACCEPTED (committed) inventory send — starts the site's debounce
 * window. Called by the route only after the transaction commits. Capped for
 * hygiene: at the cap, stale entries (older than the window, no longer
 * denying anything) are swept; a still-full map skips the bookkeeping rather
 * than denying — this map is keyed by credential-VERIFIED siteIds (bounded by
 * real enrolled sites, not attacker-mintable), and skipping only skips
 * backpressure bookkeeping while the atomic anti-replay gate stays the
 * correctness authority.
 */
export function markSiteInventoryAccepted(input: { siteId: string; now?: number }): void {
  const now = input.now ?? Date.now();
  const map = debounceMap();
  if (!map.has(input.siteId) && map.size >= DEBOUNCE_MAX_TRACKED_SITES) {
    for (const [key, last] of map) {
      if (now - last >= SITE_INVENTORY_DEBOUNCE_MS) map.delete(key);
    }
    if (map.size >= DEBOUNCE_MAX_TRACKED_SITES) return;
  }
  map.set(input.siteId, now);
}

/** Test seam: clear all in-process rate/debounce state. */
export function __resetSiteInventoryRateLimitForTests(): void {
  rateBuckets().clear();
  debounceMap().clear();
}
