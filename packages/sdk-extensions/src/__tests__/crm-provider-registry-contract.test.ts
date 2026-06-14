// The CRM provider registry is SDK-hosted (globalThis-anchored Map) so CRM
// provider extensions (twenty-connector) register into it and the crm-connector
// facade resolves from it WITHOUT importing each other by name.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCrmProvider,
  lookupCrmProvider,
  listCrmProviders,
  setCrmProviderExternalResolver,
  _resetCrmProviderRegistry,
} from "../crm-provider-registry-contract";
import type { CrmConnector } from "../crm-connector-contract";

function fakeProvider(providerId: string): CrmConnector {
  // Only providerId is exercised by the registry; the verb methods are unused here.
  return { providerId } as unknown as CrmConnector;
}

afterEach(() => {
  _resetCrmProviderRegistry();
});

describe("crm-provider-registry-contract — SDK-hosted provider registry", () => {
  it("registers and looks up a provider by id", () => {
    const twenty = fakeProvider("twenty");
    registerCrmProvider(twenty);
    expect(lookupCrmProvider("twenty")).toBe(twenty);
  });

  it("returns null for an unregistered provider id", () => {
    expect(lookupCrmProvider("hubspot")).toBeNull();
  });

  it("re-registering the same id replaces (idempotent boot)", () => {
    const first = fakeProvider("twenty");
    const second = fakeProvider("twenty");
    registerCrmProvider(first);
    registerCrmProvider(second);
    expect(lookupCrmProvider("twenty")).toBe(second);
    expect(listCrmProviders()).toHaveLength(1);
  });

  it("listCrmProviders returns all registered providers", () => {
    registerCrmProvider(fakeProvider("twenty"));
    registerCrmProvider(fakeProvider("hubspot"));
    expect(listCrmProviders().map((p) => p.providerId).sort()).toEqual(["hubspot", "twenty"]);
  });

  // The external-resolver sub-slot is migrated onto createHostDepsSlot; these
  // assertions pin its lazy-pull, direct-override, throw-swallow, and reset
  // behavior (unchanged by the migration).
  describe("external resolver (capability-registry providers)", () => {
    it("surfaces external providers via lookup/list, pulled lazily on each call", () => {
      let calls = 0;
      setCrmProviderExternalResolver(() => {
        calls++;
        return [fakeProvider("twenty")];
      });
      expect(lookupCrmProvider("twenty")?.providerId).toBe("twenty");
      expect(listCrmProviders().map((p) => p.providerId)).toEqual(["twenty"]);
      expect(calls).toBeGreaterThanOrEqual(2); // pulled lazily on each resolve
    });

    it("direct registrations win over external providers with the same id", () => {
      const direct = fakeProvider("twenty");
      registerCrmProvider(direct);
      setCrmProviderExternalResolver(() => [fakeProvider("twenty")]);
      expect(lookupCrmProvider("twenty")).toBe(direct);
      expect(listCrmProviders()).toHaveLength(1);
      expect(lookupCrmProvider("twenty")).toBe(direct);
    });

    it("a throwing external resolver never takes down direct registrations", () => {
      registerCrmProvider(fakeProvider("hubspot"));
      setCrmProviderExternalResolver(() => {
        throw new Error("broken external resolver");
      });
      expect(lookupCrmProvider("hubspot")?.providerId).toBe("hubspot");
      expect(lookupCrmProvider("twenty")).toBeNull();
    });

    it("reset clears the external resolver", () => {
      setCrmProviderExternalResolver(() => [fakeProvider("twenty")]);
      _resetCrmProviderRegistry();
      expect(lookupCrmProvider("twenty")).toBeNull();
    });
  });

  it("shares the registry across SEPARATE module instances (globalThis-anchored)", async () => {
    // The whole point of the globalThis Symbol anchoring: a provider extension
    // registers in one Next.js bundle (e.g. the worker/RSC) and the facade looks
    // it up in ANOTHER bundle. Simulate distinct module instances with
    // vi.resetModules() + a fresh dynamic import — a module-LOCAL Map would make
    // the fresh instance's lookup miss.
    registerCrmProvider(fakeProvider("twenty"));
    vi.resetModules();
    const fresh = await import("../crm-provider-registry-contract");
    // Fresh instance sees the provider registered by the original instance.
    expect(fresh.lookupCrmProvider("twenty")?.providerId).toBe("twenty");
    // …and a registration through the fresh instance is visible to the original.
    fresh.registerCrmProvider(fakeProvider("hubspot"));
    expect(lookupCrmProvider("hubspot")?.providerId).toBe("hubspot");
    fresh._resetCrmProviderRegistry();
  });
});
