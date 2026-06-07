import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  setExtensionDataTeardownHook,
  fireExtensionDataTeardown,
} from "../data-teardown-hook";

describe("data-teardown-hook — durable settings/secrets cleanup", () => {
  beforeEach(() => setExtensionDataTeardownHook(null));
  afterEach(() => setExtensionDataTeardownHook(null));

  it("no-ops when no host hook is wired", async () => {
    await expect(fireExtensionDataTeardown("@scope/pkg")).resolves.toBeUndefined();
  });

  it("invokes the wired hook with the package name", async () => {
    const calls: string[] = [];
    setExtensionDataTeardownHook((pkg) => {
      calls.push(pkg);
    });
    await fireExtensionDataTeardown("@cinatra-ai/foo-connector");
    expect(calls).toEqual(["@cinatra-ai/foo-connector"]);
  });

  it("AWAITS an async hook before resolving (durable, cross-process cleanup)", async () => {
    const order: string[] = [];
    setExtensionDataTeardownHook(async (pkg) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(`cleaned:${pkg}`);
    });
    await fireExtensionDataTeardown("@scope/pkg");
    order.push("after-fire");
    // The cleanup completed BEFORE fire() resolved — proves it is awaited.
    expect(order).toEqual(["cleaned:@scope/pkg", "after-fire"]);
  });

  it("swallows a throwing (sync) hook — a committed hard-removal must not be aborted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setExtensionDataTeardownHook(() => {
      throw new Error("durable teardown boom");
    });
    await expect(fireExtensionDataTeardown("@scope/pkg")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("swallows a REJECTING (async) hook — idempotent re-run re-cleans", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setExtensionDataTeardownHook(async () => {
      throw new Error("async durable teardown boom");
    });
    await expect(fireExtensionDataTeardown("@scope/pkg")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears the hook when set to null", async () => {
    const calls: string[] = [];
    setExtensionDataTeardownHook((pkg) => {
      calls.push(pkg);
    });
    setExtensionDataTeardownHook(null);
    await fireExtensionDataTeardown("@scope/pkg");
    expect(calls).toEqual([]);
  });
});
