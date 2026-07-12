import { describe, it, expect, afterEach, vi } from "vitest";

// cinatra#1392 Gap 1 — version-keyed serving is cleared in LOCKSTEP with the
// global registries by the single capability teardown chokepoint
// (`teardownExtensionCapabilities`), so a torn-down / re-activating package stops
// serving its non-default side-by-side versions too.

// `@/lib/extension-object-types-teardown` (pulled transitively by the teardown
// closure) imports the HEAVY `@cinatra-ai/objects` main entry. Alias it to the
// NARROW registry entry — same Symbol.for singleton — exactly as the per-kind
// teardown invariant test does.
vi.mock("@cinatra-ai/objects", async () => {
  const registry = await import("@cinatra-ai/objects/registry");
  return registry;
});

import { teardownExtensionCapabilities } from "@/lib/extension-capability-teardown";
import {
  beginVersionKeyedRegistration,
  isVersionKeyedServable,
  resolveVersionKeyedMcpTool,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";

const PKG = "@x/torn-down";

afterEach(() => {
  __resetVersionKeyedServingForTests();
});

describe("teardownExtensionCapabilities clears version-keyed serving in lockstep", () => {
  it("drops every retained non-default version of the package and reports them", () => {
    for (const v of ["1.0.0", "2.0.0"]) {
      const sink = beginVersionKeyedRegistration(PKG, v);
      sink.retainMcpTool({ name: "t", handler: () => ({}), packageName: PKG });
      sink.commit();
    }
    expect(isVersionKeyedServable(PKG, "1.0.0")).toBe(true);
    expect(isVersionKeyedServable(PKG, "2.0.0")).toBe(true);

    const result = teardownExtensionCapabilities(PKG);
    expect(result.removedVersionKeyedServing.sort()).toEqual(["1.0.0", "2.0.0"]);

    expect(isVersionKeyedServable(PKG, "1.0.0")).toBe(false);
    expect(isVersionKeyedServable(PKG, "2.0.0")).toBe(false);
    expect(resolveVersionKeyedMcpTool(PKG, "1.0.0", "t").kind).toBe("refuse");
  });

  it("a package with no retained versions tears down cleanly (empty removed set)", () => {
    const result = teardownExtensionCapabilities("@x/never-retained");
    expect(result.removedVersionKeyedServing).toEqual([]);
  });
});
