// cinatra#1041 outcome 2 — the §II modal-footer DRY-RUN plan preview.
//
// Two halves:
//   1. the PURE plan→preview mapper (buildUpdatePlanPreviewMembers): member
//      grouping (Update / Install / Side-by-side / Rebound), alreadyInstalled
//      skipping, rebound derivation from live dependents;
//   2. the guarded computation (computeExtensionUpdatePlanPreview) over
//      injected deps: outcome-4 non-comparable refusals (github/dev/local —
//      never a string-equality fallback), the ABI-incompatible refusal, the
//      required-pin-range refusal, the gatekept single-member fence, and the
//      dev-path planner dry-run (rootAction:"update", closure:null, and NO
//      execution — the deps expose no executor at all).
import { describe, expect, it, vi } from "vitest";

import {
  buildUpdatePlanPreviewMembers,
  computeExtensionUpdatePlanPreview,
  UpdatePlanRefusal,
  type UpdatePlanPreviewDeps,
} from "@/lib/extension-update-plan-preview";
import type { PlannedMember } from "@/lib/extension-dependency-plan";
import type {
  ExtensionDependency,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";

const ROOT = "@acme/research-assistant";
const DEP = "@acme/foundry-core";

function edge(packageName: string, range = "*"): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range },
    requirement: "required",
  };
}

function row(
  packageName: string,
  version: string | null,
  over: Partial<InstalledExtension> & { dependencies?: ExtensionDependency[] } = {},
): InstalledExtension {
  return {
    id: `row-${packageName}`,
    packageName,
    status: "active",
    organizationId: null,
    source: version === null ? { type: "github", ref: "main" } : { type: "verdaccio", version },
    dependencies: over.dependencies ?? [],
    ...over,
  } as unknown as InstalledExtension;
}

function planned(
  packageName: string,
  version: string,
  action: PlannedMember["action"],
  alreadyInstalled = false,
): PlannedMember {
  return {
    packageName,
    version,
    typeId: "agent",
    edges: [],
    alreadyInstalled,
    rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
    action,
  };
}

describe("buildUpdatePlanPreviewMembers — §II plan groups", () => {
  it("maps a direct root update and SKIPS alreadyInstalled members", () => {
    const members = buildUpdatePlanPreviewMembers({
      ordered: [planned(DEP, "1.0.0", "install", true), planned(ROOT, "0.1.5", "update")],
      rootPackageName: ROOT,
      installedRows: [row(ROOT, "0.1.2"), row(DEP, "1.0.0")],
      orgId: null,
    });
    expect(members).toEqual([
      {
        packageName: ROOT,
        action: "update",
        fromVersion: "0.1.2",
        toVersion: "0.1.5",
        reboundToPackageName: null,
        isRoot: true,
      },
    ]);
  });

  it("groups install / side-by-side members and orders the root update first", () => {
    const members = buildUpdatePlanPreviewMembers({
      ordered: [
        planned("@acme/vector-index", "2.0.0", "install"),
        planned("@acme/legacy-parser", "2.0.0", "install-side-by-side"),
        planned(ROOT, "0.1.5", "update"),
      ],
      rootPackageName: ROOT,
      installedRows: [row(ROOT, "0.1.2"), row("@acme/legacy-parser", "1.4.0")],
      orgId: null,
    });
    expect(members.map((m) => [m.action, m.packageName])).toEqual([
      ["update", ROOT],
      ["install", "@acme/vector-index"],
      ["side-by-side", "@acme/legacy-parser"],
    ]);
    const sbs = members.find((m) => m.action === "side-by-side")!;
    expect(sbs.fromVersion).toBe("1.4.0"); // the kept current default
    expect(sbs.toVersion).toBe("2.0.0"); // the new pin installed beside it
  });

  it("derives REBOUND dependents for a shared-dep dedupe-upward (excluding plan members)", () => {
    const dependentInPlan = planned("@acme/pdf-extractor", "3.0.0", "install");
    const members = buildUpdatePlanPreviewMembers({
      ordered: [planned(DEP, "1.1.0", "update"), dependentInPlan, planned(ROOT, "0.1.5", "update")],
      rootPackageName: ROOT,
      installedRows: [
        row(ROOT, "0.1.2"),
        row(DEP, "1.0.0"),
        // A live dependent binding the shared dep — rebound.
        row("@acme/summarizer", "2.2.0", { dependencies: [edge(DEP, "^1.0.0")] }),
        // A plan member also depending on it — NOT listed twice.
        row("@acme/pdf-extractor", "2.9.0", { dependencies: [edge(DEP, "^1.0.0")] }),
        // An archived row never rebinds.
        row("@acme/old-tool", "0.9.0", {
          status: "archived",
          dependencies: [edge(DEP, "^1.0.0")],
        } as Partial<InstalledExtension>),
      ],
      orgId: null,
    });
    const rebounds = members.filter((m) => m.action === "rebound");
    expect(rebounds).toEqual([
      {
        packageName: "@acme/summarizer",
        action: "rebound",
        fromVersion: null,
        toVersion: null,
        reboundToPackageName: DEP,
        isRoot: false,
      },
    ]);
    // Shared-dep update carries its version transition.
    const shared = members.find((m) => m.packageName === DEP)!;
    expect(shared).toMatchObject({ action: "update", fromVersion: "1.0.0", toVersion: "1.1.0" });
  });
});

// ---------------------------------------------------------------------------
// Guarded computation over injected deps.
// ---------------------------------------------------------------------------

function makeDeps(over: Partial<UpdatePlanPreviewDeps> = {}): UpdatePlanPreviewDeps & {
  plan: ReturnType<typeof vi.fn>;
} {
  const plan = vi.fn(async () => ({
    ordered: [planned(ROOT, "0.1.5", "update")],
    root: { packageName: ROOT, version: "0.1.5" },
    source: "manifest-walk" as const,
    memberKinds: new Map(),
  }));
  return {
    readInstalledRows: async () => [row(ROOT, "0.1.2")],
    readUpdateReadout: async (packageName) => ({
      packageName,
      entry: {
        packageName,
        latestVersion: "0.1.5",
        latestSdkAbiRange: "*",
        refreshedAt: new Date().toISOString(),
      },
      stale: false,
    }),
    isGatekeptInstallEnabled: () => false,
    plan,
    fetchDisplayInfo: async () => ({ displayName: "Research Assistant", sdkAbiRange: "*" }),
    checkRequiredPin: () => ({ ok: true }),
    ...over,
    // keep the (possibly overridden) plan mock addressable for assertions
  } as UpdatePlanPreviewDeps & { plan: ReturnType<typeof vi.fn> };
}

async function expectRefusal(
  deps: UpdatePlanPreviewDeps,
  category: string,
  input: Partial<Parameters<typeof computeExtensionUpdatePlanPreview>[0]> = {},
) {
  const err = await computeExtensionUpdatePlanPreview(
    { packageName: ROOT, orgId: null, ...input },
    deps,
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UpdatePlanRefusal);
  expect((err as UpdatePlanRefusal).category).toBe(category);
  return err as UpdatePlanRefusal;
}

describe("computeExtensionUpdatePlanPreview — guards (outcomes 4/5)", () => {
  it("refuses a github-sourced install (no version provenance) — never a string-equality fallback", async () => {
    const deps = makeDeps({ readInstalledRows: async () => [row(ROOT, null)] });
    await expectRefusal(deps, "unrecoverable");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses a 0.0.0-dev.* dev build (non-comparable)", async () => {
    const deps = makeDeps({
      readInstalledRows: async () => [row(ROOT, "0.0.0-dev.abc1234")],
    });
    await expectRefusal(deps, "unrecoverable");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses when there is no resolvable target (stale read model, no explicit target)", async () => {
    const deps = makeDeps({
      readUpdateReadout: async (packageName) => ({ packageName, entry: null, stale: true }),
    });
    await expectRefusal(deps, "unavailable-version");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses an up-to-date row (installed not semver-older than the target)", async () => {
    const deps = makeDeps({ readInstalledRows: async () => [row(ROOT, "0.1.5")] });
    await expectRefusal(deps, "unavailable-version");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses an ABI-incompatible target (deriveExtensionCompatState) — outcome 5", async () => {
    const deps = makeDeps({
      readUpdateReadout: async (packageName) => ({
        packageName,
        entry: {
          packageName,
          latestVersion: "0.1.5",
          latestSdkAbiRange: "^999.0.0",
          refreshedAt: new Date().toISOString(),
        },
        stale: false,
      }),
    });
    await expectRefusal(deps, "denied-entitlement");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses a target outside the required-pin range (locked/requiredInProd) — outcome 5", async () => {
    const deps = makeDeps({
      checkRequiredPin: () => ({
        ok: false,
        requiredRange: "^0.1.0",
        reason: "outside the pinned range",
      }),
      readUpdateReadout: async (packageName) => ({
        packageName,
        entry: {
          packageName,
          latestVersion: "0.2.0",
          latestSdkAbiRange: "*",
          refreshedAt: new Date().toISOString(),
        },
        stale: false,
      }),
    });
    await expectRefusal(deps, "denied-entitlement");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("gatekept: returns the one-member direct-update plan WITHOUT calling the planner (#1296 fence)", async () => {
    const deps = makeDeps({ isGatekeptInstallEnabled: () => true });
    const preview = await computeExtensionUpdatePlanPreview(
      { packageName: ROOT, orgId: null },
      deps,
    );
    expect(deps.plan).not.toHaveBeenCalled();
    expect(preview.members).toEqual([
      {
        packageName: ROOT,
        displayName: null,
        action: "update",
        fromVersion: "0.1.2",
        toVersion: "0.1.5",
        reboundToPackageName: null,
        isRoot: true,
      },
    ]);
  });

  it("dev path: dry-runs the EXISTING planner (rootAction:'update', closure:null) and maps displayNames", async () => {
    const deps = makeDeps();
    const preview = await computeExtensionUpdatePlanPreview(
      { packageName: ROOT, orgId: null },
      deps,
    );
    expect(deps.plan).toHaveBeenCalledTimes(1);
    expect(deps.plan.mock.calls[0]![0]).toMatchObject({
      root: { packageName: ROOT, version: "0.1.5" },
      closure: null,
      rootAction: "update",
    });
    expect(preview).toMatchObject({
      packageName: ROOT,
      fromVersion: "0.1.2",
      toVersion: "0.1.5",
    });
    expect(preview.members[0]).toMatchObject({
      packageName: ROOT,
      displayName: "Research Assistant",
      action: "update",
      isRoot: true,
    });
  });

  it("honors an explicit targetVersion over the read model (marketplace catalog path)", async () => {
    const deps = makeDeps();
    await computeExtensionUpdatePlanPreview(
      { packageName: ROOT, targetVersion: "0.1.9", orgId: null },
      deps,
    );
    expect(deps.plan.mock.calls[0]![0]).toMatchObject({
      root: { packageName: ROOT, version: "0.1.9" },
    });
  });

  it("dev path: FAILS CLOSED when the target manifest ABI read fails (info null) — outcome 5", async () => {
    // Explicit target NOT covered by the read model → abiRange undefined → the
    // dev-path packument read decides ABI; a null (failed) read must refuse,
    // never assume compatible (would diverge from apply, which fails closed).
    const deps = makeDeps({ fetchDisplayInfo: async () => null });
    await expectRefusal(deps, "unavailable-version", { targetVersion: "0.1.9" });
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("dev path: a genuine UNDECLARED range (info present, sdkAbiRange null) stays lenient — plans", async () => {
    // A successful read of a range-less manifest is "unknown" → allowed exactly
    // like the activation gate; it must NOT be conflated with the failed read.
    const deps = makeDeps({
      fetchDisplayInfo: async () => ({ displayName: "Research Assistant", sdkAbiRange: null }),
    });
    const preview = await computeExtensionUpdatePlanPreview(
      { packageName: ROOT, targetVersion: "0.1.9", orgId: null },
      deps,
    );
    expect(deps.plan).toHaveBeenCalledTimes(1);
    expect(preview.toVersion).toBe("0.1.9");
  });

  it("refuses an AMBIGUOUS live default (two defaults at one scope) — matches the planner's fail-closed row resolution", async () => {
    // The apply path's `defaultLiveRow` returns null (refuses) on >1 default at
    // a scope tier; the preview must not pick an arbitrary owner's fromVersion
    // and succeed where apply refuses (preview↔apply row-identity parity).
    const deps = makeDeps({
      readInstalledRows: async () => [row(ROOT, "0.1.2"), row(ROOT, "0.1.3")],
    });
    await expectRefusal(deps, "unrecoverable");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses when the org level holds only a NON-default sibling — matches the planner's level-then-default resolution", async () => {
    // The planner's `findLiveRowsInScope` claims the org level whenever it holds
    // ANY live row (default or not), THEN `defaultLiveRow` refuses because that
    // level has no default; it never falls through to the platform default. The
    // preview must resolve to null here too (not the platform row's version),
    // or it would render a plan the apply path refuses (row-selection parity).
    const deps = makeDeps({
      readInstalledRows: async () => [
        row(ROOT, "9.9.9", { organizationId: "org-1", isDefault: false } as Partial<InstalledExtension>),
        row(ROOT, "0.1.2", { organizationId: null }),
      ],
    });
    await expectRefusal(deps, "unrecoverable", { orgId: "org-1" });
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("refuses a ROOT update that would BREAK a live dependent — the same apply-time gate, run read-only in the preview", async () => {
    // The planner exempts the root from the conflict classifier, so its dry-run
    // alone misses a root update that violates a live dependent's blocking edge;
    // the apply path runs `assertUpdateDoesNotBreakDependents` for the root and
    // refuses. The preview runs the SAME gate so it refuses in lockstep instead
    // of showing a plan the admin confirms and apply then rejects.
    const deps = makeDeps({
      readInstalledRows: async () => [
        row(ROOT, "0.1.2"),
        // A live dependent pinned to the CURRENT root version — the 0.1.5 target
        // violates its blocking edge.
        row("@acme/summarizer", "2.2.0", { dependencies: [edge(ROOT, "0.1.2")] }),
      ],
    });
    const refusal = await expectRefusal(deps, "denied-entitlement");
    expect(refusal.message).toContain("@acme/summarizer");
    expect(deps.plan).not.toHaveBeenCalled();
  });
});
