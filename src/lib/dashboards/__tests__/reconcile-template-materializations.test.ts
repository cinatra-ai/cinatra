// Install→materialize TRIGGER fan-out (cinatra#1896 Scope 2 / epic #1883): the
// boot reconcile that finally CALLS `materializeExtensionTemplate` (which had no
// app-side caller on main). Pure — the heavy single-writer is stubbed and
// candidate-org + live-template resolution are injected, so the trigger fan-out +
// idempotency + fail-closed containment run without a DB/fs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const materializeSpy = vi.fn(async (_tx: unknown, _input: unknown) => ({}) as never);
vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  materializeExtensionTemplate: (tx: unknown, input: unknown) => materializeSpy(tx, input),
}));

import {
  reconcileDashboardTemplateMaterializations,
  reconcileAllDashboardTemplateMaterializations,
  type LiveDashboardTemplate,
} from "../reconcile-template-materializations";

const PACK = "@cinatra-ai/web-analytics-dashboard-artifact";
const webAnalyticsTemplate: LiveDashboardTemplate = {
  packageName: PACK,
  config: { apiVersion: "v1.2", scopeLevel: "organization", portlets: [] },
  name: "Web Analytics Dashboard dashboard",
  scope: { ownerLevel: "organization", ownerId: "org-1" },
};

beforeEach(() => materializeSpy.mockReset().mockResolvedValue({} as never));

describe("reconcileDashboardTemplateMaterializations (per-org trigger)", () => {
  it("materializes each live dashboard template with the pack's config + org scope", async () => {
    const r = await reconcileDashboardTemplateMaterializations("org-1", {
      resolveLiveTemplates: async (orgId) => [{ ...webAnalyticsTemplate, scope: { ownerLevel: "organization", ownerId: orgId } }],
    });
    expect(r.materialized).toBe(1);
    expect(r.failed).toBe(0);
    expect(materializeSpy).toHaveBeenCalledTimes(1);
    const [, input] = materializeSpy.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input.extensionId).toBe(PACK);
    expect(input.organizationId).toBe("org-1");
    expect(input.config).toEqual(webAnalyticsTemplate.config);
    expect(input.scope).toEqual({ ownerLevel: "organization", ownerId: "org-1" });
    // The system materialize actor (install authz is gated upstream).
    expect((input.actor as { userId: string }).userId).toBe("system:dashboard-template-materializer");
  });

  it("is idempotent — a re-fire calls the (idempotent) writer again, converging", async () => {
    const deps = { resolveLiveTemplates: async () => [webAnalyticsTemplate] };
    await reconcileDashboardTemplateMaterializations("org-1", deps);
    const r2 = await reconcileDashboardTemplateMaterializations("org-1", deps);
    // The writer upserts the single (extension, org) template row in place, so a
    // second reconcile is a safe no-op convergence at the DB level.
    expect(r2.materialized).toBe(1);
    expect(materializeSpy).toHaveBeenCalledTimes(2);
  });

  it("contains a per-pack failure (invalid config / writer throw) fail-closed", async () => {
    // First materialize throws (e.g. DashboardConfigInvalidError for a malformed
    // template body); the sibling still materializes.
    materializeSpy
      .mockReset()
      .mockRejectedValueOnce(new Error("DashboardConfigInvalidError: portlet kind unknown"))
      .mockResolvedValue({} as never);
    const r = await reconcileDashboardTemplateMaterializations("org-1", {
      resolveLiveTemplates: async () => [
        { ...webAnalyticsTemplate, packageName: "@cinatra-ai/bad-pack" },
        webAnalyticsTemplate,
      ],
    });
    expect(r.failed).toBe(1); // the bad pack
    expect(r.materialized).toBe(1); // the sibling still materialized
    expect(materializeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileAllDashboardTemplateMaterializations (boot trigger)", () => {
  it("is DORMANT when there are no candidate orgs", async () => {
    const r = await reconcileAllDashboardTemplateMaterializations({ resolveCandidateOrgIds: async () => [] });
    expect(r.orgsReconciled).toBe(0);
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it("fans out per candidate org and accumulates materialized rows", async () => {
    const r = await reconcileAllDashboardTemplateMaterializations({
      resolveCandidateOrgIds: async () => ["org-1", "org-2"],
      resolveLiveTemplates: async (orgId) => [{ ...webAnalyticsTemplate, scope: { ownerLevel: "organization", ownerId: orgId } }],
    });
    expect(r.orgsReconciled).toBe(2);
    expect(r.materialized).toBe(2); // 1 template x 2 orgs
    expect(materializeSpy).toHaveBeenCalledTimes(2);
  });

  it("contains a per-org failure so a sibling org still reconciles", async () => {
    const r = await reconcileAllDashboardTemplateMaterializations({
      resolveCandidateOrgIds: async () => ["org-bad", "org-ok"],
      resolveLiveTemplates: async (orgId) => {
        if (orgId === "org-bad") throw new Error("boom");
        return [];
      },
    });
    expect(r.failed).toBeGreaterThanOrEqual(1); // org-bad
    expect(r.orgsReconciled).toBeGreaterThanOrEqual(1); // org-ok still ran
  });
});
