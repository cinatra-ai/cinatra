// -----------------------------------------------------------------------------
// In-process cache for the `instance_identity` metadata row.
//
// This module stays separate from instance-identity-store.ts so tests can spy on
// the invalidator via vi.mock; same-module mocking is unreliable in vitest.
// Keeping this in its own module lets tests cleanly assert that
// writeInstanceIdentity invokes invalidateInstanceIdentityCache.
//
// The in-process cache mirrors the precedent set by the other metadata-row
// readers (`readConnectorConfigFromDatabase` / `readAgentConfigFromDatabase` in
// database.ts) — a globalThis-attached, TTL-bounded cache that survives HMR
// boundaries and dedupes reads inside the same Node worker.
//
// WHY A CACHE IS LOAD-BEARING HERE, NOT A NICETY (cinatra#2539). Every
// `readInstanceIdentity()` is a `runPostgresQueriesSync` call, and that bridge
// spawns a NEW worker thread, `require("pg")`s inside it, opens a FRESH
// Postgres connection, and blocks the whole event loop on `Atomics.wait` until
// it answers. One read costs ~65-85 ms of blocked loop on a healthy local
// instance. A single authenticated `/configuration/marketplace` render used to
// issue TWELVE of them for the SAME row (setup gate, approvals nav sources,
// verdaccio read-config, the screen itself, the agent-template reads), and
// `/configuration/extensions` more — so the row's read cost scaled with the
// number of unrelated features that happen to ask "who is this instance?".
// That is the "N×(network/Redis) pattern that should be batched or cached" the
// issue names: under a degraded/slow Postgres each of those twelve blocking
// calls stretches toward the bridge's 30 s ceiling, and twelve serial ceilings
// is how a catalog render reaches minutes.
//
// The invalidation contract was already fully wired before this cache existed:
// `writeInstanceIdentity`, the `ensureInstanceId` CAS, and the
// `updateInstanceIdentityRegistries` / provisioning CAS paths (`onSwapped`) all
// call `invalidateInstanceIdentityCache()` on a landed write. Only the READ
// side was missing, so the row was re-read from Postgres every single time.
//
// TTL rationale (10 s, matching CONNECTOR_CONFIG_CACHE_TTL_MS): in-process
// writes invalidate immediately and exactly, so the TTL exists solely for
// writers this process cannot hear — a BullMQ worker thread with its own
// globalThis, a second app replica, or the CLI. Without a TTL such a write
// would be invisible to this process forever; with it, any cross-process
// change self-heals within 10 s while a single page render (well under a
// second of wall-clock read fan-out) collapses to ONE database read.
// -----------------------------------------------------------------------------

declare global {
  var __cinatraInstanceIdentityCache: { value: unknown; readAt: number } | undefined;
}

/**
 * Staleness ceiling for a cache entry, in milliseconds. Bounds ONLY the
 * cross-process window (see the module header) — an in-process write clears the
 * entry outright via {@link invalidateInstanceIdentityCache}.
 */
export const INSTANCE_IDENTITY_CACHE_TTL_MS = 10_000;

/**
 * The cached `instance_identity` row, or `null` on a miss (never cached, or the
 * entry aged past {@link INSTANCE_IDENTITY_CACHE_TTL_MS}).
 *
 * Returns a WRAPPER (`{ value }`) rather than the value itself so a legitimately
 * cached `null` — the "instance not configured yet" row absence, which is just
 * as expensive to re-read — is distinguishable from a cache miss.
 *
 * The caller owns cloning: the entry is handed back by reference so this module
 * stays free of assumptions about the row shape it caches.
 */
export function readInstanceIdentityCacheEntry(): { value: unknown } | null {
  try {
    const entry = globalThis.__cinatraInstanceIdentityCache;
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.readAt >= INSTANCE_IDENTITY_CACHE_TTL_MS) {
      globalThis.__cinatraInstanceIdentityCache = undefined;
      return null;
    }
    return { value: entry.value };
  } catch {
    // Best-effort — a locked/sandboxed global degrades to "always a miss",
    // i.e. exactly the pre-cache behaviour.
    return null;
  }
}

/**
 * Publish a freshly-read row (including a `null` row) as the cache entry.
 *
 * The caller MUST pass a value nothing else retains a reference to — the entry
 * is stored by reference and handed back by reference on every hit, so a shared
 * mutable object would let one reader's mutation leak into every later read.
 */
export function storeInstanceIdentityCacheEntry(value: unknown): void {
  try {
    globalThis.__cinatraInstanceIdentityCache = { value, readAt: Date.now() };
  } catch {
    // Best-effort — see above.
  }
}

/**
 * Clear the in-process `instance_identity` cache so the next read goes back to
 * the database. Called by `writeInstanceIdentity` immediately after a
 * successful DB write, and by every CAS path that lands a swap.
 *
 * Wrapped in try/catch because `globalThis` may be locked in some Node
 * configurations / sandboxed runtimes; cache invalidation is best-effort and
 * never blocks the write path.
 */
export function invalidateInstanceIdentityCache(): void {
  try {
    globalThis.__cinatraInstanceIdentityCache = undefined;
  } catch {
    // Best-effort — global may be locked in some Node configurations.
  }
}
