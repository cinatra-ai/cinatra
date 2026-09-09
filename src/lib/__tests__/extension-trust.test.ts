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

// ---------------------------------------------------------------------------
// THE OPERATOR-SUPPLIED ACTIVATION ORIGIN (cinatra#3204).
//
// The issue's headline is that each of the four kinds installs from a file
// archive or a resolved repository EXACTLY as the store installs it. A connector
// is the kind whose whole install exists to run `register(ctx)` in this process,
// so it is the kind that has to pass this classifier — and it could not, on any
// deployment, because the supplied road carries no registry URL and the origin
// factor only ever accepted a host from the deployment's allowlist.
//
// The road is the other answer to that factor. These cases hold BOTH halves of
// the fix: the supplied road is admitted, and admitting it moves nothing else —
// every other factor still refuses exactly as it did, and a STORE-road package
// is judged byte-for-byte as before.
// ---------------------------------------------------------------------------
describe("the operator-supplied road is an activation origin of the same standing as the store", () => {
  // The host policy of a deployment with NO configured marketplace at all: no
  // activation host, and the unsigned-bootstrap lever off. A store install
  // reaches nothing here — which is the point: the supplied road stands on the
  // supply act, not on a registry the deployment may not even have.
  function supplied(over: Partial<TrustInput> = {}): TrustInput {
    return {
      packageName: "@acme/thing-connector",
      registryUrl: "supplied:operator",
      integrityVerified: true,
      persistedTrustDecision: true,
      trustedActivationHosts: [],
      allowMarketplaceBootstrapTrust: false,
      operatorSuppliedOrigin: true,
      ...over,
    };
  }

  it("admits an unsigned supplied package with no activation host configured at all", () => {
    const v = classifyExtensionTrust(supplied());
    expect(v.trusted).toBe(true);
    expect(v.tier).toBe("trusted-bootstrap");
    expect(v.reason).toMatch(/supplied/i);
  });

  it("admits it for IMPORT only — never the privileged tier, without a verified signature", () => {
    expect(classifyExtensionTrust(supplied()).tier).not.toBe("trusted-signed");
    // A supplied package that IS signed against a host-trusted key reaches the
    // privileged tier on the same terms as any other road.
    expect(classifyExtensionTrust(supplied({ signatureVerified: true })).tier).toBe("trusted-signed");
  });

  it("still refuses a supplied package whose trust decision was REVOKED", () => {
    const v = classifyExtensionTrust(supplied({ persistedTrustDecision: false }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toBe("trust explicitly revoked by host decision");
  });

  it("still refuses a supplied package whose integrity was not verified", () => {
    const v = classifyExtensionTrust(supplied({ integrityVerified: false }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toBe("tarball integrity not verified");
  });

  it("still refuses a supplied package whose attested signature did NOT verify", () => {
    const v = classifyExtensionTrust(supplied({ signatureVerified: false }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toBe("package signature did not verify");
  });

  it("does NOT move the store road: the same inputs without the supplied origin stay untrusted", () => {
    const v = classifyExtensionTrust(supplied({ operatorSuppliedOrigin: false }));
    expect(v.trusted).toBe(false);
    expect(v.reason).toMatch(/not a trusted activation host/);
    // And a package from a host that is NOT on the allowlist is refused whether
    // or not the deployment has one configured.
    const offHost = classifyExtensionTrust(
      supplied({
        operatorSuppliedOrigin: false,
        registryUrl: "https://evil.example.com",
        trustedActivationHosts: ["registry.cinatra.ai"],
        allowMarketplaceBootstrapTrust: true,
      }),
    );
    expect(offHost.trusted).toBe(false);
    expect(offHost.reason).toMatch(/not a trusted activation host/);
  });
});
