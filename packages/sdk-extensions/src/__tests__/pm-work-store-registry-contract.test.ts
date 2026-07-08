// The PM work-store provider registry is SDK-hosted (globalThis-anchored Map) so
// PM work-store provider extensions (plane-connector) register into it and the
// host store bridge resolves from it WITHOUT importing each other by name. A
// SEPARATE registry from the trigger-mirror pm-provider registry. Mirrors the PM
// / CRM provider registry tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPmWorkStore,
  lookupPmWorkStore,
  listPmWorkStores,
  setPmWorkStoreExternalResolver,
  _resetPmWorkStoreRegistry,
} from "../pm-work-store-registry-contract";
import type { PmWorkStore } from "../pm-work-store-contract";

function fakeProvider(providerId: string): PmWorkStore {
  // Only providerId is exercised by the registry; the verb methods are unused here.
  return { providerId } as unknown as PmWorkStore;
}

afterEach(() => {
  _resetPmWorkStoreRegistry();
});

describe("pm-work-store-registry-contract — SDK-hosted provider registry", () => {
  it("registers and looks up a provider by id", () => {
    const plane = fakeProvider("plane");
    registerPmWorkStore(plane);
    expect(lookupPmWorkStore("plane")).toBe(plane);
  });

  it("returns null for an unregistered provider id", () => {
    expect(lookupPmWorkStore("github")).toBeNull();
  });

  it("re-registering the same id replaces (idempotent boot)", () => {
    const first = fakeProvider("plane");
    const second = fakeProvider("plane");
    registerPmWorkStore(first);
    registerPmWorkStore(second);
    expect(lookupPmWorkStore("plane")).toBe(second);
    expect(listPmWorkStores()).toHaveLength(1);
  });

  it("listPmWorkStores returns all registered providers", () => {
    registerPmWorkStore(fakeProvider("plane"));
    registerPmWorkStore(fakeProvider("github"));
    expect(listPmWorkStores().map((p) => p.providerId).sort()).toEqual(["github", "plane"]);
  });

  describe("external resolver (capability-registry providers)", () => {
    it("surfaces external providers via lookup/list, pulled lazily on each call", () => {
      let calls = 0;
      setPmWorkStoreExternalResolver(() => {
        calls++;
        return [fakeProvider("plane")];
      });
      expect(lookupPmWorkStore("plane")?.providerId).toBe("plane");
      expect(listPmWorkStores().map((p) => p.providerId)).toEqual(["plane"]);
      expect(calls).toBeGreaterThanOrEqual(2); // pulled lazily on each resolve
    });

    it("direct registrations win over external providers with the same id", () => {
      const direct = fakeProvider("plane");
      registerPmWorkStore(direct);
      setPmWorkStoreExternalResolver(() => [fakeProvider("plane")]);
      expect(lookupPmWorkStore("plane")).toBe(direct);
      expect(listPmWorkStores()).toHaveLength(1);
      expect(lookupPmWorkStore("plane")).toBe(direct);
    });

    it("a throwing external resolver never takes down direct registrations", () => {
      registerPmWorkStore(fakeProvider("github"));
      setPmWorkStoreExternalResolver(() => {
        throw new Error("broken external resolver");
      });
      expect(lookupPmWorkStore("github")?.providerId).toBe("github");
      expect(lookupPmWorkStore("plane")).toBeNull();
    });

    it("reset clears the external resolver", () => {
      setPmWorkStoreExternalResolver(() => [fakeProvider("plane")]);
      _resetPmWorkStoreRegistry();
      expect(lookupPmWorkStore("plane")).toBeNull();
    });
  });

  it("shares the registry across SEPARATE module instances (globalThis-anchored)", async () => {
    // A provider extension registers in one Next.js bundle (e.g. the worker/RSC)
    // and the host bridge looks it up in ANOTHER bundle. Simulate distinct module
    // instances with vi.resetModules() + a fresh dynamic import — a module-LOCAL
    // Map would make the fresh instance's lookup miss.
    registerPmWorkStore(fakeProvider("plane"));
    vi.resetModules();
    const fresh = await import("../pm-work-store-registry-contract");
    expect(fresh.lookupPmWorkStore("plane")?.providerId).toBe("plane");
    fresh.registerPmWorkStore(fakeProvider("github"));
    expect(lookupPmWorkStore("github")?.providerId).toBe("github");
    fresh._resetPmWorkStoreRegistry();
  });
});
