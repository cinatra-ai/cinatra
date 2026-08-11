import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Gate 9 — CURRENTNESS (cinatra#2474 PR5).
//
// Two properties under test, both deliberately narrow:
//
//   1. this module ASKS THE RECONCILER'S OWN single-package resolver and decides
//      nothing itself, so the static/runtime precedence, the claim gate and the
//      traversal guard can never drift into a second implementation;
//   2. the row name it reports is the MATERIALIZER'S own rule
//      (`extensionTemplateRowName`, not faked here) — the identity the write pins
//      the stored row against.
//
//   pnpm exec vitest run src/lib/dashboards/__tests__/installed-catalog-currentness.test.ts
// ---------------------------------------------------------------------------

const resolveLiveDashboardTemplateForPackage = vi.fn();
vi.mock("@/lib/dashboards/reconcile-template-materializations", () => ({
  resolveLiveDashboardTemplateForPackage: (...args: unknown[]) =>
    resolveLiveDashboardTemplateForPackage(...args),
}));

import { readCurrentTemplateDeclaration } from "@/lib/dashboards/installed-catalog-currentness";

const ORG = "org-1";
const PACKAGE = "@cinatra-ai/analytics-artifact";
const CONFIG = { apiVersion: "v1.2", scopeLevel: "organization", portlets: [] };

beforeEach(() => vi.clearAllMocks());

describe("readCurrentTemplateDeclaration", () => {
  it("returns the pack's DECLARED name and config", async () => {
    resolveLiveDashboardTemplateForPackage.mockResolvedValue({
      packageName: PACKAGE,
      name: "Pipeline health",
      config: CONFIG,
      scope: { ownerLevel: "organization", ownerId: ORG },
    });
    await expect(
      readCurrentTemplateDeclaration({ organizationId: ORG, packageName: PACKAGE }),
    ).resolves.toEqual({
      rowName: "Pipeline health",
      templateScope: "organization",
      config: CONFIG,
    });
    expect(resolveLiveDashboardTemplateForPackage).toHaveBeenCalledWith(ORG, PACKAGE);
  });

  it("applies the MATERIALIZER'S own default when the pack declares no display name", async () => {
    // The rule the reconcile would write, not a restatement of it — the write
    // pins the stored row's name against exactly this value.
    resolveLiveDashboardTemplateForPackage.mockResolvedValue({
      packageName: PACKAGE,
      config: CONFIG,
      scope: { ownerLevel: "organization", ownerId: ORG },
    });
    await expect(
      readCurrentTemplateDeclaration({ organizationId: ORG, packageName: PACKAGE }),
    ).resolves.toEqual({
      rowName: `${PACKAGE} dashboard`,
      templateScope: "organization",
      config: CONFIG,
    });
  });

  it("REFUSES a package that declares no dashboard — the row outliving the declaration", async () => {
    // This is the whole point: the reconcile has no retirement pass, so the
    // published row survives indefinitely after the pack drops its dashboard.
    // The row says yes; the manifest says no; the manifest wins.
    resolveLiveDashboardTemplateForPackage.mockResolvedValue(null);
    await expect(
      readCurrentTemplateDeclaration({ organizationId: ORG, packageName: PACKAGE }),
    ).resolves.toBeNull();
  });

  it("reports a NULL scope for a declaration that no longer validates", async () => {
    // The caller refuses on a null scope; the writer would reject the body too.
    resolveLiveDashboardTemplateForPackage.mockResolvedValue({
      packageName: PACKAGE,
      name: "Pipeline health",
      config: { nonsense: true },
      scope: { ownerLevel: "organization", ownerId: ORG },
    });
    await expect(
      readCurrentTemplateDeclaration({ organizationId: ORG, packageName: PACKAGE }),
    ).resolves.toMatchObject({ templateScope: null });
  });

  it("FAILS CLOSED when the resolver throws — an unverifiable declaration is not one", async () => {
    resolveLiveDashboardTemplateForPackage.mockRejectedValue(new Error("no store"));
    await expect(
      readCurrentTemplateDeclaration({ organizationId: ORG, packageName: PACKAGE }),
    ).resolves.toBeNull();
  });

  it.each([
    ["", PACKAGE],
    [ORG, ""],
  ])(
    "refuses a missing org (%p) / package (%p) without asking",
    async (organizationId, packageName) => {
      await expect(
        readCurrentTemplateDeclaration({ organizationId, packageName }),
      ).resolves.toBeNull();
      expect(resolveLiveDashboardTemplateForPackage).not.toHaveBeenCalled();
    },
  );
});
