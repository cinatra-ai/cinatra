import { describe, it, expect } from "vitest";
import {
  classifyExtensionTrust,
  untrustedActivationMode,
  type TrustInput,
} from "@/lib/extension-trust";

// The configured marketplace host (publicRegistryUrl). The trust root is
// this HOST + a signature/bootstrap — never the package scope.
const REGISTRY = "https://registry.cinatra.ai";
const HOSTS = ["registry.cinatra.ai"] as const;

// A trusted-host, integrity-verified, persisted-decision base. Scope is varied in
// the tests to prove scope is NEVER consulted.
function base(over: Partial<TrustInput> = {}): TrustInput {
  return {
    packageName: "@cinatra-ai/foo",
    registryUrl: REGISTRY,
    integrityVerified: true,
    persistedTrustDecision: true,
    trustedActivationHosts: HOSTS,
    allowMarketplaceBootstrapTrust: true,
    ...over,
  };
}

describe("classifyExtensionTrust — vendor-agnostic, fail-closed", () => {
  it("NEVER reads scope: a non-cinatra vendor from a trusted host with a VERIFIED signature is trusted-signed", () => {
    const v = classifyExtensionTrust(base({ packageName: "@acme/widget", signatureVerified: true }));
    expect(v.trusted).toBe(true);
    expect(v.tier).toBe("trusted-signed");
  });

  it("NEVER reads scope: a @cinatra-ai package from a NON-trusted host is untrusted (scope confers zero trust)", () => {
    const v = classifyExtensionTrust(
      base({ packageName: "@cinatra-ai/foo", registryUrl: "https://evil.example.com", signatureVerified: true }),
    );
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/trusted activation host/);
  });

  it("an unsigned package from a trusted host with bootstrap ON is trusted-bootstrap", () => {
    const v = classifyExtensionTrust(base({ packageName: "@acme/widget", allowMarketplaceBootstrapTrust: true }));
    expect(v.trusted).toBe(true);
    expect(v.tier).toBe("trusted-bootstrap");
  });

  it("the SAME unsigned package with bootstrap OFF is untrusted (signature required)", () => {
    const v = classifyExtensionTrust(base({ packageName: "@acme/widget", allowMarketplaceBootstrapTrust: false }));
    expect(v.trusted).toBe(false);
    expect(v.tier).toBe("untrusted");
    expect(v.reason).toMatch(/signature required/);
  });

  it("local denied: an instance-local/private host with a VALID signature is still untrusted (host absent — host check precedes signature)", () => {
    const v = classifyExtensionTrust(
      base({ registryUrl: "https://localhost:4873", signatureVerified: true }),
    );
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/trusted activation host/);
  });

  it("fail-closed default: empty trustedActivationHosts → everything untrusted (a future 5th caller forgets to pass)", () => {
    const v = classifyExtensionTrust(base({ trustedActivationHosts: [], signatureVerified: true }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/trusted activation host/);
  });

  it("fail-closed default: trustedActivationHosts omitted entirely → untrusted", () => {
    const v = classifyExtensionTrust({
      packageName: "@cinatra-ai/foo",
      registryUrl: REGISTRY,
      integrityVerified: true,
      persistedTrustDecision: true,
      signatureVerified: true,
    });
    expect(v.trusted).toBe(false);
  });

  it("revocation WINS over a valid signature (persistedTrustDecision:false)", () => {
    const v = classifyExtensionTrust(base({ persistedTrustDecision: false, signatureVerified: true }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/revoked/);
  });

  it("refuses when integrity is not verified (before host/signature)", () => {
    const v = classifyExtensionTrust(base({ integrityVerified: false, signatureVerified: true }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toBe("tarball integrity not verified");
  });

  it("refuses when there is no persisted trust decision (required, short-circuits before host)", () => {
    const v = classifyExtensionTrust(base({ persistedTrustDecision: undefined, registryUrl: "https://evil.example.com" }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/persisted/);
  });

  it("refuses a present-but-invalid signature (tamper / wrong key) even when bootstrap is on", () => {
    const v = classifyExtensionTrust(base({ signatureVerified: false, allowMarketplaceBootstrapTrust: true }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toBe("package signature did not verify");
  });

  it("refuses when the registry host is unknown/unparseable", () => {
    const v = classifyExtensionTrust(base({ registryUrl: null, signatureVerified: true }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/trusted activation host/);
  });

  it("allow/deny PARITY: @cinatra-ai from the marketplace host, REQUIRE unset, no signature → trusted (tier trusted-bootstrap, NOT trusted-first-party)", () => {
    const v = classifyExtensionTrust(base()); // unsigned, bootstrap ON
    expect(v.trusted).toBe(true); // same allow/deny decision as main
    expect(v.tier).toBe("trusted-bootstrap"); // only the tier LABEL changed
  });
});

describe("untrustedActivationMode", () => {
  it("denies by default", () => {
    expect(untrustedActivationMode({})).toBe("deny");
  });
  it("opts into the subprocess prototype only via the explicit flag", () => {
    expect(untrustedActivationMode({ CINATRA_EXTENSION_UNTRUSTED_ISOLATION: "subprocess" })).toBe("subprocess-prototype");
    expect(untrustedActivationMode({ CINATRA_EXTENSION_UNTRUSTED_ISOLATION: "container" })).toBe("deny");
  });
});
