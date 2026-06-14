// The nango-system resolver (cinatra#151 Stage 1): the host resolves the
// connector-authored surface at CALL time — never by importing the package.
// Pins: degraded null resolution + the structural guard, the fail-loud
// `requireNangoSystem` with the descriptive pre-activation error (R-B), the
// delegating wrappers' call-time semantics, and the live const-map Proxies
// (property access resolves the surface at call time; pre-activation access
// fails loud, never silently empty).

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  getNangoSystem,
  requireNangoSystem,
  isNangoConfigured,
  getNangoStatus,
  getNangoCredentials,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  NANGO_CONNECTOR_DEFINITIONS,
} from "@/lib/nango-system";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";

function fakeSurface() {
  const calls: string[] = [];
  const impl = {
    isNangoConfigured: () => {
      calls.push("isNangoConfigured");
      return true;
    },
    getNangoStatus: () => ({ status: "connected" as const, detail: "live" }),
    getNangoSettings: () => ({ secretKey: "sk" }),
    getNangoCredentials: async (providerConfigKey: string, connectionId: string) => {
      calls.push(`getNangoCredentials:${providerConfigKey}:${connectionId}`);
      return { apiKey: "k" };
    },
    providerConfigKeys: { github: "cinatra-github", drupal: "cinatra-drupal" },
    connectorDefinitions: {
      github: { key: "github", title: "GitHub", usesConnectUI: true },
    },
  };
  return { impl, calls };
}

function registerSurface(impl: unknown) {
  registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
    packageName: "@cinatra-ai/nango-connector",
    impl,
  });
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("resolution + structural guard", () => {
  it("resolves null when no provider registered (degraded contexts)", () => {
    expect(getNangoSystem()).toBeNull();
  });

  it("rejects a structurally bogus impl", () => {
    registerSurface({ isNangoConfigured: true, junk: 1 });
    expect(getNangoSystem()).toBeNull();
  });

  it("requireNangoSystem fails LOUD with the descriptive pre-activation error", () => {
    expect(() => requireNangoSystem()).toThrow(/BEFORE static-bundle activation/);
    expect(() => requireNangoSystem()).toThrow(/required-extension-activation/);
  });

  it("resolves the registered surface", () => {
    const { impl } = fakeSurface();
    registerSurface(impl);
    expect(getNangoSystem()).toBe(impl);
    expect(requireNangoSystem()).toBe(impl);
  });
});

describe("delegating wrappers (call-time resolution, signatures preserved)", () => {
  it("sync wrapper delegates after registration; throws before", () => {
    expect(() => isNangoConfigured()).toThrow(/nango-system capability surface/);
    const { impl, calls } = fakeSurface();
    registerSurface(impl);
    expect(isNangoConfigured()).toBe(true);
    expect(getNangoStatus()).toEqual({ status: "connected", detail: "live" });
    expect(calls).toContain("isNangoConfigured");
  });

  it("async wrapper delegates with the exact arguments", async () => {
    const { impl, calls } = fakeSurface();
    registerSurface(impl);
    await expect(getNangoCredentials("cinatra-github", "c-1")).resolves.toEqual({ apiKey: "k" });
    expect(calls).toContain("getNangoCredentials:cinatra-github:c-1");
  });
});

describe("live const-map proxies", () => {
  it("property access resolves the surface at call time", () => {
    const { impl } = fakeSurface();
    registerSurface(impl);
    expect(CINATRA_NANGO_PROVIDER_CONFIG_KEYS.github).toBe("cinatra-github");
    expect(NANGO_CONNECTOR_DEFINITIONS.github.title).toBe("GitHub");
    expect(Object.keys(CINATRA_NANGO_PROVIDER_CONFIG_KEYS).sort()).toEqual(["drupal", "github"]);
  });

  it("pre-activation property access fails LOUD (never silently empty)", () => {
    expect(() => CINATRA_NANGO_PROVIDER_CONFIG_KEYS.github).toThrow(
      /nango-system capability surface/,
    );
  });
});
