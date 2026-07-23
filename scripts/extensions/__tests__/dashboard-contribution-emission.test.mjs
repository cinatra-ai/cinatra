// Generator emission of the RAW `cinatra.dashboardContribution` pass-through onto
// NormalizedExtensionRecord (cinatra#1628, S11b). Pins the CARRIER-KIND gate +
// the raw pass-through (validation is a CONSUMPTION concern, not the generator's).
import { describe, it, expect } from "vitest";
import { resolveDashboardContributionClaim } from "../generate-extension-manifest.mjs";

const CLAIM = {
  abiVersion: 1,
  sdkAbiRange: "^2",
  contributionVersion: 1,
  contributionKey: "blog-operator",
  adopts: [{ legacyPackage: "@cinatra-ai/blog-content-workflow", legacyContributionKey: "blog" }],
};

describe("resolveDashboardContributionClaim — generator emission", () => {
  it("emits the RAW claim on kind:artifact (carried UNVALIDATED — the host parses it at consumption)", () => {
    expect(resolveDashboardContributionClaim("artifact", { dashboardContribution: CLAIM })).toBe(CLAIM);
  });

  it("emits null on kind:artifact when the pack declares no claim", () => {
    expect(resolveDashboardContributionClaim("artifact", {})).toBeNull();
    expect(resolveDashboardContributionClaim("artifact", { dashboardContribution: undefined })).toBeNull();
  });

  it("emits null on kind:artifact when the claim is not an object (array / string)", () => {
    expect(resolveDashboardContributionClaim("artifact", { dashboardContribution: [CLAIM] })).toBeNull();
    expect(resolveDashboardContributionClaim("artifact", { dashboardContribution: "x" })).toBeNull();
  });

  it("CARRIER-KIND GATED: null on every non-artifact kind (incl. the retired agent carrier) even when a claim is present", () => {
    for (const kind of ["agent", "connector", "skill", "workflow", undefined]) {
      expect(resolveDashboardContributionClaim(kind, { dashboardContribution: CLAIM })).toBeNull();
    }
  });
});
