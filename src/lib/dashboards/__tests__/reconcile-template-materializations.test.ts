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
  resolveLiveTemplatesFromSources,
  collectCandidateOrgIdsFromSources,
  runtimePackHasValidContributionClaim,
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

// --- runtime-store carry: static + runtime source merge (cinatra#1896) --------
describe("resolveLiveTemplatesFromSources — static + runtime source merge", () => {
  const STATIC_PACK = "@cinatra-ai/locked-dashboard-artifact";
  const RUNTIME_PACK = "@cinatra-ai/web-analytics-dashboard-artifact";
  const config = { apiVersion: "v1.2", scopeLevel: "organization", portlets: [] };
  const readStatic = (pkg: string) =>
    pkg === STATIC_PACK ? { config, name: "Locked dashboard" } : null;
  const readFromDir = (pkg: string) =>
    pkg === RUNTIME_PACK ? { config, name: "Web Analytics dashboard" } : null;

  it("materializes a MARKETPLACE-installed pack from the runtime store (not in the static manifest)", () => {
    const out = resolveLiveTemplatesFromSources({
      organizationId: "org-1",
      rows: [{ packageName: RUNTIME_PACK, status: "active", organizationId: "org-1" }],
      staticManifest: {}, // NOT in the generated manifest — the whole point of the carry
      runtimeRecords: [{ packageName: RUNTIME_PACK, storeDir: "/data/extensions/artifact/wa/deadbeef" }],
      readStaticTemplate: readStatic,
      readTemplateFromDir: readFromDir,
    });
    expect(out).toHaveLength(1);
    expect(out[0].packageName).toBe(RUNTIME_PACK);
    expect(out[0].config).toEqual(config);
    expect(out[0].scope).toEqual({ ownerLevel: "organization", ownerId: "org-1" });
  });

  it("the STATIC source WINS when a package is present in both (locked source authoritative)", () => {
    const readFromDirSpy = vi.fn(readFromDir);
    const out = resolveLiveTemplatesFromSources({
      organizationId: "org-1",
      rows: [{ packageName: STATIC_PACK, status: "locked", organizationId: null }],
      staticManifest: { [STATIC_PACK]: { kind: "artifact", sourceDir: "extensions/x/locked" } },
      runtimeRecords: [{ packageName: STATIC_PACK, storeDir: "/data/extensions/artifact/locked/abc" }],
      readStaticTemplate: readStatic,
      readTemplateFromDir: readFromDirSpy,
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Locked dashboard");
    expect(readFromDirSpy).not.toHaveBeenCalled(); // never fell through to the store
  });

  it("STATIC PRESENCE IS AUTHORITATIVE: a FAILED static read does NOT fall through to runtime bytes", () => {
    // The package is a locked static artifact whose static template read FAILS
    // (missing/malformed on-disk content). It must NOT be overridden by the untrusted
    // runtime store even though a runtime record with the same name is present.
    const readFromDirSpy = vi.fn(() => ({ config, name: "RUNTIME (should be ignored)" }));
    const out = resolveLiveTemplatesFromSources({
      organizationId: "org-1",
      rows: [{ packageName: STATIC_PACK, status: "locked", organizationId: null }],
      staticManifest: { [STATIC_PACK]: { kind: "artifact", sourceDir: "extensions/x/locked" } },
      runtimeRecords: [{ packageName: STATIC_PACK, storeDir: "/data/x/abc" }],
      readStaticTemplate: () => null, // static read fails
      readTemplateFromDir: readFromDirSpy,
    });
    expect(out).toHaveLength(0); // nothing materializes — no runtime override
    expect(readFromDirSpy).not.toHaveBeenCalled();
  });

  it("skips a runtime record with no live org-addressable install row", () => {
    const out = resolveLiveTemplatesFromSources({
      organizationId: "org-1",
      rows: [{ packageName: RUNTIME_PACK, status: "active", organizationId: "org-OTHER" }],
      staticManifest: {},
      runtimeRecords: [{ packageName: RUNTIME_PACK, storeDir: "/data/x" }],
      readStaticTemplate: readStatic,
      readTemplateFromDir: readFromDir,
    });
    expect(out).toHaveLength(0);
  });

  it("skips a non-artifact static record and a pack that ships no template", () => {
    const out = resolveLiveTemplatesFromSources({
      organizationId: "org-1",
      rows: [
        { packageName: "@x/agent", status: "active", organizationId: "org-1" },
        { packageName: "@x/no-template", status: "active", organizationId: "org-1" },
      ],
      staticManifest: { "@x/agent": { kind: "agent", sourceDir: "extensions/x/agent" } },
      runtimeRecords: [{ packageName: "@x/no-template", storeDir: "/data/x" }],
      readStaticTemplate: () => null,
      readTemplateFromDir: () => null, // ships no dashboard template
    });
    expect(out).toHaveLength(0);
  });
});

describe("collectCandidateOrgIdsFromSources — static + runtime candidate merge", () => {
  const rows = [
    { packageName: "@x/static-dash", status: "active", organizationId: "org-A" },
    { packageName: "@x/runtime-dash", status: "active", organizationId: "org-B" },
    { packageName: "@x/system-null", status: "locked", organizationId: null }, // fan-out is a follow-up
    { packageName: "@x/plain", status: "active", organizationId: "org-C" },
  ];
  it("includes orgs holding a dashboard-template pack from EITHER source, skips null-org + non-shippers", () => {
    const orgIds = collectCandidateOrgIdsFromSources({
      rows,
      staticManifest: {
        "@x/static-dash": { kind: "artifact", sourceDir: "extensions/x/static-dash" },
        "@x/plain": { kind: "artifact", sourceDir: "extensions/x/plain" },
      },
      runtimeShippers: new Set(["@x/runtime-dash"]),
      staticShips: (pkg) => pkg === "@x/static-dash", // @x/plain ships none
    });
    expect(orgIds.sort()).toEqual(["org-A", "org-B"]);
  });

  it("STATIC PRESENCE IS AUTHORITATIVE: a statically-claimed non-shipper is NOT rescued by a runtime record", () => {
    // @x/static-nonship is in the static manifest as artifact but ships no dashboard;
    // a runtime record of the same name must NOT make its org a candidate.
    const orgIds = collectCandidateOrgIdsFromSources({
      rows: [{ packageName: "@x/static-nonship", status: "active", organizationId: "org-Z" }],
      staticManifest: { "@x/static-nonship": { kind: "artifact", sourceDir: "extensions/x/nonship" } },
      runtimeShippers: new Set(["@x/static-nonship"]), // present in runtime too
      staticShips: () => false, // static source ships none
    });
    expect(orgIds).toEqual([]); // never ORed in from runtime
  });
});

describe("runtimePackHasValidContributionClaim — fail-closed runtime claim gate", () => {
  const VALID = {
    abiVersion: 1,
    sdkAbiRange: "^2.4.0",
    contributionVersion: 1,
    contributionKey: "web-analytics",
    sidecar: "./cinatra/dashboard.json",
  };
  it("true for a kind:artifact pack with a schema-valid, ABI-compatible claim", () => {
    expect(runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: VALID })).toBe(true);
  });
  it("false when the manifest was unreadable (null)", () => {
    expect(runtimePackHasValidContributionClaim(null)).toBe(false);
  });
  it("false on a non-artifact kind even with a valid-looking claim (carrier gate)", () => {
    expect(runtimePackHasValidContributionClaim({ kind: "agent", dashboardContribution: VALID })).toBe(false);
  });
  it("false on a missing / non-object claim", () => {
    expect(runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: undefined })).toBe(false);
    expect(runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: [VALID] })).toBe(false);
  });
  it("false on an object-shaped but SCHEMA-INVALID claim (parseDashboardContribution fails)", () => {
    // Missing required fields / wrong abiVersion → the sdk leaf validator rejects it.
    expect(runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: { abiVersion: 2 } })).toBe(false);
    expect(
      runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: { ...VALID, contributionKey: "Not_Kebab" } }),
    ).toBe(false);
  });
  it("false on a claim built for an INCOMPATIBLE (too-new) SDK ABI", () => {
    expect(
      runtimePackHasValidContributionClaim({ kind: "artifact", dashboardContribution: { ...VALID, sdkAbiRange: "^99.0.0" } }),
    ).toBe(false);
  });
});
