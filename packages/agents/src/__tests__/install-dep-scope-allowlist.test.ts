// cinatra#1039 Phase 2 — the agent full-tree installer routes through the
// UNIFIED dependency planner (`planDependencyInstall`) instead of the deleted
// @cinatra-ai/registries "prefer-newer" resolver.
//
// Issue #103 regression posture: the dependency-scope allowlist is derived
// INSIDE the planner from the ROOT package's own vendor scope + the
// first-party base scope (locked by the planner's own DEPENDENCY_SCOPE
// suite in src/lib/__tests__/extension-dependency-plan.test.ts). This file
// locks the agent-path invariants around that seam: the planner input never
// carries the instance namespace, the derived rowOwnership tuple is correct,
// the executor realizes the plan (deps first, skip already-at-pin, root
// always executes, owner tier stamped, cross-kind/side-by-side fail loud),
// and the WayFlow reload result surfaces verbatim (#157).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { planDependencyInstallMock, installAgentFromPackageMock, triggerWayflowReloadMock } =
  vi.hoisted(() => ({
    planDependencyInstallMock: vi.fn(),
    installAgentFromPackageMock: vi.fn(),
    triggerWayflowReloadMock: vi.fn(),
  }));

vi.mock("@/lib/extension-dependency-plan", () => ({
  planDependencyInstall: planDependencyInstallMock,
}));
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: installAgentFromPackageMock,
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: triggerWayflowReloadMock,
}));
vi.mock("../materialize-agent-package", () => ({
  withGlobalExtensionLifecycleLock: (fn: () => Promise<unknown>) => fn(),
}));

import { installAgentPackageWithDependencies } from "../install-package-with-dependencies";

const INSTANCE_SCOPED_CONFIG = {
  registryUrl: "https://r.example",
  // Deliberately an instance-namespace scope (the issue #103 trigger shape):
  // nothing derived from it may reach the planner.
  packageScope: "@curly-african-blonde",
  token: "tok",
  uiUrl: null,
};

type PlanMember = {
  packageName: string;
  version: string;
  typeId: string;
  edges: unknown[];
  alreadyInstalled: boolean;
  rowOwnership: { ownerLevel: string; ownerId: string | null; organizationId: string | null };
  action: "install" | "update" | "install-side-by-side";
  sideBySideEvidence?: { dependents: string[]; detail: string };
};

function member(packageName: string, over: Partial<PlanMember> = {}): PlanMember {
  return {
    packageName,
    version: "1.0.0",
    typeId: "agent",
    edges: [],
    alreadyInstalled: false,
    rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
    action: "install",
    ...over,
  };
}

function mockPlan(rootName: string, ordered: PlanMember[], kinds?: Map<string, string>) {
  planDependencyInstallMock.mockResolvedValue({
    ordered,
    root: { packageName: rootName, version: ordered[ordered.length - 1]!.version },
    source: "manifest-walk",
    memberKinds: kinds ?? new Map(ordered.map((m) => [m.packageName, "agent"])),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  triggerWayflowReloadMock.mockResolvedValue({ ok: true });
  installAgentFromPackageMock.mockImplementation(async (input: { packageName: string }) => ({
    templateId: `tpl-${input.packageName}`,
  }));
});

describe("installAgentPackageWithDependencies — unified-planner routing", () => {
  it("plans through the unified planner; the instance namespace never reaches the planner input", async () => {
    const ROOT = "@cinatra-ai/blog-idea-generator-agent";
    mockPlan(ROOT, [member(ROOT)]);
    await installAgentPackageWithDependencies({ packageName: ROOT }, INSTANCE_SCOPED_CONFIG);

    expect(planDependencyInstallMock).toHaveBeenCalledTimes(1);
    const [planInput] = planDependencyInstallMock.mock.calls[0]!;
    expect(planInput).toMatchObject({
      root: { packageName: ROOT, version: "latest" },
      orgId: null,
      closure: null,
      // No explicit owner tier + no org → the canonical platform default.
      rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
    });
    // Issue #103: the allowlist derivation is planner-internal (keyed on the
    // ROOT name); the instance namespace must not ride the planner input.
    expect(JSON.stringify(planInput)).not.toContain("curly-african-blonde");
  });

  it("derives the rowOwnership tuple from the threaded owner tier and stamps every member install", async () => {
    const ROOT = "@cinatra-ai/root-agent";
    const DEP = "@cinatra-ai/dep-agent";
    mockPlan(ROOT, [member(DEP), member(ROOT)]);
    await installAgentPackageWithDependencies(
      {
        packageName: ROOT,
        packageVersion: "2.0.0",
        orgId: "org-x",
        ownerLevel: "team",
        ownerId: "team-1",
        creatorId: "user-1",
        status: "published",
      },
      INSTANCE_SCOPED_CONFIG,
    );

    const [planInput] = planDependencyInstallMock.mock.calls[0]!;
    expect(planInput).toMatchObject({
      root: { packageName: ROOT, version: "2.0.0" },
      orgId: "org-x",
      rowOwnership: { ownerLevel: "team", ownerId: "team-1", organizationId: "org-x" },
    });
    // Deps first, root last; each stamped with the ROOT's owner tuple
    // (cinatra#1039 decision 4 — dependencies inherit the root install's owner).
    expect(installAgentFromPackageMock.mock.calls.map((c) => c[0].packageName)).toEqual([
      DEP,
      ROOT,
    ]);
    for (const [input] of installAgentFromPackageMock.mock.calls) {
      expect(input).toMatchObject({ ownerLevel: "team", ownerId: "team-1", orgId: "org-x" });
    }
  });

  it("skips members already installed at the exact pin, but ALWAYS executes the root (reinstall/refresh)", async () => {
    const ROOT = "@cinatra-ai/root-agent";
    const DEP = "@cinatra-ai/dep-agent";
    mockPlan(ROOT, [member(DEP, { alreadyInstalled: true }), member(ROOT)]);
    const res = await installAgentPackageWithDependencies(
      { packageName: ROOT },
      INSTANCE_SCOPED_CONFIG,
    );
    expect(installAgentFromPackageMock.mock.calls.map((c) => c[0].packageName)).toEqual([ROOT]);
    expect(res.rootTemplateId).toBe(`tpl-${ROOT}`);
    expect(res.installedTemplateIds).toEqual([`tpl-${ROOT}`]);
    // The full plan (including the skipped member) is surfaced for callers.
    expect(res.plannedMembers.map((m) => m.packageName)).toEqual([DEP, ROOT]);
  });

  it("routes the ROOT's store-payload flags only to the root node", async () => {
    const ROOT = "@cinatra-ai/root-agent";
    const DEP = "@cinatra-ai/dep-agent";
    mockPlan(ROOT, [member(DEP), member(ROOT)]);
    await installAgentPackageWithDependencies(
      { packageName: ROOT, anchorOrgId: "org-x", requireStorePayloadForRoot: true },
      INSTANCE_SCOPED_CONFIG,
    );
    const byName = new Map(
      installAgentFromPackageMock.mock.calls.map((c) => [c[0].packageName, c[0]]),
    );
    expect(byName.get(ROOT)).toMatchObject({ anchorOrgId: "org-x", requireStorePayload: true });
    expect(byName.get(DEP)!.anchorOrgId).toBeUndefined();
    expect(byName.get(DEP)!.requireStorePayload).toBeUndefined();
  });

  it("fails loud on a resolved CROSS-KIND member (agent-only executor)", async () => {
    const ROOT = "@cinatra-ai/root-agent";
    const DEP = "@cinatra-ai/some-connector";
    mockPlan(
      ROOT,
      [member(DEP), member(ROOT)],
      new Map([
        [DEP, "connector"],
        [ROOT, "agent"],
      ]),
    );
    await expect(
      installAgentPackageWithDependencies({ packageName: ROOT }, INSTANCE_SCOPED_CONFIG),
    ).rejects.toThrow(/can only install agents/);
    expect(installAgentFromPackageMock).not.toHaveBeenCalled();
  });

  it("fails loud on a planned SIDE-BY-SIDE member (one template row per package on this path)", async () => {
    const ROOT = "@cinatra-ai/root-agent";
    const DEP = "@cinatra-ai/dep-agent";
    mockPlan(ROOT, [
      member(DEP, {
        action: "install-side-by-side",
        sideBySideEvidence: { dependents: ["@cinatra-ai/consumer"], detail: "range refused" },
      }),
      member(ROOT),
    ]);
    await expect(
      installAgentPackageWithDependencies({ packageName: ROOT }, INSTANCE_SCOPED_CONFIG),
    ).rejects.toThrow(/SIDE-BY-SIDE/);
  });
});

describe("installAgentPackageWithDependencies — reload result surfacing (#157)", () => {
  it("surfaces a NON-THROWING {ok:false} reload result verbatim (reason NOT remapped)", async () => {
    const ROOT = "@cinatra-ai/some-agent";
    mockPlan(ROOT, [member(ROOT)]);
    triggerWayflowReloadMock.mockResolvedValueOnce({ ok: false, reason: "timeout", detail: "aborted" });
    const res = await installAgentPackageWithDependencies(
      { packageName: ROOT },
      INSTANCE_SCOPED_CONFIG,
    );
    // Install completed despite reload failure (durable writes already landed).
    expect(res.rootTemplateId).toBe(`tpl-${ROOT}`);
    // The reloader's own result passes straight through VERBATIM — both reason
    // and detail are preserved, NOT remapped to the "network" thrown-error shape.
    expect(res.wayflowReload).toMatchObject({ ok: false, reason: "timeout", detail: "aborted" });
  });

  it("maps a THROWN reload error to the typed {ok:false, reason:'network'} shape and still resolves", async () => {
    const ROOT = "@cinatra-ai/some-agent";
    mockPlan(ROOT, [member(ROOT)]);
    triggerWayflowReloadMock.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await installAgentPackageWithDependencies(
      { packageName: ROOT },
      INSTANCE_SCOPED_CONFIG,
    );
    expect(res.rootTemplateId).toBe(`tpl-${ROOT}`);
    expect(res.wayflowReload).toMatchObject({ ok: false, reason: "network" });
    expect((res.wayflowReload as { detail?: string }).detail).toContain("socket hang up");
  });
});
