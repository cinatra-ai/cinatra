// Pure, cross-process-safe compare-and-swap RETRY engine for the single
// `instance_identity` metadata row. Kept IO-free + dependency-injected so it is
// directly unit-testable without a DB — mirrors the proven
// `attemptPersistFirstRollback` pattern (vendor-application-rollback.ts).
//
// Why this exists (cinatra#850): several call sites persist a sub-object of the
// identity JSON blob (notably `registries.remote`) with a lock-free
// read-modify-write — `readInstanceIdentity()` → spread → `writeInstanceIdentity()`.
// That whole-row overwrite is last-write-wins and the only serialisation is an
// IN-PROCESS promise mutex, so a background worker replica and a foreground
// server request race and silently clobber each other's committed changes.
//
// The DB already exposes a row-level CAS: `UPDATE metadata SET value=$next WHERE
// key=$k AND value=$expectedRaw RETURNING key` returns a row iff nothing changed
// the bytes since the snapshot. This engine drives that CAS in a bounded retry
// loop: snapshot the raw row → derive the next row via the caller's `mutateRow`
// → swap against the EXACT snapshot. A concurrent commit that changed any byte
// makes the swap a no-op; we re-read the fresh bytes and re-apply, so no
// concurrent update is ever lost — across processes/replicas, not just
// in-process. Bounded to avoid an unbounded spin under pathological contention.

/** Injected IO surface (defaults wired by the store; fakes injected by tests). */
export type InstanceIdentityCasDeps = {
  /** Byte-accurate raw stored JSON of the identity row, or null when absent. */
  readRawSnapshot: () => string | null;
  /**
   * Atomic compare-and-swap: persist `next` ONLY IF the stored value is still
   * byte-equal to `expectedRaw`; returns true iff the swap landed. A concurrent
   * write that changed the bytes makes it a no-op (false).
   */
  compareAndSwap: (next: Record<string, unknown>, expectedRaw: string) => boolean;
  /** Invoked exactly once, only after a swap actually lands (cache invalidation). */
  onSwapped?: () => void;
};

export type InstanceIdentityCasOutcome =
  // The mutated row was atomically persisted.
  | "swapped"
  // No identity row exists (raw snapshot was null) — nothing to update.
  | "no-identity"
  // The stored row is not valid JSON — an operator-visible corruption; skipped.
  | "unparseable"
  // `mutateRow` returned null: the caller declined to write for this row shape
  // (e.g. a row with no usable namespace). Treated as a no-op.
  | "aborted"
  // maxAttempts consecutive CAS conflicts under sustained contention. The caller
  // decides how to surface this; it NEVER falls back to a clobbering write.
  | "exhausted";

/**
 * Atomically read-modify-write the `instance_identity` row via row-level CAS
 * with bounded retry.
 *
 * Each attempt: snapshot the raw row → parse → `mutateRow(parsed)` produces the
 * next FULL row (or null to abort) → compare-and-swap against the exact
 * snapshot. On a CAS conflict (some concurrent write changed the bytes) we
 * re-loop so the caller's change is re-applied onto the fresh row instead of
 * clobbering the concurrent write. `mutateRow` MUST be pure and idempotent
 * across retries: it is re-invoked on the freshly-read row each attempt.
 */
export function casUpdateInstanceIdentityRow(
  deps: InstanceIdentityCasDeps,
  mutateRow: (parsed: Record<string, unknown>) => Record<string, unknown> | null,
  maxAttempts = 8,
): InstanceIdentityCasOutcome {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = deps.readRawSnapshot();
    if (raw === null) return "no-identity";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "unparseable";
    }
    const next = mutateRow(parsed);
    if (next === null) return "aborted";
    if (deps.compareAndSwap(next, raw)) {
      deps.onSwapped?.();
      return "swapped";
    }
    // CAS conflict: the row changed between our snapshot and our swap. Re-loop
    // to re-read the fresh bytes and re-apply `mutateRow` onto them.
  }
  return "exhausted";
}
