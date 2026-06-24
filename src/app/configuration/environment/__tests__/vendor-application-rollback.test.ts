import { describe, expect, it, vi } from "vitest";

import {
  attemptPersistFirstRollback,
  isUnadvancedPersistFirstStamp,
  type RollbackDeps,
} from "../vendor-application-rollback";

// cinatra#468: the persist-first rollback must atomically clear ONLY this
// invocation's un-advanced stamp and must NEVER erase a marker a concurrent
// cm-success advanced — even when the success wrote a coinciding vendorScope.

const APP = "app-1";
const NONCE = "nonce-A";

function rawIdentity(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instanceNamespace: "acme",
    // Fields outside the guard that MUST survive the lossless rollback patch:
    tokenCiphertext: "ct",
    registries: { remote: { slot: 1 } },
    vendorScope: "@acme",
    vendorState: "applied",
    vendorApplicationId: APP,
    vendorApplicationRepairStuckAt: null,
    vendorApplicationPersistNonce: NONCE,
    ...overrides,
  });
}

const PARAMS = {
  applicationId: APP,
  persistNonce: NONCE,
  priorVendorState: "none",
  priorVendorApplicationId: null,
};

describe("isUnadvancedPersistFirstStamp", () => {
  const base = {
    vendorApplicationId: APP,
    vendorState: "applied",
    vendorApplicationRepairStuckAt: null,
    vendorApplicationPersistNonce: NONCE,
  };
  const expected = { applicationId: APP, persistNonce: NONCE };

  it("true for our un-advanced stamp", () => {
    expect(isUnadvancedPersistFirstStamp(base, expected)).toBe(true);
  });
  it("false when the nonce was cleared (concurrent success)", () => {
    expect(
      isUnadvancedPersistFirstStamp({ ...base, vendorApplicationPersistNonce: null }, expected),
    ).toBe(false);
  });
  it("false for a different nonce", () => {
    expect(
      isUnadvancedPersistFirstStamp({ ...base, vendorApplicationPersistNonce: "other" }, expected),
    ).toBe(false);
  });
  it("false when a reconcile-worker stuck flag is set", () => {
    expect(
      isUnadvancedPersistFirstStamp({ ...base, vendorApplicationRepairStuckAt: "2026-06-24T00:00:00Z" }, expected),
    ).toBe(false);
  });
  it("false when state is no longer 'applied'", () => {
    expect(isUnadvancedPersistFirstStamp({ ...base, vendorState: "approved" }, expected)).toBe(false);
  });
  it("false for a different application id", () => {
    expect(isUnadvancedPersistFirstStamp({ ...base, vendorApplicationId: "other" }, expected)).toBe(false);
  });
  it("false for null/empty row", () => {
    expect(isUnadvancedPersistFirstStamp(null, expected)).toBe(false);
    expect(isUnadvancedPersistFirstStamp(undefined, expected)).toBe(false);
  });
});

describe("attemptPersistFirstRollback", () => {
  it("reverts the stamp and clears the nonce when unchanged (lossless)", () => {
    let swapped: Record<string, unknown> | undefined;
    const deps: RollbackDeps = {
      readRawSnapshot: () => rawIdentity(),
      compareAndSwap: (next) => {
        swapped = next;
        return true;
      },
      onSwapped: vi.fn(),
    };
    expect(attemptPersistFirstRollback(deps, PARAMS)).toBe("rolled-back");
    expect(swapped).toMatchObject({
      vendorState: "none",
      vendorApplicationId: null,
      vendorApplicationPersistNonce: null,
      // unknown-to-guard fields preserved verbatim:
      tokenCiphertext: "ct",
      registries: { remote: { slot: 1 } },
      vendorScope: "@acme",
    });
    expect(deps.onSwapped).toHaveBeenCalledTimes(1);
  });

  it("does NOT roll back when a concurrent success cleared the nonce (THE #468 race)", () => {
    const compareAndSwap = vi.fn(() => true);
    const onSwapped = vi.fn();
    // Snapshot already shows the nonce cleared AND a coinciding vendorScope —
    // the exact ABA the old vendorScope guard missed.
    const deps: RollbackDeps = {
      readRawSnapshot: () => rawIdentity({ vendorApplicationPersistNonce: null }),
      compareAndSwap,
      onSwapped,
    };
    expect(attemptPersistFirstRollback(deps, PARAMS)).toBe("blocked-advanced");
    expect(compareAndSwap).not.toHaveBeenCalled();
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it("retries past an UNRELATED CAS conflict (nonce still ours) and rolls back", () => {
    let reads = 0;
    let swaps = 0;
    const deps: RollbackDeps = {
      readRawSnapshot: () => {
        reads++;
        return rawIdentity(); // unrelated write changed bytes but kept our nonce
      },
      compareAndSwap: () => {
        swaps++;
        return swaps >= 2; // first attempt conflicts, second lands
      },
    };
    expect(attemptPersistFirstRollback(deps, PARAMS)).toBe("rolled-back");
    expect(swaps).toBe(2);
    expect(reads).toBe(2);
  });

  it("stops if a success lands during a CAS conflict window (no wrong rollback)", () => {
    let reads = 0;
    const deps: RollbackDeps = {
      readRawSnapshot: () => {
        reads++;
        // 1st read: our stamp; after the conflicting swap, the row is a
        // committed success with the nonce cleared.
        return reads === 1 ? rawIdentity() : rawIdentity({ vendorApplicationPersistNonce: null });
      },
      compareAndSwap: () => false, // first attempt conflicts
    };
    expect(attemptPersistFirstRollback(deps, PARAMS)).toBe("blocked-advanced");
    expect(reads).toBe(2);
  });

  it("returns noop when no row, unparseable, or retries exhausted", () => {
    expect(
      attemptPersistFirstRollback({ readRawSnapshot: () => null, compareAndSwap: () => true }, PARAMS),
    ).toBe("noop");
    expect(
      attemptPersistFirstRollback({ readRawSnapshot: () => "{not json", compareAndSwap: () => true }, PARAMS),
    ).toBe("noop");
    const exhausted = attemptPersistFirstRollback(
      { readRawSnapshot: () => rawIdentity(), compareAndSwap: () => false },
      PARAMS,
      3,
    );
    expect(exhausted).toBe("noop");
  });
});
