// Generator emission of the RAW `cinatra.dashboardContribution` pass-through onto
// NormalizedExtensionRecord (cinatra#1628, S11b). Pins the CARRIER-KIND gate +
// the raw pass-through (validation is a CONSUMPTION concern, not the generator's).
//
// PLUS the generator↔sdk-leaf PARITY guard (cinatra#1896 runtime-store carry): the
// generator's copy MUST agree with the sdk leaf's `resolveDashboardContributionClaim`
// (the single-source gate the runtime package loader now emits through) for every
// (kind, claim) input — mirrors execution-environment-emission.test.mjs.
import { describe, it, expect } from "vitest";
import { resolveDashboardContributionClaim } from "../generate-extension-manifest.mjs";
import { resolveDashboardContributionClaim as sdkResolve } from "../../../packages/sdk-extensions/src/dashboard-contribution-contract";

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

describe("resolveDashboardContributionClaim — generator↔sdk-leaf parity (cinatra#1896)", () => {
  // The runtime package loader emits through the SDK leaf's resolver; the generator
  // keeps a byte-mirror copy. They must be identical for every input, else a
  // marketplace-installed pack could carry a claim the static manifest would drop
  // (or vice-versa).
  const KINDS = ["artifact", "agent", "connector", "skill", "workflow", undefined, null, 1, {}];
  const CLAIMS = [
    { dashboardContribution: CLAIM },
    { dashboardContribution: {} },
    { dashboardContribution: undefined },
    { dashboardContribution: null },
    { dashboardContribution: [CLAIM] },
    { dashboardContribution: "x" },
    {},
    null,
    undefined,
  ];
  it("agrees with the sdk leaf for every (kind, cinatra-block) input", () => {
    for (const kind of KINDS) {
      for (const cin of CLAIMS) {
        expect(resolveDashboardContributionClaim(kind, cin)).toEqual(sdkResolve(kind, cin));
      }
    }
  });
});
