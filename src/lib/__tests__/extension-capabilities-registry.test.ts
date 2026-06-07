import { describe, it, expect, afterEach } from "vitest";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
  invalidateProvidersForPackage,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";

describe("extension-capabilities-registry", () => {
  afterEach(() => __resetCapabilityRegistry());

  it("registers + resolves providers per capability; unknown capability resolves to []", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/resend-connector", impl: { id: "resend" } });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.packageName).toBe("@cinatra-ai/resend-connector");
    expect(resolveCapabilityProviders("unknown-capability")).toEqual([]);
  });

  it("dedupes by packageName — re-registration REPLACES (idempotent, boot re-activate safe)", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/x", impl: { v: 1 } });
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/x", impl: { v: 2 } });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    expect((providers[0]?.impl as { v: number }).v).toBe(2);
  });

  it("rejects a provider with no packageName", () => {
    expect(() =>
      registerCapabilityProvider("email-send", { packageName: "", impl: {} }),
    ).toThrow(/no packageName/);
  });

  it("invalidateProvidersForPackage drops every provider that package registered, across capabilities (teardown)", () => {
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/a", impl: {} });
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/b", impl: {} });
    registerCapabilityProvider("crm-sync", { packageName: "@cinatra-ai/a", impl: {} });

    invalidateProvidersForPackage("@cinatra-ai/a");

    expect(resolveCapabilityProviders("email-send").map((p) => p.packageName)).toEqual(["@cinatra-ai/b"]);
    expect(resolveCapabilityProviders("crm-sync")).toEqual([]);
  });
});
