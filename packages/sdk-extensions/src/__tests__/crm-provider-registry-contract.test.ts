// The CRM provider registry is SDK-hosted (globalThis-anchored Map) so CRM
// provider extensions (twenty-connector) register into it and the crm-connector
// facade resolves from it WITHOUT importing each other by name.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCrmProvider,
  lookupCrmProvider,
  listCrmProviders,
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
