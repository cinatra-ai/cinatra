// -----------------------------------------------------------------------------
// Dedicated cache invalidation module for the `instance_identity` metadata row.
//
// This module stays separate from instance-identity-store.ts so tests can spy on
// this function via vi.mock; same-module mocking is unreliable in vitest.
// Keeping this in its own module lets tests cleanly assert that
// writeInstanceIdentity invokes invalidateInstanceIdentityCache.
//
// The in-process cache mirrors the precedent set by other metadata-row stores
// (see openai-connection-store.ts) — a globalThis-attached cache survives HMR
// boundaries and dedupes reads inside the same Node worker.
// -----------------------------------------------------------------------------

/* eslint-disable no-var */
declare global {
  var __cinatraInstanceIdentityCache: { value: unknown; readAt: number } | undefined;
}
/* eslint-enable no-var */

/**
 * Clear the in-process `instance_identity` cache so the next read goes back to
 * the database. Called by `writeInstanceIdentity` immediately after a
 * successful DB write.
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
