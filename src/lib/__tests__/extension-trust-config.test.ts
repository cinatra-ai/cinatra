import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  DEPLOYMENT_REGISTRY_CONFIG_FIXTURE,
  DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE,
} from "@/lib/__fixtures__/deployment-registry-config.fixture";

// Control the deployment-registry config the trust-config seam reads. The A2
// guard is the whole point of this module: the host allowlist must derive ONLY
// from publicRegistryUrl, never the private/identity/env registries.
const mockLoad = vi.fn();
vi.mock("@/lib/deployment-registry-config", () => ({
  loadDeploymentRegistryConfig: () => mockLoad(),
  DeploymentRegistryConfigNotAvailableError: class extends Error {},
}));

import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";

describe("trustedActivationHosts (A2 guard — publicRegistryUrl ONLY)", () => {
  beforeEach(() => {
    mockLoad.mockReset();
    delete process.env.CINATRA_AGENT_REGISTRY_URL;
  });

  it("derives the host from publicRegistryUrl", () => {
    mockLoad.mockReturnValue(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE);
    expect(trustedActivationHosts()).toEqual(["registry.cinatra.ai"]);
  });

  it("A2: NEVER includes privateRegistryUrl even when it IS configured", () => {
    mockLoad.mockReturnValue(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE);
    const hosts = trustedActivationHosts();
    expect(hosts).toEqual(["registry.cinatra.ai"]);
    expect(hosts).not.toContain("private.registry.example.com");
  });

  it("A2: no free-form host-override env leaks in (CINATRA_AGENT_REGISTRY_URL is ignored)", () => {
    mockLoad.mockReturnValue(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE);
    process.env.CINATRA_AGENT_REGISTRY_URL = "https://attacker.example.com";
    try {
      expect(trustedActivationHosts()).toEqual(["registry.cinatra.ai"]);
    } finally {
      delete process.env.CINATRA_AGENT_REGISTRY_URL;
    }
  });

  it("fail-closed: an empty publicRegistryUrl → []", () => {
    mockLoad.mockReturnValue({ ...DEPLOYMENT_REGISTRY_CONFIG_FIXTURE, publicRegistryUrl: "" });
    expect(trustedActivationHosts()).toEqual([]);
  });

  it("fail-closed: a malformed (non-URL) publicRegistryUrl → []", () => {
    mockLoad.mockReturnValue({ ...DEPLOYMENT_REGISTRY_CONFIG_FIXTURE, publicRegistryUrl: "not a url" });
    expect(trustedActivationHosts()).toEqual([]);
  });

  it("fail-closed (boot-safe): a throw while resolving the config → [] (never bricks boot)", () => {
    mockLoad.mockImplementation(() => {
      throw new Error("deployment config malformed");
    });
    expect(trustedActivationHosts()).toEqual([]);
  });
});

describe("allowMarketplaceBootstrapTrust (single transition lever = !signaturesRequired)", () => {
  it("ON (Windows 1-2) when CINATRA_EXTENSION_REQUIRE_SIGNATURES is unset", () => {
    expect(allowMarketplaceBootstrapTrust({})).toBe(true);
  });

  it("OFF (Window-3) when CINATRA_EXTENSION_REQUIRE_SIGNATURES=true", () => {
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_REQUIRE_SIGNATURES: "true" })).toBe(false);
  });

  it("ON for any non-'true' value (only the exact 'true' flips it)", () => {
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_REQUIRE_SIGNATURES: "1" })).toBe(true);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_REQUIRE_SIGNATURES: "false" })).toBe(true);
  });
});
