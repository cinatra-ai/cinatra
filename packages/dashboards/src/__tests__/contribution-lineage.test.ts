// Pure unit suite for the contribution LINEAGE identity + the adopt-in-place
// PLANNER (cinatra#1628, S11b). No DB — the transactional writer is proven in
// adopt-extension-dashboards.integration.test.ts.
import { describe, expect, it } from "vitest";
import type { DashboardContributionManifest } from "@cinatra-ai/sdk-extensions";

import {
  legacyContributionLineageId,
  deriveContributionLineageId,
  adoptionMatchLineageIds,
  planContributionAdoptions,
  LEGACY_LINEAGE_PREFIX,
  CONTRIBUTION_LINEAGE_PREFIX,
  type LiveContributionClaim,
} from "../contribution-lineage";
// The migration whose backfill format the reconciler MUST byte-match.
import { RETIRED_WORKFLOW_CONTRIBUTION_PACKAGE } from "../../../../migrations/core/core__0051_dashboard-contribution-lineage-and-orphan-sweep.mjs";

function claim(
  contributionKey: string,
  contributionVersion: number,
  adopts?: { legacyPackage: string; legacyContributionKey: string }[],
): DashboardContributionManifest {
  return {
    abiVersion: 1,
    sdkAbiRange: "^2",
    contributionVersion,
    contributionKey,
    ...(adopts ? { adopts } : {}),
  };
}

describe("contribution lineage-id derivation", () => {
  it("legacyContributionLineageId byte-matches migration core__0051's `'legacy:' || extension_id`", () => {
    const pkg = RETIRED_WORKFLOW_CONTRIBUTION_PACKAGE;
    expect(legacyContributionLineageId(pkg)).toBe(`legacy:${pkg}`);
    expect(legacyContributionLineageId(pkg).startsWith(LEGACY_LINEAGE_PREFIX)).toBe(true);
  });

  it("deriveContributionLineageId is a package#key canonical id under the contribution: namespace", () => {
    expect(deriveContributionLineageId("@cinatra-ai/blog-content-agent", "blog-operator")).toBe(
      "contribution:@cinatra-ai/blog-content-agent#blog-operator",
    );
    expect(
      deriveContributionLineageId("@x/y", "k").startsWith(CONTRIBUTION_LINEAGE_PREFIX),
    ).toBe(true);
  });

  it("the two lineage namespaces never collide", () => {
    expect(legacyContributionLineageId("@x/y")).not.toBe(deriveContributionLineageId("@x/y", "y"));
  });

  it("adoptionMatchLineageIds resolves an edge to [agent-era, workflow-era] candidates, most-specific first", () => {
    expect(
      adoptionMatchLineageIds({ legacyPackage: "@cinatra-ai/blog-content-workflow", legacyContributionKey: "blog" }),
    ).toEqual([
      "contribution:@cinatra-ai/blog-content-workflow#blog",
      "legacy:@cinatra-ai/blog-content-workflow",
    ]);
  });
});

describe("planContributionAdoptions", () => {
  it("plans one adoption per SUCCESSOR, re-keying to the successor's canonical lineage", () => {
    const claims: LiveContributionClaim[] = [
      {
        packageName: "@cinatra-ai/blog-content-agent",
        contribution: claim("blog-operator", 3, [
          { legacyPackage: "@cinatra-ai/blog-content-workflow", legacyContributionKey: "blog" },
        ]),
      },
    ];
    const { adoptions, skipped } = planContributionAdoptions(claims);
    expect(skipped).toEqual([]);
    expect(adoptions).toHaveLength(1);
    const op = adoptions[0]!;
    expect(op.successorPackage).toBe("@cinatra-ai/blog-content-agent");
    expect(op.successorContributionId).toBe("contribution:@cinatra-ai/blog-content-agent#blog-operator");
    expect(op.successorContributionVersion).toBe(3);
    expect(op.legacyRefs).toHaveLength(1);
    expect(op.matchLineageIds).toContain("legacy:@cinatra-ai/blog-content-workflow");
    expect(op.matchLineageIds).toContain("contribution:@cinatra-ai/blog-content-workflow#blog");
  });

  it("a successor with MULTIPLE adopts edges plans ONE atomic op with the union of candidates", () => {
    const claims: LiveContributionClaim[] = [
      {
        packageName: "@cinatra-ai/blog-content-agent",
        contribution: claim("blog-operator", 1, [
          { legacyPackage: "@cinatra-ai/blog-content-workflow", legacyContributionKey: "blog" },
          { legacyPackage: "@cinatra-ai/blog-content-agent-v1", legacyContributionKey: "blog" },
        ]),
      },
    ];
    const { adoptions } = planContributionAdoptions(claims);
    expect(adoptions).toHaveLength(1); // ONE op, not two
    const op = adoptions[0]!;
    expect(op.legacyRefs).toHaveLength(2);
    // Union of both edges' candidates (deduped).
    expect(new Set(op.matchLineageIds)).toEqual(
      new Set([
        "contribution:@cinatra-ai/blog-content-workflow#blog",
        "legacy:@cinatra-ai/blog-content-workflow",
        "contribution:@cinatra-ai/blog-content-agent-v1#blog",
        "legacy:@cinatra-ai/blog-content-agent-v1",
      ]),
    );
  });

  it("a claim with no adopts contributes no adoption (fresh materialization is a separate path)", () => {
    const { adoptions, skipped } = planContributionAdoptions([
      { packageName: "@cinatra-ai/net-new-agent", contribution: claim("fresh", 1) },
    ]);
    expect(adoptions).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("FAILS CLOSED on ambiguity: two DIFFERENT successors adopting the same legacy lineage are BOTH skipped", () => {
    const claims: LiveContributionClaim[] = [
      {
        packageName: "@cinatra-ai/agent-a",
        contribution: claim("a", 1, [
          { legacyPackage: "@cinatra-ai/legacy-wf", legacyContributionKey: "d" },
        ]),
      },
      {
        packageName: "@cinatra-ai/agent-b",
        contribution: claim("b", 1, [
          { legacyPackage: "@cinatra-ai/legacy-wf", legacyContributionKey: "d" },
        ]),
      },
    ];
    const { adoptions, skipped } = planContributionAdoptions(claims);
    expect(adoptions).toEqual([]); // neither wins — the orphan stays archived
    expect(skipped).toHaveLength(2);
    for (const s of skipped) {
      expect(s.reason).toBe("ambiguous_claimants");
      expect(s.legacyRefs[0]!.legacyPackage).toBe("@cinatra-ai/legacy-wf");
    }
    // Each names the OTHER contesting package.
    expect(skipped.find((s) => s.successorPackage === "@cinatra-ai/agent-a")!.conflictingPackages).toEqual([
      "@cinatra-ai/agent-b",
    ]);
    expect(skipped.find((s) => s.successorPackage === "@cinatra-ai/agent-b")!.conflictingPackages).toEqual([
      "@cinatra-ai/agent-a",
    ]);
  });

  it("ambiguity via OVERLAPPING candidate ids (one names the workflow-era id, another the agent-era id of the same lineage) fails closed", () => {
    // agent-a adopts the workflow-era rows of @x/wf; agent-b adopts an agent-era
    // contribution `@x/wf#k` — both resolve a candidate `contribution:@x/wf#k`.
    const claims: LiveContributionClaim[] = [
      {
        packageName: "@cinatra-ai/agent-a",
        contribution: claim("a", 1, [{ legacyPackage: "@x/wf", legacyContributionKey: "k" }]),
      },
      {
        packageName: "@cinatra-ai/agent-b",
        contribution: claim("b", 1, [{ legacyPackage: "@x/wf", legacyContributionKey: "k" }]),
      },
    ];
    const { adoptions, skipped } = planContributionAdoptions(claims);
    expect(adoptions).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it("distinct legacy targets by distinct successors both plan (no false ambiguity)", () => {
    const claims: LiveContributionClaim[] = [
      {
        packageName: "@cinatra-ai/agent-a",
        contribution: claim("a", 1, [{ legacyPackage: "@x/wf-a", legacyContributionKey: "k" }]),
      },
      {
        packageName: "@cinatra-ai/agent-b",
        contribution: claim("b", 1, [{ legacyPackage: "@x/wf-b", legacyContributionKey: "k" }]),
      },
    ];
    const { adoptions, skipped } = planContributionAdoptions(claims);
    expect(skipped).toEqual([]);
    expect(adoptions.map((a) => a.successorPackage).sort()).toEqual([
      "@cinatra-ai/agent-a",
      "@cinatra-ai/agent-b",
    ]);
  });
});
