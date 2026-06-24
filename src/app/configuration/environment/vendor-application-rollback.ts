// Pure persist-first-marker rollback logic for the vendor-application server
// action. Kept OUT of the `"use server"` actions module so it is directly
// unit-testable (every export from a "use server" file must be an async server
// action) — mirrors the `vendor-application-cm-errors` classifier extraction.
//
// Background (#436/#455/#468): `applyVendorApplicationAction` stamps a
// PERSIST-FIRST marker (vendorState="applied" + a fresh applicationId) BEFORE
// the cm call so a process crash mid-call cannot lose the idempotency marker.
// When the call provably created NO cm row (terminal -32010 auth refusal, or a
// structured TERMS_* rejection — both rejected before the INSERT) the marker
// must be rolled back so the operator isn't trapped in a false "applied" state.
//
// The rollback must NEVER erase a marker that backs a REAL cm row. #455 guarded
// on `vendorScope` as a success-detector, but that has an equal-scope ABA hole
// (#468): if the prior scope already equals the scope a concurrent success
// writes, the guard can't tell a concurrent success happened. This module
// instead keys the rollback on a per-invocation NONCE the persist-first stamp
// writes and every committing path (cm-success / cancel) clears — and performs
// the clear as an ATOMIC compare-and-swap against the exact snapshot the guard
// was evaluated on, so a concurrent success that lands between the guard read
// and the swap simply makes the swap a no-op.

/** The subset of the raw persisted identity the rollback guard inspects. */
export type PersistFirstMarkerView = {
  vendorApplicationId?: unknown;
  vendorState?: unknown;
  vendorApplicationRepairStuckAt?: unknown;
  vendorApplicationPersistNonce?: unknown;
};

/**
 * Whether the persisted row is still THIS invocation's un-advanced
 * persist-first stamp — i.e. nothing (a cm-success, a cancel, the reconcile
 * worker, or another apply) has written over it since we stamped it. ALL must
 * hold:
 *   - vendorApplicationPersistNonce === our nonce  (the decisive guard: every
 *     committing path clears it to a concrete value, so a surviving match means
 *     no commit landed; unique per invocation so it closes the equal-scope ABA)
 *   - vendorApplicationId === our applicationId     (still our id)
 *   - vendorState === "applied"                     (not flipped to approved)
 *   - vendorApplicationRepairStuckAt == null        (no reconcile-worker write —
 *     the worker preserves the nonce, so this guard is still required)
 */
export function isUnadvancedPersistFirstStamp(
  row: PersistFirstMarkerView | null | undefined,
  expected: { applicationId: string; persistNonce: string },
): boolean {
  if (!row) return false;
  return (
    row.vendorApplicationPersistNonce === expected.persistNonce &&
    row.vendorApplicationId === expected.applicationId &&
    row.vendorState === "applied" &&
    (row.vendorApplicationRepairStuckAt ?? null) === null
  );
}

export type RollbackOutcome =
  // Reverted our stamp to the prior concrete state.
  | "rolled-back"
  // A committing write (cm-success / cancel) advanced the row off our stamp —
  // it backs a real cm row; we MUST NOT clear it.
  | "blocked-advanced"
  // No persisted row, unparseable row, or retries exhausted under heavy
  // unrelated contention (the false marker survives; recoverable via cancel).
  | "noop";

export type RollbackDeps = {
  /** Byte-accurate raw snapshot of the stored identity JSON (or null). */
  readRawSnapshot: () => string | null;
  /**
   * Atomic compare-and-swap: persist `next` ONLY IF the stored value is still
   * byte-equal to `expectedRaw`; returns true iff the swap landed. A concurrent
   * write (which changed the bytes) makes it a no-op (false).
   */
  compareAndSwap: (next: Record<string, unknown>, expectedRaw: string) => boolean;
  /** Invoked once, only after a swap actually lands. */
  onSwapped?: () => void;
};

/**
 * Atomically roll back this invocation's persist-first stamp.
 *
 * Each attempt: snapshot the raw row → if it is no longer our un-advanced stamp
 * (a commit cleared/changed the nonce) STOP with "blocked-advanced" → otherwise
 * patch ONLY the three ownership fields onto the parsed raw object (lossless:
 * every other persisted key is preserved verbatim) and compare-and-swap against
 * the exact snapshot. A CAS conflict means SOME write changed the bytes between
 * our read and swap; we re-loop so an UNRELATED concurrent write doesn't make us
 * spuriously skip a legitimate rollback, while a concurrent SUCCESS is caught by
 * the re-evaluated guard. Bounded to avoid an unbounded spin under pathological
 * contention.
 */
export function attemptPersistFirstRollback(
  deps: RollbackDeps,
  params: {
    applicationId: string;
    persistNonce: string;
    priorVendorState: string;
    priorVendorApplicationId: string | null;
  },
  maxAttempts = 4,
): RollbackOutcome {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = deps.readRawSnapshot();
    if (raw === null) return "noop";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return "noop";
    }
    if (
      !isUnadvancedPersistFirstStamp(parsed, {
        applicationId: params.applicationId,
        persistNonce: params.persistNonce,
      })
    ) {
      return "blocked-advanced";
    }
    const next: Record<string, unknown> = {
      ...parsed,
      vendorState: params.priorVendorState,
      vendorApplicationId: params.priorVendorApplicationId,
      // Clear our ownership stamp as part of the revert.
      vendorApplicationPersistNonce: null,
    };
    if (deps.compareAndSwap(next, raw)) {
      deps.onSwapped?.();
      return "rolled-back";
    }
    // CAS conflict: the row changed between snapshot and swap. Re-loop to
    // re-evaluate the guard against the new bytes.
  }
  return "noop";
}
