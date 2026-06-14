// #157 — saga-owned-fan-out context unit coverage.

import { describe, it, expect } from "vitest";
import {
  withSagaOwnedFanout,
  isSagaOwnedFanoutActive,
} from "../saga-install-context";

describe("saga-install-context", () => {
  it("is inactive by default (outside any saga)", () => {
    expect(isSagaOwnedFanoutActive()).toBe(false);
  });

  it("is active INSIDE withSagaOwnedFanout and restores to inactive after", async () => {
    expect(isSagaOwnedFanoutActive()).toBe(false);
    const inside = await withSagaOwnedFanout({ rootPackageName: "@x/root" }, async () =>
      isSagaOwnedFanoutActive(),
    );
    expect(inside).toBe(true);
    // ALS scope ends with the callback.
    expect(isSagaOwnedFanoutActive()).toBe(false);
  });

  it("nests re-entrantly without corrupting the flag", async () => {
    const seen = await withSagaOwnedFanout({ rootPackageName: "@x/a" }, async () => {
      const outer = isSagaOwnedFanoutActive();
      const inner = await withSagaOwnedFanout({ rootPackageName: "@x/b" }, async () =>
        isSagaOwnedFanoutActive(),
      );
      // Still active after the inner scope exits (outer scope intact).
      const afterInner = isSagaOwnedFanoutActive();
      return { outer, inner, afterInner };
    });
    expect(seen).toEqual({ outer: true, inner: true, afterInner: true });
    expect(isSagaOwnedFanoutActive()).toBe(false);
  });

  it("propagates the active flag across an async boundary inside the scope", async () => {
    const result = await withSagaOwnedFanout({ rootPackageName: "@x/root" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return isSagaOwnedFanoutActive();
    });
    expect(result).toBe(true);
  });
});
