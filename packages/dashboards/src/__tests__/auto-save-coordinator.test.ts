import { describe, expect, it, vi } from "vitest";

import { createAutoSaveCoordinator } from "../components/auto-save-coordinator";

/**
 * Hermetic tests for `createAutoSaveCoordinator` — the pure coordinator
 * powering `<AgentsDashboardGrid>`'s auto-save. We exercise the
 * guarantees that the "resize doesn't save" behavior depends on:
 *
 *   - dedup by JSON.stringify(next) vs the last persisted JSON
 *   - serialization via the in-flight `while` loop
 *   - latest-wins: a `setPending(B)` during `onSave(A)` still persists B
 *   - error propagation: `flush({ rethrow: true })` surfaces failures;
 *     default `flush()` swallows + logs
 *   - commit-after-persist: `onCommit` only fires after `onSave` resolves
 */

type Cfg = { layouts: { lg: Array<{ i: string; x: number; y: number; w: number; h: number }> } };

function cfg(h: number): Cfg {
  return { layouts: { lg: [{ i: "p", x: 0, y: 0, w: 6, h }] } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createAutoSaveCoordinator", () => {
  it("persists the pending value and commits after success", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await coord.flush();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(cfg(9));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(cfg(9));
    expect(coord.getPending()).toBeNull();
  });

  it("dedups when pending JSON matches last persisted JSON", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(8)); // identical to baseline
    await coord.flush();

    expect(onSave).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("dedups when the same value is flushed twice", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await coord.flush();
    coord.setPending(cfg(9));
    await coord.flush();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("serializes concurrent flushes — only one save runs at a time", async () => {
    const inflightStart = deferred<void>();
    const inflightFinish = deferred<void>();
    let inFlightCount = 0;
    let maxInFlight = 0;
    const onSave = vi.fn().mockImplementation(async () => {
      inFlightCount += 1;
      maxInFlight = Math.max(maxInFlight, inFlightCount);
      inflightStart.resolve();
      await inflightFinish.promise;
      inFlightCount -= 1;
    });
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    // Start three flushes against the SAME pending — would naively trigger
    // three parallel `onSave` calls. Mutex must serialize them.
    coord.setPending(cfg(9));
    const f1 = coord.flush();
    const f2 = coord.flush();
    const f3 = coord.flush();

    await inflightStart.promise;
    expect(maxInFlight).toBe(1);

    inflightFinish.resolve();
    await Promise.all([f1, f2, f3]);

    // With identical pending, only the first save runs; the later flushes
    // see lastPersistedJson === json and short-circuit.
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("latest-wins — setPending(B) during in-flight save of A still persists B", async () => {
    const aFinish = deferred<void>();
    const calls: Cfg[] = [];
    const onSave = vi.fn().mockImplementation(async (next: Cfg) => {
      calls.push(next);
      if (calls.length === 1) await aFinish.promise;
    });
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    const flushA = coord.flush();

    // Wait a microtask so flushA started its onSave and parked on aFinish.
    await Promise.resolve();
    await Promise.resolve();

    // Now set a NEWER pending while A is still in flight.
    coord.setPending(cfg(10));
    const flushB = coord.flush();

    // Release A — flush B's mutex loop should now process the latest
    // pending (cfg(10)) and persist it.
    aFinish.resolve();
    await Promise.all([flushA, flushB]);

    expect(calls).toEqual([cfg(9), cfg(10)]);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(1, cfg(9));
    expect(onCommit).toHaveBeenNthCalledWith(2, cfg(10));
  });

  it("rethrows on flush({ rethrow: true }) when onSave fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSave = vi.fn().mockRejectedValue(new Error("network down"));
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await expect(coord.flush({ rethrow: true })).rejects.toThrow("network down");

    // Baseline NOT advanced on failure — onCommit not called.
    expect(onCommit).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("swallows on default flush() when onSave fails (debounced-timer path)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSave = vi.fn().mockRejectedValue(new Error("network down"));
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await expect(coord.flush()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("after a failure, the next setPending+flush retries the save", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    const onSave = vi.fn().mockImplementation(async (_next: Cfg) => {
      callCount += 1;
      if (callCount === 1) throw new Error("first fails");
    });
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await coord.flush(); // first attempt — fails, swallowed
    expect(onCommit).not.toHaveBeenCalled();

    coord.setPending(cfg(9)); // user retries
    await coord.flush(); // second attempt — succeeds

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(cfg(9));
    errorSpy.mockRestore();
  });

  it("commits AFTER onSave resolves (commit-after-persist ordering)", async () => {
    const order: string[] = [];
    const onSave = vi.fn().mockImplementation(async () => {
      order.push("onSave-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("onSave-end");
    });
    const onCommit = vi.fn().mockImplementation(() => {
      order.push("onCommit");
    });
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    coord.setPending(cfg(9));
    await coord.flush();

    expect(order).toEqual(["onSave-start", "onSave-end", "onCommit"]);
  });

  it("does nothing when nothing is pending", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCommit = vi.fn();
    const coord = createAutoSaveCoordinator<Cfg>({
      initialPersistedJson: JSON.stringify(cfg(8)),
      onSave,
      onCommit,
    });

    await coord.flush();
    expect(onSave).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
