// The PM provider registry is SDK-hosted (globalThis-anchored Map) so PM
// provider extensions (plane-connector) register into it and the host PM bridge
// resolves from it WITHOUT importing each other by name. Mirrors the CRM
// provider registry test.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPmProvider,
  lookupPmProvider,
  listPmProviders,
  setPmProviderExternalResolver,
  _resetPmProviderRegistry,
} from "../pm-provider-registry-contract";
import type { PmConnector } from "../pm-connector-contract";

function fakeProvider(providerId: string): PmConnector {
  // Only providerId is exercised by the registry; the verb methods are unused here.
  return { providerId } as unknown as PmConnector;
}

afterEach(() => {
  _resetPmProviderRegistry();
});

describe("pm-provider-registry-contract — SDK-hosted provider registry", () => {
  it("registers and looks up a provider by id", () => {
    const plane = fakeProvider("plane");
    registerPmProvider(plane);
    expect(lookupPmProvider("plane")).toBe(plane);
  });

  it("returns null for an unregistered provider id", () => {
    expect(lookupPmProvider("linear")).toBeNull();
  });

  it("re-registering the same id replaces (idempotent boot)", () => {
    const first = fakeProvider("plane");
    const second = fakeProvider("plane");
    registerPmProvider(first);
    registerPmProvider(second);
    expect(lookupPmProvider("plane")).toBe(second);
    expect(listPmProviders()).toHaveLength(1);
  });

  it("listPmProviders returns all registered providers", () => {
    registerPmProvider(fakeProvider("plane"));
    registerPmProvider(fakeProvider("linear"));
    expect(listPmProviders().map((p) => p.providerId).sort()).toEqual(["linear", "plane"]);
  });

  describe("external resolver (capability-registry providers)", () => {
    it("surfaces external providers via lookup/list, pulled lazily on each call", () => {
      let calls = 0;
      setPmProviderExternalResolver(() => {
        calls++;
        return [fakeProvider("plane")];
      });
      expect(lookupPmProvider("plane")?.providerId).toBe("plane");
      expect(listPmProviders().map((p) => p.providerId)).toEqual(["plane"]);
      expect(calls).toBeGreaterThanOrEqual(2); // pulled lazily on each resolve
    });

    it("direct registrations win over external providers with the same id", () => {
      const direct = fakeProvider("plane");
      registerPmProvider(direct);
      setPmProviderExternalResolver(() => [fakeProvider("plane")]);
      expect(lookupPmProvider("plane")).toBe(direct);
      expect(listPmProviders()).toHaveLength(1);
      expect(lookupPmProvider("plane")).toBe(direct);
    });

    it("a throwing external resolver never takes down direct registrations", () => {
      registerPmProvider(fakeProvider("linear"));
      setPmProviderExternalResolver(() => {
        throw new Error("broken external resolver");
      });
      expect(lookupPmProvider("linear")?.providerId).toBe("linear");
      expect(lookupPmProvider("plane")).toBeNull();
    });

    it("reset clears the external resolver", () => {
      setPmProviderExternalResolver(() => [fakeProvider("plane")]);
      _resetPmProviderRegistry();
      expect(lookupPmProvider("plane")).toBeNull();
    });
  });

  it("shares the registry across SEPARATE module instances (globalThis-anchored)", async () => {
    // A provider extension registers in one Next.js bundle (e.g. the worker/RSC)
    // and the host bridge looks it up in ANOTHER bundle. Simulate distinct module
    // instances with vi.resetModules() + a fresh dynamic import — a module-LOCAL
    // Map would make the fresh instance's lookup miss.
    registerPmProvider(fakeProvider("plane"));
    vi.resetModules();
    const fresh = await import("../pm-provider-registry-contract");
    expect(fresh.lookupPmProvider("plane")?.providerId).toBe("plane");
    fresh.registerPmProvider(fakeProvider("linear"));
    expect(lookupPmProvider("linear")?.providerId).toBe("linear");
    fresh._resetPmProviderRegistry();
  });
});
