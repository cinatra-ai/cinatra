// The ONE advisory-locked namespace primitive for every flat-token write
// (cinatra#1874, Epic #1873 W1).
//
// EVERY writer of a flat namespace token — `assistant_tag_alias` alias
// insert/update/delete, manifest `preferredTag` claims, `assistant_handles`
// mints INCLUDING the silent-suffix path, standalone registrations, and
// rename-by-principal — MUST run its check-both-tables-then-write inside
// `withAssistantNamespaceLock`. The lock is a single CONSTANT-key
// `pg_advisory_xact_lock` (codex-converged: a global key, not per-token), so the
// alias table and the handles table are checked and written atomically with
// respect to each other: two concurrent claims on the same token serialize,
// exactly one wins, and cross-table collisions (an alias vs a handle for the
// same token) are impossible.
//
// The key is a fixed 64-bit integer (a bigint literal) so it is STABLE across
// deploys and processes — a hashed key would risk drift if the seed string ever
// changed. Throughput is globally serialized for the short claim critical
// section; flat-token mints are low-volume (install / admin actions), so this is
// acceptable (codex round-0).
//
// Pure leaf: depends only on `drizzle-orm` `sql`; takes the db handle as an
// argument so it never imports the store (no cycle with `better-auth-db.ts`).

import { sql } from "drizzle-orm";

/**
 * The constant advisory-lock key guarding the entire assistant flat-token
 * namespace. A fixed integer (NOT hashed) so it is STABLE across deploys and
 * processes and never drifts. Encodes the epic/wave (#1874) as a readable
 * constant; unlikely to collide with any other advisory lock in the app.
 * `pg_advisory_xact_lock` accepts a JS number for its bigint argument.
 */
export const ASSISTANT_NAMESPACE_LOCK_KEY = 618_741_037;

/** A minimal drizzle-ish tx handle: anything exposing `.execute()` (the
 *  node-postgres drizzle tx satisfies this and much more — the generic below
 *  preserves the real tx type at the call site). */
export interface AdvisoryLockTx {
  execute(query: unknown): Promise<unknown>;
}
/** A minimal drizzle-ish db handle exposing `.transaction()`. Generic over the
 *  tx type so callers keep the full drizzle transaction (select/insert/…). */
export interface AdvisoryLockDb<TTx extends AdvisoryLockTx = AdvisoryLockTx> {
  transaction<R>(fn: (tx: TTx) => Promise<R>): Promise<R>;
}

/** Acquire the namespace advisory lock on an already-open transaction. Released
 *  automatically on commit/rollback (`pg_advisory_xact_lock`). */
export async function acquireAssistantNamespaceLock(tx: AdvisoryLockTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ASSISTANT_NAMESPACE_LOCK_KEY})`);
}

/**
 * Run `fn` inside a transaction holding the constant-key namespace advisory
 * lock — the ONE claim function every flat-token write flows through. The lock
 * is `pg_advisory_xact_lock`, released automatically when the transaction
 * commits or rolls back (no unlock/leak path). `fn` receives the transaction
 * handle and MUST perform all its namespace reads + writes on it (so they are
 * covered by the same lock + atomic commit).
 */
export async function withAssistantNamespaceLock<TTx extends AdvisoryLockTx, T>(
  db: AdvisoryLockDb<TTx>,
  fn: (tx: TTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await acquireAssistantNamespaceLock(tx);
    return fn(tx);
  });
}

/**
 * Pure deterministic-suffix chooser for the standalone-handle mint path: given a
 * normalized `base` and the set of already-TAKEN tokens (across BOTH tables),
 * return the first free candidate in the sequence `base`, `base-2`, `base-3`, …
 * up to `limit`. Returns `null` if nothing is free within the bound. Exported so
 * the suffix rule is unit-testable without a DB.
 */
export function nextFreeSuffixedCandidate(
  base: string,
  taken: ReadonlySet<string>,
  limit = 1000,
): string | null {
  for (let i = 0; i < limit; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
