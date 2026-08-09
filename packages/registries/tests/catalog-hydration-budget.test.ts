// cinatra#2539 — the catalog packument fan-out must be BOUNDED.
//
// `listExtensionPackages` reads one full packument per package the registry
// holds. The `limit` slice happens after the visibility filter, so it does not
// bound the network work: an unresponsive registry could hold a page render for
// `packages / sockets × the npm 5-minute default`. The two bounds under test
// here are the seam that caused that amplification:
//
//   1. a shared wall-clock budget across the whole fan-out, and
//   2. degradation to the SAME "unhydrated package" outcome the function has
//      always produced for a per-package failure — never a thrown catalog.
//
// The budget must also never leak an unhandled rejection: a packument that
// rejects AFTER the budget expired is abandoned, and an abandoned-but-unhandled
// rejection would take the whole dev server down.
import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_HYDRATION_BUDGET_MS,
  CATALOG_PACKUMENT_TIMEOUT_MS,
  RegistryCatalogBudgetExceededError,
  settleWithinBudget,
} from "../src/verdaccio/client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("settleWithinBudget (cinatra#2539 catalog bound)", () => {
  it("keeps everything that settled and reports the rest as rejected, without waiting for them", async () => {
    const slow = deferred<string>();
    const results = await settleWithinBudget(
      [Promise.resolve("fast"), slow.promise, Promise.reject(new Error("boom"))],
      20,
    );

    expect(results[0]).toEqual({ status: "fulfilled", value: "fast" });
    expect(results[1]!.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      RegistryCatalogBudgetExceededError,
    );
    // The real rejection keeps its OWN reason — it is not relabelled as a
    // budget miss.
    expect(results[2]!.status).toBe("rejected");
    expect((results[2] as PromiseRejectedResult).reason).not.toBeInstanceOf(
      RegistryCatalogBudgetExceededError,
    );

    // The abandoned promise settling later must not blow up the process.
    slow.resolve("late");
    await slow.promise;
  });

  it("does not surface an unhandled rejection for a promise that rejects after the budget", async () => {
    const late = deferred<string>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await settleWithinBudget([late.promise], 10);
      late.reject(new Error("rejected after the budget expired"));
      // Two macrotask turns is more than enough for Node to have reported an
      // unhandled rejection if the handler had not been attached up front.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("waits for every promise when the budget is disabled (null)", async () => {
    const later = new Promise<string>((resolve) => setTimeout(() => resolve("eventually"), 25));
    const results = await settleWithinBudget([later], null);
    expect(results[0]).toEqual({ status: "fulfilled", value: "eventually" });
  });

  it("treats an ALREADY-EXHAUSTED budget (0) as a deadline, never as unlimited", async () => {
    // The regression this pins: an enabled budget consumed entirely by an
    // earlier phase must not collapse into "no budget at all".
    const never = new Promise<string>(() => {});
    const startedAt = Date.now();
    const results = await settleWithinBudget([never], 0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(results[0]!.status).toBe("rejected");
    expect(results[0]!.status === "rejected" && results[0].reason).toBeInstanceOf(
      RegistryCatalogBudgetExceededError,
    );
  });

  it("bounds a fan-out that would otherwise run for the npm default timeout", async () => {
    // 200 packuments that never settle — the shape that produced multi-minute
    // renders. The budget must return in budget-time, not in never-time.
    const never = Array.from({ length: 200 }, () => new Promise<string>(() => {}));
    const startedAt = Date.now();
    const results = await settleWithinBudget(never, 30);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(results).toHaveLength(200);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("returns a SNAPSHOT — a late settlement cannot rewrite the answer", async () => {
    const late = deferred<string>();
    const results = await settleWithinBudget([late.promise], 15);
    expect(results[0]!.status).toBe("rejected");
    late.resolve("arrived after the caller had its answer");
    await late.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results[0]!.status).toBe("rejected");
  });

  it("pins the shipped bounds as real, page-sized numbers", () => {
    // Regression guard: a 5-minute per-request timeout (the npm default this
    // replaced) is the defect. Both bounds must stay page-sized.
    expect(CATALOG_PACKUMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CATALOG_PACKUMENT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(CATALOG_HYDRATION_BUDGET_MS).toBeGreaterThan(0);
    expect(CATALOG_HYDRATION_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});
