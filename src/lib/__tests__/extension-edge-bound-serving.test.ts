import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  resolveEdgeBoundExtensionVersion,
  deriveDependentInstallIdForRun,
  dispatchExtensionMcpToolEdgeBound,
  EdgeBoundMcpServeRefusal,
  type ResolveEdgeBoundExtensionDeps,
  type RunRowForEdgeBoundServing,
} from "@/lib/extension-edge-bound-serving";
import {
  beginVersionKeyedRegistration,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";

// cinatra#1392 Gap 1 WIRING — the non-agent edge-bound serving binding:
// trusted-identity resolution (ActorContext / verified OBO run id), the
// top-level derivation bootstrap, the fail-closed decision matrix, and the
// MCP-tool dispatch chokepoint (a refusal NEVER falls through to the global
// handler).

const DEP_ID = "install-dependent-1";
const TARGET = "@x/target";
const V = "0.1.4";

type Row = Partial<InstalledExtension> & { id: string };

/** A fully-shaped resolved dependency edge (the canonical row type is strict). */
function edgeTo(packageName: string, resolvedInstallId: string) {
  return {
    packageName,
    edgeType: "runtime" as const,
    versionConstraint: { kind: "exact" as const, version: V },
    requirement: "required" as const,
    resolvedInstallId,
    resolutionReason: "test-fixture",
  };
}

function row(overrides: Row): InstalledExtension {
  return {
    packageName: TARGET,
    status: "active",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: null,
    isDefault: true,
    dependencyEdges: [],
    ...overrides,
  } as unknown as InstalledExtension;
}

/** Deps with a trusted ALS id and an in-memory row store. */
function makeDeps(input: {
  dependentInstallId?: string;
  verifiedRunId?: string;
  rows?: Record<string, InstalledExtension | null>;
  runs?: Record<string, RunRowForEdgeBoundServing | null>;
  templates?: Record<
    string,
    { packageName?: string | null; ownerLevel?: string | null; ownerId?: string | null } | null
  >;
  rowsByPackage?: Record<string, InstalledExtension[]>;
}): ResolveEdgeBoundExtensionDeps {
  return {
    getDependentInstallId: () => input.dependentInstallId,
    getVerifiedRunId: () => input.verifiedRunId,
    readInstalledExtensionById: async (id) => input.rows?.[id] ?? null,
    readAgentRunById: async (id) => input.runs?.[id] ?? null,
    readAgentTemplateById: async (id) => input.templates?.[id] ?? null,
    readInstalledExtensionsByPackageName: async (pkg) => input.rowsByPackage?.[pkg] ?? [],
  };
}

beforeEach(() => {
  __resetVersionKeyedServingForTests();
});

describe("resolveEdgeBoundExtensionVersion — trusted identity sources", () => {
  it("no trusted source at all → none (compatibility-preserving)", async () => {
    const d = await resolveEdgeBoundExtensionVersion({ targetPackageName: TARGET }, makeDeps({}));
    expect(d).toEqual({ kind: "none" });
  });

  it("ActorContext dependentInstallId wins over the run-id source", async () => {
    const reads: string[] = [];
    const deps = makeDeps({
      dependentInstallId: DEP_ID,
      verifiedRunId: "run-should-not-be-read",
      rows: { [DEP_ID]: row({ id: DEP_ID, packageName: "@x/dependent" }) },
    });
    deps.readAgentRunById = async (id) => {
      reads.push(id);
      return null;
    };
    const d = await resolveEdgeBoundExtensionVersion({ targetPackageName: TARGET }, deps);
    expect(d).toEqual({ kind: "none" }); // no edge on the dependent row
    expect(reads).toEqual([]); // the run row was never consulted
  });

  it("verified run id with a run row carrying dependent_install_id → uses it", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      makeDeps({
        verifiedRunId: "run-1",
        runs: {
          "run-1": { id: "run-1", templateId: "t1", orgId: "org-1", dependentInstallId: DEP_ID },
        },
        rows: {
          [DEP_ID]: row({
            id: DEP_ID,
            packageName: "@x/dependent",
            dependencyEdges: [edgeTo(TARGET, "install-target-default")],
          }) ,
          "install-target-default": row({ id: "install-target-default", isDefault: true }),
        },
      }),
    );
    expect(d).toEqual({ kind: "default" });
  });

  it("verified run id with NO run row → refuse (never an identity-less default)", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      makeDeps({ verifiedRunId: "run-gone" }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RUN_MISSING" });
  });

  it("top-level run (row without dependent_install_id) derives the identity", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      makeDeps({
        verifiedRunId: "run-top",
        runs: { "run-top": { id: "run-top", templateId: "t1", orgId: "org-1" } },
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({ id: DEP_ID, packageName: "@x/dependent", isDefault: true }),
          ],
        },
        rows: {
          [DEP_ID]: row({
            id: DEP_ID,
            packageName: "@x/dependent",
            dependencyEdges: [edgeTo(TARGET, "install-target-v")],
          }),
          "install-target-v": row({ id: "install-target-v", isDefault: false, version: V }),
        },
      }),
    );
    expect(d).toEqual({ kind: "versioned", version: V, resolvedInstallId: "install-target-v" });
  });
});

describe("resolveEdgeBoundExtensionVersion — fail-closed matrix (trusted id present)", () => {
  const base = (rows: Record<string, InstalledExtension | null>) =>
    makeDeps({ dependentInstallId: DEP_ID, rows });

  it("dependent row missing → refuse", async () => {
    const d = await resolveEdgeBoundExtensionVersion({ targetPackageName: TARGET }, base({}));
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_DEPENDENT_MISSING" });
  });

  it("no resolved edge to the target → none", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({ [DEP_ID]: row({ id: DEP_ID, packageName: "@x/dependent" }) }),
    );
    expect(d).toEqual({ kind: "none" });
  });

  it("edge to ANOTHER package only → none", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo("@x/other", "x")],
        }),
      }),
    );
    expect(d).toEqual({ kind: "none" });
  });

  it("dangling resolved row → refuse (stricter than the agent path, by design)", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "gone")],
        }),
      }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RESOLVED_MISSING" });
  });

  it("resolved row not live (archived) → refuse", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "arch")],
        }),
        arch: row({ id: "arch", status: "archived", isDefault: false, version: V }),
      }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RESOLVED_NOT_LIVE" });
  });

  it("resolved row is the default → default", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "def")],
        }),
        def: row({ id: "def", isDefault: true }),
      }),
    );
    expect(d).toEqual({ kind: "default" });
  });

  it("non-default with a version pin → versioned", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "nd")],
        }),
        nd: row({ id: "nd", isDefault: false, version: V }),
      }),
    );
    expect(d).toEqual({ kind: "versioned", version: V, resolvedInstallId: "nd" });
  });

  it("non-default with NO version pin → refuse (never silently the default)", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      base({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "np")],
        }),
        np: row({ id: "np", isDefault: false, version: undefined }),
      }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_VERSION_UNPINNED" });
  });
});

describe("deriveDependentInstallIdForRun — top-level bootstrap", () => {
  const depsFor = (input: Parameters<typeof makeDeps>[0]) => makeDeps(input);

  it("unpinned run, single DEFAULT live row → derived", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({ id: "nd", packageName: "@x/dependent", isDefault: false, version: "9.9.9" }),
            row({ id: "def", packageName: "@x/dependent", isDefault: true }),
          ],
        },
      }),
    );
    expect(d).toEqual({ kind: "derived", id: "def" });
  });

  it("REQUIRED-pin run (versionId + packageVersion) → the exact-version row", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1", versionId: "snap-1", packageVersion: V },
      depsFor({
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({ id: "def", packageName: "@x/dependent", isDefault: true, version: "2.0.0" }),
            row({ id: "pin", packageName: "@x/dependent", isDefault: false, version: V }),
          ],
        },
      }),
    );
    expect(d).toEqual({ kind: "derived", id: "pin" });
  });

  it("cross-org rows are never candidates", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({ id: "other-org", packageName: "@x/dependent", organizationId: "org-2" }),
          ],
        },
      }),
    );
    expect(d).toEqual({ kind: "none" });
  });

  it("a TEAM-owned install in the run's org is a legitimate single candidate", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({
              id: "team-row",
              packageName: "@x/dependent",
              ownerLevel: "team",
              ownerId: "team-9",
            }),
          ],
        },
      }),
    );
    expect(d).toEqual({ kind: "derived", id: "team-row" });
  });

  it("competing same-org candidates: the template's LOCKED owner anchor singles one out", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({
        templates: {
          t1: { packageName: "@x/dependent", ownerLevel: "organization", ownerId: "org-1" },
        },
        rowsByPackage: {
          "@x/dependent": [
            row({
              id: "user-row",
              packageName: "@x/dependent",
              ownerLevel: "user",
              ownerId: "user-7",
            }),
            row({
              id: "org-row",
              packageName: "@x/dependent",
              ownerLevel: "organization",
              ownerId: "org-1",
            }),
          ],
        },
      }),
    );
    expect(d).toEqual({ kind: "derived", id: "org-row" });
  });

  it("competing candidates with NO discriminating anchor → ambiguous (fail-closed)", async () => {
    const d = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({
        templates: { t1: { packageName: "@x/dependent" } }, // no anchor
        rowsByPackage: {
          "@x/dependent": [
            row({ id: "a", packageName: "@x/dependent" }),
            row({ id: "b", packageName: "@x/dependent" }),
          ],
        },
      }),
    );
    expect(d).toMatchObject({ kind: "ambiguous" });
  });

  it("no template packageName / no candidates → none (compatibility-preserving)", async () => {
    const noTemplate = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({ templates: { t1: { packageName: null } } }),
    );
    expect(noTemplate).toEqual({ kind: "none" });
    const noRows = await deriveDependentInstallIdForRun(
      { id: "r", templateId: "t1", orgId: "org-1" },
      depsFor({ templates: { t1: { packageName: "@x/dependent" } } }),
    );
    expect(noRows).toEqual({ kind: "none" });
  });

  it("resolver maps an ambiguous derivation to a refuse (dispatch hard-stops)", async () => {
    const d = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      makeDeps({
        verifiedRunId: "run-amb",
        runs: { "run-amb": { id: "run-amb", templateId: "t1", orgId: "org-1" } },
        templates: { t1: { packageName: "@x/dependent" } },
        rowsByPackage: {
          "@x/dependent": [
            row({ id: "a", packageName: "@x/dependent" }),
            row({ id: "b", packageName: "@x/dependent" }),
          ],
        },
      }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_DEPENDENT_AMBIGUOUS" });
  });
});

describe("dispatchExtensionMcpToolEdgeBound — the serve chokepoint", () => {
  const globalHandler = vi.fn(async () => "GLOBAL");
  const versionedHandler = vi.fn(async () => "VERSIONED");
  const tool = { packageName: TARGET, name: "do_thing", handler: globalHandler };

  beforeEach(() => {
    globalHandler.mockClear();
    versionedHandler.mockClear();
  });

  const versionedDeps = (rows: Record<string, InstalledExtension | null>) =>
    makeDeps({ dependentInstallId: DEP_ID, rows });

  function edgeToNonDefault(): Record<string, InstalledExtension | null> {
    return {
      [DEP_ID]: row({
        id: DEP_ID,
        packageName: "@x/dependent",
        dependencyEdges: [edgeTo(TARGET, "nd")],
      }),
      nd: row({ id: "nd", isDefault: false, version: V }),
    };
  }

  it("none → the global handler", async () => {
    const out = await dispatchExtensionMcpToolEdgeBound(tool, { a: 1 }, makeDeps({}));
    expect(out).toBe("GLOBAL");
    expect(globalHandler).toHaveBeenCalledWith({ a: 1 });
  });

  it("default → the global handler", async () => {
    const out = await dispatchExtensionMcpToolEdgeBound(
      tool,
      {},
      versionedDeps({
        [DEP_ID]: row({
          id: DEP_ID,
          packageName: "@x/dependent",
          dependencyEdges: [edgeTo(TARGET, "def")],
        }),
        def: row({ id: "def", isDefault: true }),
      }),
    );
    expect(out).toBe("GLOBAL");
  });

  it("versioned + servable → the RETAINED handler; the global handler is NEVER called", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "do_thing", handler: versionedHandler, packageName: TARGET });
    sink.commit();

    const out = await dispatchExtensionMcpToolEdgeBound(tool, { b: 2 }, versionedDeps(edgeToNonDefault()));
    expect(out).toBe("VERSIONED");
    expect(versionedHandler).toHaveBeenCalledWith({ b: 2 });
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("versioned + version never retained → throws UNKNOWN_VERSION; global NOT called", async () => {
    await expect(
      dispatchExtensionMcpToolEdgeBound(tool, {}, versionedDeps(edgeToNonDefault())),
    ).rejects.toMatchObject({ name: "EdgeBoundMcpServeRefusal", code: "UNKNOWN_VERSION" });
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("versioned + retained-but-uncommitted → throws NOT_SERVABLE; global NOT called", async () => {
    beginVersionKeyedRegistration(TARGET, V); // no commit
    await expect(
      dispatchExtensionMcpToolEdgeBound(tool, {}, versionedDeps(edgeToNonDefault())),
    ).rejects.toMatchObject({ code: "NOT_SERVABLE" });
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("versioned + servable-but-no-such-tool → throws NO_SUCH_HANDLER; global NOT called", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "other_tool", handler: versionedHandler, packageName: TARGET });
    sink.commit();
    await expect(
      dispatchExtensionMcpToolEdgeBound(tool, {}, versionedDeps(edgeToNonDefault())),
    ).rejects.toMatchObject({ code: "NO_SUCH_HANDLER" });
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("resolver refuse → throws the refusal; global NOT called", async () => {
    await expect(
      dispatchExtensionMcpToolEdgeBound(
        tool,
        {},
        makeDeps({ dependentInstallId: DEP_ID }), // dependent row missing
      ),
    ).rejects.toBeInstanceOf(EdgeBoundMcpServeRefusal);
    expect(globalHandler).not.toHaveBeenCalled();
  });
});
