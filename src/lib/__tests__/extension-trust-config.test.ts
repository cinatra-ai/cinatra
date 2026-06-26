import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  DEPLOYMENT_REGISTRY_CONFIG_FIXTURE,
  DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE,
} from "@/lib/__fixtures__/deployment-registry-config.fixture";

// Control the deployment-registry config the trust-config seam reads. This
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
import { classifyExtensionTrust } from "@/lib/extension-trust";

describe("trustedActivationHosts (guard — publicRegistryUrl ONLY)", () => {
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

describe("allowMarketplaceBootstrapTrust (fail-closed; opt-IN only)", () => {
  // Regression: the unsigned bootstrap-trust path must be OFF by default so
  // unsigned marketplace code is never imported in-process unless an operator
  // explicitly, loudly opts in. The old behavior keyed off the ABSENCE of
  // CINATRA_EXTENSION_REQUIRE_SIGNATURES, making unsigned in-process activation
  // the insecure default (opt-OUT). It is now opt-IN.
  it("OFF by default when no env is set (fail-closed — unsigned code stays inert)", () => {
    expect(allowMarketplaceBootstrapTrust({})).toBe(false);
  });

  it("REGRESSION: absence of CINATRA_EXTENSION_REQUIRE_SIGNATURES no longer re-opens the unsigned path", () => {
    // The vuln: previously this returned true (unsigned import allowed) when the
    // require-signatures flag was simply unset. It must now be false.
    expect(allowMarketplaceBootstrapTrust({})).toBe(false);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_REQUIRE_SIGNATURES: "false" })).toBe(false);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_REQUIRE_SIGNATURES: "1" })).toBe(false);
  });

  it("ON only with the explicit loud opt-in CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP=true (dev/transition)", () => {
    expect(
      allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "true" }),
    ).toBe(true);
  });

  it("opt-in requires the EXACT string 'true' (no truthy coercion)", () => {
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "1" })).toBe(false);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "TRUE" })).toBe(false);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "yes" })).toBe(false);
    expect(allowMarketplaceBootstrapTrust({ CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "" })).toBe(false);
  });

  it("the opt-in is independent of CINATRA_EXTENSION_REQUIRE_SIGNATURES (decoupled flags)", () => {
    // Even if require-signatures were set, the unsigned path is still gated solely
    // by the explicit opt-in — there is no implicit coupling that could re-open it.
    expect(
      allowMarketplaceBootstrapTrust({
        CINATRA_EXTENSION_REQUIRE_SIGNATURES: "true",
        CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP: "true",
      }),
    ).toBe(true);
  });
});

// End-to-end regression: an unsigned, integrity-verified, persisted-decision
// package from a TRUSTED activation host must NOT become an in-process
// import-trusted record by default. This wires the real env-derived config seam
// into the real classifier — the path the runtime loader executes.
describe("env-derived trust classification — fail-closed default", () => {
  beforeEach(() => {
    mockLoad.mockReset();
    mockLoad.mockReturnValue(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE); // host = registry.cinatra.ai
    delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  // The malicious-but-authorized-install scenario from the issue.
  const unsignedMarketplacePkg = () => ({
    packageName: "@evil/marketplace-widget",
    registryUrl: "https://registry.cinatra.ai/@evil/marketplace-widget",
    integrityVerified: true, // bytes matched the recorded digest
    persistedTrustDecision: true, // an authorized user installed it
    signatureVerified: undefined as boolean | undefined, // NO signature
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  });

  it("NEGATIVE (regression): unsigned marketplace pkg with NO env set → untrusted (NOT imported in-process)", () => {
    const v = classifyExtensionTrust(unsignedMarketplacePkg());
    expect(v.trusted).toBe(false);
    expect(v.tier).toBe("untrusted");
    expect(v.reason).toMatch(/signature required/i);
  });

  it("NEGATIVE (regression): merely UNsetting REQUIRE_SIGNATURES does not re-open in-process import", () => {
    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "false";
    const v = classifyExtensionTrust(unsignedMarketplacePkg());
    expect(v.trusted).toBe(false);
    expect(v.tier).toBe("untrusted");
  });

  it("POSITIVE: a verified-signature marketplace pkg still activates (trusted-signed) by default", () => {
    const v = classifyExtensionTrust({
      ...unsignedMarketplacePkg(),
      signatureVerified: true,
    });
    expect(v.trusted).toBe(true);
    expect(v.tier).toBe("trusted-signed");
  });

  it("DEV opt-in: CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP=true re-enables trusted-bootstrap (transition only)", () => {
    process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = "true";
    try {
      const v = classifyExtensionTrust(unsignedMarketplacePkg());
      expect(v.trusted).toBe(true);
      expect(v.tier).toBe("trusted-bootstrap");
    } finally {
      delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
    }
  });
});
