// cinatra.dashboardContribution v1 leaf schema + tolerant parse (cinatra#1628,
// S11a). Pins the CANONICAL v1 shape: valid claim, carrier-kind allowlist,
// versioned contributionVersion, contribution-key grammar, sidecar containment,
// adopts validation, generated sdkAbiRange satisfaction, strict unknown-key
// rejection, and the sanitized field-tolerant degradation contract (no value leak).
import { describe, it, expect } from "vitest";
import {
  DASHBOARD_CONTRIBUTION_ABI_VERSION,
  DASHBOARD_CONTRIBUTION_CARRIER_KINDS,
  DASHBOARD_CONTRIBUTION_SDK_ABI_RANGE,
  isDashboardContributionCarrierKind,
  isValidContributionKey,
  parseDashboardContribution,
  validateDashboardContributionForPublish,
} from "../dashboard-contribution-contract";
import { SDK_EXTENSIONS_ABI_VERSION } from "../register";

const validClaim = (overrides: Record<string, unknown> = {}) => ({
  abiVersion: DASHBOARD_CONTRIBUTION_ABI_VERSION,
  sdkAbiRange: DASHBOARD_CONTRIBUTION_SDK_ABI_RANGE,
  contributionVersion: 1,
  contributionKey: "blog-operator",
  ...overrides,
});

describe("dashboardContribution v1 — constants + carrier allowlist", () => {
  it("the claim ABI version is 1", () => {
    expect(DASHBOARD_CONTRIBUTION_ABI_VERSION).toBe(1);
  });
  it("the carrier-kind allowlist is exactly {agent} (workflow is NOT a carrier)", () => {
    expect([...DASHBOARD_CONTRIBUTION_CARRIER_KINDS]).toEqual(["agent"]);
    expect(isDashboardContributionCarrierKind("agent")).toBe(true);
    for (const k of ["workflow", "connector", "artifact", "skill", null, undefined, 1]) {
      expect(isDashboardContributionCarrierKind(k)).toBe(false);
    }
  });
  it("SDK ABI range is a caret over the canonical SDK ABI (generated, never hand-written)", () => {
    expect(DASHBOARD_CONTRIBUTION_SDK_ABI_RANGE).toBe(`^${SDK_EXTENSIONS_ABI_VERSION}`);
  });
  it("contributionKey grammar is strict lowercase kebab", () => {
    for (const ok of ["blog-operator", "x", "a1-b2-c3"]) expect(isValidContributionKey(ok)).toBe(true);
    for (const bad of ["Blog", "blog_operator", "-lead", "trail-", "a--b", "", 1, null]) {
      expect(isValidContributionKey(bad as unknown)).toBe(false);
    }
  });
});

describe("dashboardContribution v1 — valid parse", () => {
  it("accepts a minimal valid claim", () => {
    const r = parseDashboardContribution(validClaim());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contribution.contributionVersion).toBe(1);
      expect(r.contribution.contributionKey).toBe("blog-operator");
    }
  });
  it("accepts an optional contained sidecar path + adopts edges", () => {
    const r = parseDashboardContribution(
      validClaim({
        sidecar: "./cinatra/dashboard.json",
        adopts: [{ legacyPackage: "@cinatra-ai/blog-content-workflow", legacyContributionKey: "blog-operator" }],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("dashboardContribution v1 — field-tolerant rejection (degrade, no value leak)", () => {
  it("rejects a non-literal abiVersion", () => {
    const r = parseDashboardContribution(validClaim({ abiVersion: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic).toMatch(/cinatra\.dashboardContribution is invalid/);
  });
  it("rejects contributionVersion < 1 / non-integer", () => {
    expect(parseDashboardContribution(validClaim({ contributionVersion: 0 })).ok).toBe(false);
    expect(parseDashboardContribution(validClaim({ contributionVersion: 1.5 })).ok).toBe(false);
  });
  it("rejects an unknown top-level key (.strict v1 closed shape)", () => {
    const r = parseDashboardContribution(validClaim({ requestedHostPorts: ["capabilities"] }));
    expect(r.ok).toBe(false);
  });
  it("rejects a non-contained sidecar path (traversal / absolute / URL)", () => {
    for (const bad of ["../secret", "/etc/passwd", "https://evil/x", "cinatra/dashboard.json"]) {
      expect(parseDashboardContribution(validClaim({ sidecar: bad })).ok).toBe(false);
    }
  });
  it("rejects an empty / duplicate adopts list", () => {
    expect(parseDashboardContribution(validClaim({ adopts: [] })).ok).toBe(false);
    const dup = [
      { legacyPackage: "@cinatra-ai/x", legacyContributionKey: "k" },
      { legacyPackage: "@cinatra-ai/x", legacyContributionKey: "k" },
    ];
    expect(parseDashboardContribution(validClaim({ adopts: dup })).ok).toBe(false);
  });
  it("rejects an sdkAbiRange the host SDK does not satisfy", () => {
    const r = parseDashboardContribution(validClaim({ sdkAbiRange: "^99.0.0" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic).toMatch(/does not satisfy/);
  });
  it("the diagnostic never echoes a received value (sanitized: path + code only)", () => {
    const r = parseDashboardContribution(validClaim({ contributionKey: "SECRET_VALUE_XYZ" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic).not.toContain("SECRET_VALUE_XYZ");
  });
  it("never throws on hostile / non-object input", () => {
    for (const bad of [null, undefined, 42, "x", [], { abiVersion: {} }]) {
      expect(() => parseDashboardContribution(bad)).not.toThrow();
      expect(parseDashboardContribution(bad).ok).toBe(false);
    }
  });
});

describe("dashboardContribution v1 — publish verdict (fail-closed + carrier-gated)", () => {
  it("accepts a valid claim on kind:agent", () => {
    expect(validateDashboardContributionForPublish(validClaim(), "agent")).toEqual({ valid: true, errors: [] });
  });
  it("REJECTS a valid claim authored on a non-agent kind", () => {
    for (const kind of ["workflow", "connector", "artifact", "skill"]) {
      const v = validateDashboardContributionForPublish(validClaim(), kind);
      expect(v.valid).toBe(false);
      expect(v.errors[0]).toMatch(/only on kind:"agent"/);
    }
  });
  it("REJECTS a malformed claim on kind:agent (fail-closed, unlike the degrading boot path)", () => {
    const v = validateDashboardContributionForPublish(validClaim({ contributionKey: "Bad Key" }), "agent");
    expect(v.valid).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });
});
