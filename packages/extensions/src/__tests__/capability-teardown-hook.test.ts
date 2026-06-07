import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  setExtensionCapabilityTeardownHook,
  fireExtensionCapabilityTeardown,
} from "../capability-teardown-hook";

describe("capability-teardown-hook (split-brain guard)", () => {
  beforeEach(() => setExtensionCapabilityTeardownHook(null));
  afterEach(() => setExtensionCapabilityTeardownHook(null));

  it("no-ops when no host hook is wired", () => {
    // Must not throw even though nothing is registered.
    expect(() => fireExtensionCapabilityTeardown("@scope/pkg")).not.toThrow();
  });

  it("invokes the wired hook with the package name", () => {
    const calls: string[] = [];
    setExtensionCapabilityTeardownHook((pkg) => calls.push(pkg));
    fireExtensionCapabilityTeardown("@cinatra-ai/foo-connector");
    expect(calls).toEqual(["@cinatra-ai/foo-connector"]);
  });

  it("swallows a throwing hook (in-memory cleanup must never abort a committed purge)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setExtensionCapabilityTeardownHook(() => {
      throw new Error("registry teardown boom");
    });
    expect(() => fireExtensionCapabilityTeardown("@scope/pkg")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("clears the hook when set to null", () => {
    const calls: string[] = [];
    setExtensionCapabilityTeardownHook((pkg) => calls.push(pkg));
    setExtensionCapabilityTeardownHook(null);
    fireExtensionCapabilityTeardown("@scope/pkg");
    expect(calls).toEqual([]);
  });
});
