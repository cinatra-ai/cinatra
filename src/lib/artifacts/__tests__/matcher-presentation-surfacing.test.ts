import { describe, expect, it } from "vitest";
import {
  resolvePresentationIdentity,
  type PresentationAssertion,
  type PresentationIdentityPolicy,
} from "@cinatra-ai/objects/presentation-identity";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

// cinatra#1891 scope 8: a matcher assertion stays a DRAFT and surfaces ONLY via
// the (merged, A6) presentation resolver — auto-applied at/above the pack
// threshold, a suggestion chip below it, and the org escape-hatch toggle
// honored. This test pins the END-TO-END contract for THIS issue: the exact row
// shape the matcher runtime writes (`assertedBy:"matcher"`, `eligibility:"draft"`,
// `assertionBasis:"classic"`, a confidence) drives each of those outcomes. The
// resolver internals are covered by the A6 suite; here we prove the matcher's
// output plugs into it correctly.

// The structural (type-driven) base identity — e.g. a "document" upload.
const BASE: EffectiveIdentity = { kind: "extension", extension: "@cinatra-ai/document" };
const MEANING = "@acme/marketing-strategy-artifact";

// Exactly what matcher-runtime asserts (assertSemanticType maps matcher → draft).
function matcherDraft(confidence: number): PresentationAssertion {
  return {
    extension: MEANING,
    assertedBy: "matcher",
    eligibility: "draft",
    assertionBasis: "classic",
    confidence,
    assertedAt: "2026-07-21T00:00:00.000Z",
  };
}

function policy(over: Partial<PresentationIdentityPolicy> = {}): PresentationIdentityPolicy {
  return {
    isExtensionLive: () => true,
    matcherThreshold: () => 0.7,
    autoSurfaceDisabled: false,
    ...over,
  };
}

describe("matcher draft → presentation surfacing (scope 8)", () => {
  it("AT/ABOVE threshold → auto-surfaces as the meaning type (tier 'matcher')", () => {
    const res = resolvePresentationIdentity({
      baseIdentity: BASE,
      assertions: [matcherDraft(0.9)],
      policy: policy(),
    });
    expect(res.tier).toBe("matcher");
    expect(res.identity).toEqual({ kind: "extension", extension: MEANING });
    // The auto-surfaced draft is NOT also a suggestion chip.
    expect(res.suggestions).not.toContain(MEANING);
  });

  it("BELOW threshold → stays the structural base + offers a suggestion chip", () => {
    const res = resolvePresentationIdentity({
      baseIdentity: BASE,
      assertions: [matcherDraft(0.5)],
      policy: policy(),
    });
    expect(res.tier).toBe("claim-backed");
    expect(res.identity).toEqual(BASE);
    expect(res.suggestions).toContain(MEANING);
  });

  it("org escape-hatch toggle ON → threshold-passing draft becomes a chip only", () => {
    const res = resolvePresentationIdentity({
      baseIdentity: BASE,
      assertions: [matcherDraft(0.95)],
      policy: policy({ autoSurfaceDisabled: true }),
    });
    expect(res.tier).toBe("claim-backed");
    expect(res.identity).toEqual(BASE);
    expect(res.suggestions).toContain(MEANING);
  });

  it("a live CLASSIC (user/agent) assertion outranks the matcher draft → draft is a chip", () => {
    const classic: PresentationAssertion = {
      extension: "@acme/other-artifact",
      assertedBy: "user",
      eligibility: "eligible",
      assertionBasis: "classic",
      confidence: null,
      assertedAt: "2026-07-21T00:00:00.000Z",
    };
    const res = resolvePresentationIdentity({
      baseIdentity: BASE,
      assertions: [classic, matcherDraft(0.99)],
      policy: policy(),
    });
    expect(res.tier).toBe("classic");
    expect(res.identity).toEqual({ kind: "extension", extension: "@acme/other-artifact" });
    // The high-confidence matcher draft still shows as a suggestion chip.
    expect(res.suggestions).toContain(MEANING);
  });

  it("a matcher whose extension is NOT live never surfaces or chips", () => {
    const res = resolvePresentationIdentity({
      baseIdentity: BASE,
      assertions: [matcherDraft(0.99)],
      policy: policy({ isExtensionLive: () => false }),
    });
    expect(res.tier).toBe("claim-backed");
    expect(res.identity).toEqual(BASE);
    expect(res.suggestions).toEqual([]);
  });
});
