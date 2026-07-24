// Boot-trigger fan-out (cinatra#1628, S11c / remaining AC2): the all-orgs
// reconcile entry point the boot phase drives. Pure — the heavy single-writer is
// stubbed and candidate-org + live-claim resolution are injected, so the planner
// runs for real without a DB.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The reconciler mints its purpose-scoped system authority (cinatra#1939 S3);
// the real mint module pulls the better-auth chain — stub it to a pure grant.
vi.mock("@/lib/org-write/authority", () => ({
  mintSystemWriteAuthority: (_purpose: string, orgId: string) => ({
    orgId,
    can: (capability: string) => capability === "content.write",
  }),
}));

const adoptSpy = vi.fn(async () => 0);
vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  adoptExtensionDashboards: (...args: unknown[]) => adoptSpy(...(args as [])),
}));

import { reconcileAllDashboardContributionAdoptions } from "../reconcile-contribution-adoptions";

const LEGACY = "@cinatra-ai/blog-content-workflow";
const SUCCESSOR = "@cinatra-ai/blog-content-agent";

const successorClaim = {
  packageName: SUCCESSOR,
  contribution: {
    abiVersion: 1 as const,
    sdkAbiRange: "^2",
    contributionVersion: 2,
    contributionKey: "blog-operator",
    adopts: [{ legacyPackage: LEGACY, legacyContributionKey: "blog-operator" }],
  },
};

beforeEach(() => adoptSpy.mockReset().mockResolvedValue(0));

describe("reconcileAllDashboardContributionAdoptions (boot trigger)", () => {
  it("is DORMANT when there are no candidate orgs", async () => {
    const r = await reconcileAllDashboardContributionAdoptions({ resolveCandidateOrgIds: async () => [] });
    expect(r.orgsReconciled).toBe(0);
    expect(adoptSpy).not.toHaveBeenCalled();
  });

  it("fans out per candidate org and accumulates adopted rows", async () => {
    adoptSpy.mockResolvedValue(2);
    const r = await reconcileAllDashboardContributionAdoptions({
      resolveCandidateOrgIds: async () => ["org-1", "org-2"],
      resolveLiveClaims: async () => [successorClaim],
    });
    expect(r.orgsReconciled).toBe(2);
    expect(r.adoptionsRun).toBe(2);
    expect(r.adoptedRowCount).toBe(4); // 2 orgs x 2 rows each
    expect(adoptSpy).toHaveBeenCalledTimes(2);
  });

  it("contains a per-org failure so a sibling org still reconciles", async () => {
    const r = await reconcileAllDashboardContributionAdoptions({
      resolveCandidateOrgIds: async () => ["org-bad", "org-ok"],
      resolveLiveClaims: async (orgId) => {
        if (orgId === "org-bad") throw new Error("boom");
        return [];
      },
    });
    expect(r.failed).toBeGreaterThanOrEqual(1); // org-bad
    expect(r.orgsReconciled).toBeGreaterThanOrEqual(1); // org-ok still ran
  });
});
