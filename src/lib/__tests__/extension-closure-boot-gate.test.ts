// Extension dependency-closure + required-in-prod boot gate (issue #78):
// prod fails closed (throws out of register()), dev is advisory, the initial
// store read is the only skippable (indeterminate) failure, and the
// optional-missing per-kind dispatch is surfaced as behavior-tagged advisories.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExtensionDependency,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";

const listInstalledExtensionsMock = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...args: unknown[]) => listInstalledExtensionsMock(...args),
}));

const verifyMock = vi.fn();
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  verifyRequiredInProdInstalled: (...args: unknown[]) => verifyMock(...args),
}));

import {
  assertClosureBootReport,
  buildClosureBootReport,
  closureBootViolations,
  enforceExtensionClosureAtBoot,
  type ClosureBootReport,
} from "@/lib/extension-closure-boot-gate";

function ext(
  packageName: string,
  status: InstalledExtension["status"],
  deps: ExtensionDependency[] = [],
  kind: InstalledExtension["kind"] = "agent",
): InstalledExtension {
  return {
    id: `id-${packageName}`,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind,
    status,
    source: { type: "local", path: `/x/${packageName}`, resolvedCommitOrTreeHash: "h" },
    requiredInProd: false,
    dependencies: deps,
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
const req = (packageName: string): ExtensionDependency => ({
  packageName,
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "*" },
  requirement: "required",
});
const opt = (packageName: string): ExtensionDependency => ({
  ...req(packageName),
  requirement: "optional",
});

const OK_VERIFICATION = { ok: true as const, required: [], installed: [] };
const cleanReport = (over: Partial<ClosureBootReport> = {}): ClosureBootReport => ({
  brokenClosures: [],
  verification: OK_VERIFICATION,
  optionalAdvisories: [],
  ...over,
});

beforeEach(() => {
  verifyMock.mockResolvedValue(OK_VERIFICATION);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  listInstalledExtensionsMock.mockReset();
  verifyMock.mockReset();
});

describe("closureBootViolations", () => {
  it("empty report → no violations", () => {
    expect(closureBootViolations(cleanReport())).toEqual([]);
  });

  it("broken required closure → violation naming the dependent and its missing deps", () => {
    const v = closureBootViolations(
      cleanReport({ brokenClosures: [{ packageName: "@x/app", missingRequired: ["@x/lib"] }] }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("@x/app");
    expect(v[0]).toContain("@x/lib");
  });

  it("failed required-in-prod verification → its reason is a violation", () => {
    const v = closureBootViolations(
      cleanReport({
        verification: {
          ok: false,
          required: ["@x/sys"],
          installed: [],
          missing: ["@x/sys"],
          mismatched: [],
          reason: "Required-in-prod packages missing from installed_extension manifest: @x/sys",
        },
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("@x/sys");
  });

  it("optional-missing advisories alone are NEVER a violation", () => {
    const v = closureBootViolations(
      cleanReport({
        optionalAdvisories: [
          { packageName: "@x/a", kind: "agent", behavior: "stop-run-hitl", missingOptional: ["@x/m"] },
        ],
      }),
    );
    expect(v).toEqual([]);
  });
});

describe("assertClosureBootReport (prod-throw vs dev-advisory)", () => {
  const broken = cleanReport({
    brokenClosures: [{ packageName: "@x/app", missingRequired: ["@x/lib"] }],
  });

  it("throws outside development on a violation", () => {
    expect(() => assertClosureBootReport(broken, { mode: "production", disabled: false })).toThrow(
      /required-extension contract violated/,
    );
  });

  it("the prod error names the acquisition-path remediation + kill switch", () => {
    try {
      assertClosureBootReport(broken, { mode: "production", disabled: false });
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("cinatra setup prod");
      expect(msg).toContain("CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT");
    }
  });

  it("does NOT throw in development (advisory only, logged)", () => {
    expect(() =>
      assertClosureBootReport(broken, { mode: "development", disabled: false }),
    ).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("kill switch disables the prod throw but still logs the violation", () => {
    expect(() => assertClosureBootReport(broken, { mode: "production", disabled: true })).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("clean report never throws in prod", () => {
    expect(() =>
      assertClosureBootReport(cleanReport(), { mode: "production", disabled: false }),
    ).not.toThrow();
  });

  it("logs each optional-missing advisory with its per-kind behavior", () => {
    const report = cleanReport({
      optionalAdvisories: [
        { packageName: "@x/conn", kind: "connector", behavior: "skip-step-audit", missingOptional: ["@x/m"] },
      ],
    });
    assertClosureBootReport(report, { mode: "production", disabled: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("skip-step-audit"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("@x/conn"));
  });
});

describe("buildClosureBootReport", () => {
  it("computes broken closures + behavior-tagged optional advisories from ONE snapshot and passes it to the verifier", async () => {
    const app = ext("@x/app", "active", [req("@x/ghost")], "skill");
    const agent = ext("@x/agent", "active", [opt("@x/opt-ghost")], "agent");
    const rows = [app, agent];
    const report = await buildClosureBootReport(rows);

    expect(report.brokenClosures).toEqual([
      { packageName: "@x/app", missingRequired: ["@x/ghost"] },
    ]);
    expect(report.optionalAdvisories).toEqual([
      {
        packageName: "@x/agent",
        kind: "agent",
        behavior: "stop-run-hitl",
        missingOptional: ["@x/opt-ghost"],
      },
    ]);
    // Snapshot-shared verification: the SAME rows array, no second store read.
    expect(verifyMock).toHaveBeenCalledWith(rows);
    expect(listInstalledExtensionsMock).not.toHaveBeenCalled();
  });

  it("archived rows are not scanned as dependents", async () => {
    const archived = ext("@x/old", "archived", [req("@x/ghost")]);
    const report = await buildClosureBootReport([archived]);
    expect(report.brokenClosures).toEqual([]);
    expect(report.optionalAdvisories).toEqual([]);
  });

  it("no cross-org bleed: a dep live ONLY in a foreign org is broken; a platform dep satisfies", async () => {
    const appB = { ...ext("@x/app", "active", [req("@x/dep")]), organizationId: "org-b" };
    const depA = { ...ext("@x/dep", "active"), organizationId: "org-a" };
    const brokenReport = await buildClosureBootReport([appB, depA]);
    expect(brokenReport.brokenClosures).toEqual([
      { packageName: "@x/app", missingRequired: ["@x/dep"] },
    ]);

    const depPlat = ext("@x/dep", "locked"); // organizationId null (platform)
    const okReport = await buildClosureBootReport([appB, depPlat]);
    expect(okReport.brokenClosures).toEqual([]);
  });
});

describe("enforceExtensionClosureAtBoot", () => {
  it("INDETERMINATE: a failed canonical-store read is skipped, never a throw", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    listInstalledExtensionsMock.mockRejectedValue(new Error("relation does not exist"));
    await expect(enforceExtensionClosureAtBoot()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("indeterminate"),
      expect.anything(),
    );
    vi.unstubAllEnvs();
  });

  it("prod: a broken closure read from a real snapshot THROWS", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    vi.stubEnv("CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT", "");
    listInstalledExtensionsMock.mockResolvedValue([ext("@x/app", "active", [req("@x/ghost")])]);
    await expect(enforceExtensionClosureAtBoot()).rejects.toThrow(
      /required-extension contract violated/,
    );
    vi.unstubAllEnvs();
  });

  it("dev: the same broken closure resolves (advisory)", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    listInstalledExtensionsMock.mockResolvedValue([ext("@x/app", "active", [req("@x/ghost")])]);
    await expect(enforceExtensionClosureAtBoot()).resolves.toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("prod: a failed required-in-prod verification THROWS", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    vi.stubEnv("CINATRA_DISABLE_REQUIRED_CLOSURE_ASSERT", "");
    listInstalledExtensionsMock.mockResolvedValue([]);
    verifyMock.mockResolvedValue({
      ok: false,
      required: ["@x/sys"],
      installed: [],
      missing: ["@x/sys"],
      mismatched: [],
      reason: "Required-in-prod packages missing from installed_extension manifest: @x/sys",
    });
    await expect(enforceExtensionClosureAtBoot()).rejects.toThrow(/@x\/sys/);
    vi.unstubAllEnvs();
  });
});
