// Host reconciler orchestration (cinatra#1628, S11b): the "consume the claim"
// glue — parse (degrade-with-diagnostic) → plan (fail-closed ambiguity) → drive
// the transactional adopter per op. Pure: the single-writer is stubbed (its real
// DB behavior is proven in packages/dashboards …adopt-extension-dashboards
// .integration.test.ts); the planner runs for real.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Stub the heavy single-writer so the orchestrator can load without a DB. The
// planner keeps its real behavior (its own pure subpath is NOT mocked).
const adoptSpy = vi.fn(async () => 0);
vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  adoptExtensionDashboards: (...args: unknown[]) => adoptSpy(...(args as [])),
}));

import {
  reconcileDashboardContributionAdoptions,
  parseLiveContributionClaims,
  type LiveContributionCandidate,
} from "../reconcile-contribution-adoptions";
import { deriveContributionLineageId } from "@cinatra-ai/dashboards/contribution-lineage";

const LEGACY = "@cinatra-ai/blog-content-workflow";
const SUCCESSOR = "@cinatra-ai/blog-content-agent";

const validClaim = (
  packageName: string,
  contributionKey: string,
  adopts?: { legacyPackage: string; legacyContributionKey: string }[],
) => ({
  packageName,
  contribution: {
    abiVersion: 1 as const,
    sdkAbiRange: "^2",
    contributionVersion: 2,
    contributionKey,
    ...(adopts ? { adopts } : {}),
  },
});

beforeEach(() => adoptSpy.mockReset().mockResolvedValue(0));

describe("parseLiveContributionClaims (degrade-with-diagnostic)", () => {
  const cand = (over: Partial<LiveContributionCandidate>): LiveContributionCandidate => ({
    packageName: "@x/dashboard-artifact",
    // cinatra#1896: the carrier is `kind:"artifact"` (the `agent` carrier is retired).
    kind: "artifact",
    rawContribution: { abiVersion: 1, sdkAbiRange: "^2", contributionVersion: 1, contributionKey: "k" },
    ...over,
  });

  it("keeps a well-formed artifact claim", () => {
    expect(parseLiveContributionClaims([cand({})])).toHaveLength(1);
  });

  it("DROPS a malformed claim (degrade, never throw) but keeps the valid siblings", () => {
    const claims = parseLiveContributionClaims([
      cand({ packageName: "@x/bad", rawContribution: { abiVersion: 1, contributionKey: "NOT KEBAB" } }),
      cand({ packageName: "@x/good" }),
    ]);
    expect(claims.map((c) => c.packageName)).toEqual(["@x/good"]);
  });

  it("ignores a NON-artifact carrier even if it carries a claim (kind gate; incl. the retired agent carrier)", () => {
    expect(parseLiveContributionClaims([cand({ kind: "connector" })])).toEqual([]);
    expect(parseLiveContributionClaims([cand({ kind: "agent" })])).toEqual([]);
  });

  it("skips a null/absent claim", () => {
    expect(parseLiveContributionClaims([cand({ rawContribution: null })])).toEqual([]);
  });
});

describe("reconcileDashboardContributionAdoptions", () => {
  it("drives the adopter once per planned op with the successor identity + match ids", async () => {
    adoptSpy.mockResolvedValue(3);
    const res = await reconcileDashboardContributionAdoptions("org-1", {
      resolveLiveClaims: async () => [
        validClaim(SUCCESSOR, "blog-operator", [{ legacyPackage: LEGACY, legacyContributionKey: "blog" }]),
      ],
      adopt: adoptSpy,
    });
    expect(res).toEqual({ adoptedRowCount: 3, adoptionsRun: 1, skipped: 0, failed: 0 });
    expect(adoptSpy).toHaveBeenCalledTimes(1);
    const call = adoptSpy.mock.calls[0] as unknown as [undefined, Record<string, unknown>];
    expect(call[1]).toMatchObject({
      organizationId: "org-1",
      successorPackage: SUCCESSOR,
      successorContributionId: deriveContributionLineageId(SUCCESSOR, "blog-operator"),
      appliedContributionVersion: 2,
    });
    expect(call[1].matchLineageIds).toContain(`legacy:${LEGACY}`);
  });

  it("FAILS CLOSED on ambiguity — the adopter is NEVER called for a contested lineage", async () => {
    const res = await reconcileDashboardContributionAdoptions("org-1", {
      resolveLiveClaims: async () => [
        validClaim("@x/a", "a", [{ legacyPackage: LEGACY, legacyContributionKey: "blog" }]),
        validClaim("@x/b", "b", [{ legacyPackage: LEGACY, legacyContributionKey: "blog" }]),
      ],
      adopt: adoptSpy,
    });
    expect(res.adoptionsRun).toBe(0);
    expect(res.skipped).toBe(2);
    expect(adoptSpy).not.toHaveBeenCalled();
  });

  it("CONTAINS a write-time collision per successor (rollback → failed++, siblings still reconcile)", async () => {
    adoptSpy
      .mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" }))
      .mockResolvedValueOnce(2);
    const res = await reconcileDashboardContributionAdoptions("org-1", {
      resolveLiveClaims: async () => [
        validClaim("@x/collides", "c", [{ legacyPackage: "@x/wf1", legacyContributionKey: "k" }]),
        validClaim("@x/ok", "o", [{ legacyPackage: "@x/wf2", legacyContributionKey: "k" }]),
      ],
      adopt: adoptSpy,
    });
    expect(res.failed).toBe(1);
    expect(res.adoptionsRun).toBe(1);
    expect(res.adoptedRowCount).toBe(2);
    expect(adoptSpy).toHaveBeenCalledTimes(2); // the sibling still ran
  });

  it("no live claims → no work", async () => {
    const res = await reconcileDashboardContributionAdoptions("org-1", {
      resolveLiveClaims: async () => [],
      adopt: adoptSpy,
    });
    expect(res).toEqual({ adoptedRowCount: 0, adoptionsRun: 0, skipped: 0, failed: 0 });
    expect(adoptSpy).not.toHaveBeenCalled();
  });
});
