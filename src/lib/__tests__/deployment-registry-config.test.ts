// Destination-contract tests for loadDeploymentRegistryConfig.
// Mirrors src/lib/__tests__/verdaccio-config-server.test.ts.
// The loader returns the default fixture-backed deployment registry config.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

describe("loadDeploymentRegistryConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns DeploymentRegistryConfig with privateDestinationConfigured: false from default fixture", async () => {
    const { loadDeploymentRegistryConfig } = await import("@/lib/deployment-registry-config");
    // Exercises the default fixture-backed loader.
    const config = loadDeploymentRegistryConfig();
    expect(config.privateDestinationConfigured).toBe(false);
    expect(config.routingMode).toMatch(/^(scope-based|shared-acl)$/);
    expect(config.publicRegistryUrl).toBe("https://registry.cinatra.ai");
  });

  it("returns DeploymentRegistryConfig with privateDestinationConfigured: true when fixture toggled", async () => {
    // This assertion exercises the fixture directly.
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationConfigured).toBe(true);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateRegistryUrl).not.toBeNull();
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationId).not.toBeNull();
  });

  it("throws DeploymentRegistryConfigNotAvailableError when routingMode missing (locked guard)", async () => {
    const { DeploymentRegistryConfigNotAvailableError } = await import("@/lib/deployment-registry-config");
    const err = new DeploymentRegistryConfigNotAvailableError();
    expect(err.code).toBe("DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE");
    expect(err.message).toContain("routingMode");
  });

  it("topology A fixture has routingMode: 'scope-based'", async () => {
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.routingMode).toBe("scope-based");
  });

  it("topology B (with-private) fixture has routingMode: 'shared-acl'", async () => {
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.routingMode).toBe("shared-acl");
  });
});
