// Tenant-scoping the extension-facing capability surface.
//
// The `ctx.capabilities.resolveProviders` port was a RAW passthrough to the host
// capability registry, so any extension granted the `capabilities` port could
// resolve the host-internal `nango-system` capability and obtain
// `getNangoCredentials(providerConfigKey, connectionId)` — a connectionId-
// addressed credential reader with NO per-tenant binding — reading ANY stored
// connection's credentials.
//
// A NON-first-party (third-party marketplace) extension is now fail-closed for
// the reserved system credential capabilities: RESOLVE → [] (never obtains the
// surface) and REGISTER → throw (cannot poison the id with a shadow provider).
// FIRST-PARTY extensions (compiled into the host build, in
// STATIC_EXTENSION_MANIFEST — regardless of whether they activate via the static
// bundle OR the runtime package store) and HOST-INTERNAL resolution (which does
// not go through the port) are unaffected.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createExtensionHostContext, createExtensionProbeHostContext } from "@/lib/extension-host-context";
import {
  __resetCapabilityRegistry,
  registerCapabilityProvider,
  resolveCapabilityProviders,
} from "@/lib/extension-capabilities-registry";
import {
  NANGO_SYSTEM_CAPABILITY,
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  LLM_PROVIDER_ADAPTER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

// Real first-party host-build packages (the gate is keyed on package identity,
// not the activation loader). `nango-connector` REGISTERS the surface;
// `apollo-connector` RESOLVES it to build its deps.
const FIRST_PARTY_REGISTRAR = "@cinatra-ai/nango-connector";
const FIRST_PARTY_CONSUMER = "@cinatra-ai/apollo-connector";
// A package NOT compiled into the host build → third-party / marketplace.
const THIRD_PARTY = "@cinatra-ai/some-marketplace-connector";

// A minimal stand-in for the nango-system surface. `getNangoCredentials` returns
// a per-connection secret so a "cross-tenant read" is observable: if a connector
// could reach this surface it could read tenant B's credentials by passing
// tenant B's connectionId.
function fakeNangoSystemSurface() {
  const secretsByConnection: Record<string, string> = {
    "tenant-a-connection": "tenant-A-oauth-token",
    "tenant-b-connection": "tenant-B-oauth-token",
  };
  return {
    isNangoConfigured: () => true,
    getNangoStatus: () => ({ status: "connected" }),
    getNangoSettings: () => ({}),
    providerConfigKeys: {},
    getNangoCredentials: (_providerConfigKey: string, connectionId: string) =>
      secretsByConnection[connectionId] ?? null,
  };
}

const CAP = "capabilities" as const;

describe("extension-facing capability port — reserved system credential capabilities", () => {
  // The capability registry is module-global; isolate tests that register.
  afterEach(() => {
    __resetCapabilityRegistry();
    vi.restoreAllMocks();
  });

  it("premise: the first-party fixtures ARE in the host build and the third-party name is NOT", () => {
    expect(STATIC_EXTENSION_MANIFEST[FIRST_PARTY_REGISTRAR]).toBeDefined();
    expect(STATIC_EXTENSION_MANIFEST[FIRST_PARTY_CONSUMER]).toBeDefined();
    expect(STATIC_EXTENSION_MANIFEST[THIRD_PARTY]).toBeUndefined();
  });

  it("THIRD-PARTY: resolveProviders('nango-system') returns [] even when a provider IS registered (cross-tenant credential read fails closed)", () => {
    // The first-party nango gateway has published the surface.
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: FIRST_PARTY_REGISTRAR,
      impl: fakeNangoSystemSurface(),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const thirdPartyCtx = createExtensionHostContext(THIRD_PARTY, [CAP]);

    const resolved = thirdPartyCtx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY);
    // Fail-closed: the third-party connector never obtains the surface...
    expect(resolved).toEqual([]);
    // ...so it cannot reach getNangoCredentials for ANY tenant's connection.
    expect(resolved[0]).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    // Host-internal resolution (NOT through the port) still sees the surface, so
    // the host's own gated call sites keep working.
    const hostSide = resolveCapabilityProviders(NANGO_SYSTEM_CAPABILITY);
    expect(hostSide).toHaveLength(1);
    const surface = hostSide[0].impl as unknown as ReturnType<typeof fakeNangoSystemSurface>;
    expect(surface.getNangoCredentials("cinatra-x", "tenant-b-connection")).toBe(
      "tenant-B-oauth-token",
    );
  });

  it("FIRST-PARTY consumer: resolveProviders('nango-system') returns the surface (no regression — works via either loader)", () => {
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: FIRST_PARTY_REGISTRAR,
      impl: fakeNangoSystemSurface(),
    });

    const ctx = createExtensionHostContext(FIRST_PARTY_CONSUMER, [CAP]);
    const resolved = ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY);
    expect(resolved).toHaveLength(1);
    const surface = resolved[0].impl as unknown as ReturnType<typeof fakeNangoSystemSurface>;
    expect(surface.getNangoCredentials("cinatra-x", "tenant-a-connection")).toBe(
      "tenant-A-oauth-token",
    );
  });

  it("THIRD-PARTY: registerProvider('nango-system') THROWS and does NOT poison the registry (host resolution still selects only the real provider)", () => {
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: FIRST_PARTY_REGISTRAR,
      impl: fakeNangoSystemSurface(),
    });

    const thirdPartyCtx = createExtensionHostContext(THIRD_PARTY, [CAP]);

    expect(() =>
      thirdPartyCtx.capabilities.registerProvider(NANGO_SYSTEM_CAPABILITY, {
        packageName: THIRD_PARTY,
        impl: { isNangoConfigured: () => true, getNangoCredentials: () => "ATTACKER" },
      }),
    ).toThrow(/may not register\b[\s\S]*host-internal system capability/i);

    // Registry unpoisoned: only the real first-party provider remains, so the
    // host's `resolveCapabilityProviders(...)[0]` can never select a shadow.
    const hostSide = resolveCapabilityProviders(NANGO_SYSTEM_CAPABILITY);
    expect(hostSide).toHaveLength(1);
    expect(hostSide[0].packageName).toBe(FIRST_PARTY_REGISTRAR);
  });

  it("FIRST-PARTY registrar: registerProvider('nango-system') succeeds (the real nango gateway path — activated via the runtime store too — is unaffected)", () => {
    const firstPartyCtx = createExtensionHostContext(FIRST_PARTY_REGISTRAR, [CAP]);
    expect(() =>
      firstPartyCtx.capabilities.registerProvider(NANGO_SYSTEM_CAPABILITY, {
        packageName: FIRST_PARTY_REGISTRAR,
        impl: fakeNangoSystemSurface(),
      }),
    ).not.toThrow();
    expect(resolveCapabilityProviders(NANGO_SYSTEM_CAPABILITY)).toHaveLength(1);
  });

  it("NON-reserved capabilities (email-send + custom) resolve AND register for BOTH first-party and third-party (the gate is not over-broad)", () => {
    for (const pkg of [FIRST_PARTY_CONSUMER, THIRD_PARTY]) {
      __resetCapabilityRegistry();
      const ctx = createExtensionHostContext(pkg, [CAP]);
      // register + resolve a custom capability round-trips.
      ctx.capabilities.registerProvider("my-cap", { packageName: pkg, impl: { hi: true } });
      expect(ctx.capabilities.resolveProviders("my-cap")).toHaveLength(1);
      // an unrelated known capability resolves normally (empty here, but NOT denied).
      expect(() => ctx.capabilities.resolveProviders("email-send")).not.toThrow();
      expect(ctx.capabilities.resolveProviders("not-a-capability")).toEqual([]);
    }
  });

  it("instance-connection-gate (#975 Wave 3, epic #978) is RESERVED: third-party resolve fails closed ([]), first-party resolves; register through the port is denied for everyone (host namespace)", () => {
    const GATE = HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate;
    // The host published the seam (register-host-connector-services binds the
    // real impl; a stand-in suffices for the fence assertion).
    registerCapabilityProvider(GATE, {
      packageName: "@cinatra-ai/host",
      impl: { resolveOrSeedInstanceIdentity: async () => ({ identityResolved: true }) },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Third-party marketplace code must not ambiently seed identities or
    // probe authorization: fail-closed resolve.
    const thirdPartyCtx = createExtensionHostContext(THIRD_PARTY, [CAP]);
    expect(thirdPartyCtx.capabilities.resolveProviders(GATE)).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // First-party connectors (the relocated vendor clients) resolve it — the
    // import-era in-process trust boundary, preserved.
    const firstPartyCtx = createExtensionHostContext(FIRST_PARTY_CONSUMER, [CAP]);
    expect(firstPartyCtx.capabilities.resolveProviders(GATE)).toHaveLength(1);

    // A THIRD-PARTY register attempt is denied fail-loud (anti-poisoning —
    // the reserved-system fence, same as nango-system).
    expect(() =>
      thirdPartyCtx.capabilities.registerProvider(GATE, {
        packageName: THIRD_PARTY,
        impl: {},
      }),
    ).toThrow(/may not register\b[\s\S]*host-internal system capability/i);

    // A first-party register is bound to ITS OWN identity (never
    // "@cinatra-ai/host"), so the host's provider selection — which filters
    // packageName === "@cinatra-ai/host" — can never pick an extension
    // registration even from first-party code.
    firstPartyCtx.capabilities.registerProvider(GATE, {
      packageName: "@cinatra-ai/host",
      impl: { spoofed: true },
    });
    const providers = resolveCapabilityProviders(GATE);
    expect(providers.filter((pr) => pr.packageName === "@cinatra-ai/host")).toHaveLength(1);
    expect(
      providers.find((pr) => pr.packageName === FIRST_PARTY_CONSUMER)?.impl,
    ).toEqual({ spoofed: true });
  });

  it("llm-provider-adapter (llm-providers S4, cinatra#1715) is RESERVED: third-party register THROWS + resolve is [] (LLM data plane is first-party only); first-party register/resolve works", () => {
    const CAP_ID = LLM_PROVIDER_ADAPTER_CAPABILITY;
    // A minimal adapter surface (the gate is package-identity-based; any
    // first-party package suffices for the fence assertion — the real registrars
    // are the openai/anthropic/gemini connectors).
    const adapterImpl = {
      abiVersion: 1,
      providerId: "openai",
      createAdapter: async () => ({ provider: "openai" }),
    };

    const firstPartyCtx = createExtensionHostContext(FIRST_PARTY_REGISTRAR, [CAP]);
    expect(() =>
      firstPartyCtx.capabilities.registerProvider(CAP_ID, {
        packageName: FIRST_PARTY_REGISTRAR,
        impl: adapterImpl,
      }),
    ).not.toThrow();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A THIRD-PARTY marketplace extension must not intercept the LLM data plane:
    // fail-closed resolve.
    const thirdPartyCtx = createExtensionHostContext(THIRD_PARTY, [CAP]);
    expect(thirdPartyCtx.capabilities.resolveProviders(CAP_ID)).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // …and a third-party REGISTER is denied fail-loud (anti-poisoning — the
    // shadow adapter never enters the registry).
    expect(() =>
      thirdPartyCtx.capabilities.registerProvider(CAP_ID, {
        packageName: THIRD_PARTY,
        impl: { abiVersion: 1, providerId: "openai", createAdapter: async () => ({ hijacked: true }) },
      }),
    ).toThrow(/may not register\b[\s\S]*host-internal system capability/i);

    // Registry unpoisoned: only the first-party registration remains, so the
    // host resolver can never select a third-party shadow.
    const hostSide = resolveCapabilityProviders(CAP_ID);
    expect(hostSide).toHaveLength(1);
    expect(hostSide[0].packageName).toBe(FIRST_PARTY_REGISTRAR);
  });

  it("PROBE parity: a third-party probe denies reserved resolve ([]) and reserved register (throws); a first-party probe resolves normally", () => {
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: FIRST_PARTY_REGISTRAR,
      impl: fakeNangoSystemSurface(),
    });
    const { ctx } = createExtensionProbeHostContext(THIRD_PARTY, [CAP]);
    expect(ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)).toEqual([]);
    expect(() =>
      ctx.capabilities.registerProvider(NANGO_SYSTEM_CAPABILITY, {
        packageName: THIRD_PARTY,
        impl: {},
      }),
    ).toThrow(/may not register\b[\s\S]*host-internal system capability/i);

    // A first-party probe still resolves it (no regression).
    const firstParty = createExtensionProbeHostContext(FIRST_PARTY_CONSUMER, [CAP]);
    expect(firstParty.ctx.capabilities.resolveProviders(NANGO_SYSTEM_CAPABILITY)).toHaveLength(1);
  });
});
