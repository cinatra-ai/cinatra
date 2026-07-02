/**
 * Auto-save coordinator for `DashboardGridContainer`.
 *
 * Pure coordination logic split out of the React component so it can be
 * tested hermetically (no React, no drizzle-cube, no DOM). The component
 * keeps a single instance of this coordinator in a ref and routes both
 * `onConfigChange` (debounced) and `onSave` (immediate) signals through
 * `flush()`.
 *
 * Guarantees:
 *
 *   1. Dedup — if the latest pending config JSON.stringifies to the same
 *      string as the last persisted state, `flush` short-circuits.
 *   2. Serialization — concurrent `flush()` calls await the in-flight
 *      promise via a `while` loop, so only one save runs at a time.
 *   3. Latest-wins — `pending` is re-read AFTER the mutex loop, so an
 *      edit that landed during a prior save's await still persists.
 *   4. Error propagation — `flush({ rethrow: true })` propagates the
 *      `onSave` rejection to the caller (used by DC's `onSave` path so
 *      DC's internal baseline tracks the true persisted state). The
 *      default `flush()` swallows + logs (used by the debounced timer
 *      path where there's no caller to propagate to).
 *   5. Commit-after-persist — `onCommit` only fires after `onSave`
 *      resolves successfully, so a rejected save leaves the local
 *      visible state pinned to the last-known-persisted config.
 */
export type AutoSaveCoordinator<T> = {
  /**
   * Mark `next` as the pending value. Does NOT trigger a save — call
   * `flush` (immediately or via a debounced timer) to actually persist.
   */
  setPending: (next: T) => void;
  /**
   * Persist the pending value. With `{ rethrow: true }` the caller
   * receives any rejection from the underlying `onSave`; otherwise the
   * coordinator logs and swallows the rejection.
   */
  flush: (opts?: { rethrow?: boolean }) => Promise<void>;
  /**
   * Read the current pending value. Returns `null` if nothing is queued.
   */
  getPending: () => T | null;
};

export type AutoSaveCoordinatorOptions<T> = {
  /**
   * JSON.stringify of the initial persisted state. Used as the baseline
   * for dedup. The coordinator advances this after every successful save.
   */
  initialPersistedJson: string;
  /** Async persister — must throw on failure. */
  onSave: (next: T) => Promise<void>;
  /**
   * Fired AFTER `onSave` resolves successfully. Lets the caller advance
   * any local UI state that mirrors the persisted config. Skipped on
   * `onSave` failure.
   */
  onCommit: (next: T) => void;
};

export function createAutoSaveCoordinator<T>(
  options: AutoSaveCoordinatorOptions<T>,
): AutoSaveCoordinator<T> {
  let lastPersistedJson = options.initialPersistedJson;
  let pending: T | null = null;
  let inFlight: Promise<void> | null = null;

  async function flush(opts: { rethrow?: boolean } = {}): Promise<void> {
    while (inFlight) {
      try {
        await inFlight;
      } catch {
        // The prior flush's caller already received the error (or it was
        // logged via the default flush path). Move on so the latest
        // pending value gets a fresh attempt.
      }
    }
    const next = pending;
    pending = null;
    if (next === null) return;
    const json = JSON.stringify(next);
    if (json === lastPersistedJson) return;

    const promise = (async (): Promise<void> => {
      try {
        await options.onSave(next);
        lastPersistedJson = json;
        options.onCommit(next);
      } finally {
        inFlight = null;
      }
    })();
    inFlight = promise;
    try {
      await promise;
    } catch (err) {
      console.error("Dashboard auto-save failed:", err);
      if (opts.rethrow) throw err;
    }
  }

  return {
    setPending: (next) => {
      pending = next;
    },
    flush,
    getPending: () => pending,
  };
}
