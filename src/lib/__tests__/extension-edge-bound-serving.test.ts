import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  resolveEdgeBoundExtensionVersion,
  deriveDependentInstallIdForRun,
  dispatchExtensionMcpToolEdgeBound,
  dispatchPlannedExtensionMcpTool,
  dispatchVersionedOnlyExtensionMcpTool,
  planExtensionToolDiscovery,
  planSelfInvokerRetainedUnion,
  EdgeBoundMcpServeRefusal,
  owningPackageOfObjectType,
  DYNAMIC_OBJECT_TYPE_ID_PREFIXES,
  resolveEdgeBoundObjectType,
  planEdgeBoundObjectTypeListing,
  getPublishedObjectTypeServePort,
  type ResolveEdgeBoundExtensionDeps,
  type RunRowForEdgeBoundServing,
} from "@/lib/extension-edge-bound-serving";
import { TOMBSTONED_OBJECT_TYPE_ID_PREFIXES } from "@cinatra-ai/objects/namespace";
import {
  _resetExtensionMcpForTests,
  getEffectiveExtensionMcpTool,
  markEffectiveExtensionMcpTools,
  unmarkEffectiveExtensionMcpToolCollisions,
} from "@/lib/extension-mcp-registry";
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

// ---------------------------------------------------------------------------
// cinatra#1392 S8 — extension-ctx dependent identity (source 0)
// ---------------------------------------------------------------------------

describe("resolveEdgeBoundExtensionVersion — extension-ctx identity (S8 source 0)", () => {
  const CALLER = "@x/caller";

  it("ctx identity OUTRANKS the ActorContext dependent id (the immediate caller wins)", async () => {
    const ctxRow = row({
      id: "install-ctx-caller",
      packageName: CALLER,
      dependencyEdges: [edgeTo(TARGET, "install-target-sib")],
    });
    const otherDependent = row({ id: DEP_ID, packageName: "@x/outer", dependencyEdges: [] });
    const sib = row({ id: "install-target-sib", isDefault: false, version: V });
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({
          dependentInstallId: DEP_ID, // would decide "none" (no edges)
          rows: { [DEP_ID]: otherDependent, "install-target-sib": sib },
          rowsByPackage: { [CALLER]: [ctxRow] },
        }),
        getCtxIdentity: () => ({ packageName: CALLER, version: null, isDefault: true }),
      },
    );
    expect(out).toEqual({ kind: "versioned", version: V, resolvedInstallId: "install-target-sib" });
  });

  it("DEFAULT ctx identity with no canonical row falls through to the run lineage (none here)", async () => {
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({ rowsByPackage: { [CALLER]: [] } }),
        getCtxIdentity: () => ({ packageName: CALLER, version: null, isDefault: true }),
      },
    );
    expect(out).toEqual({ kind: "none" });
  });

  it("NON-DEFAULT ctx identity with no live row → refuse (torn state, never an identity-less default)", async () => {
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({ rowsByPackage: { [CALLER]: [] } }),
        getCtxIdentity: () => ({ packageName: CALLER, version: V, isDefault: false }),
      },
    );
    expect(out).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_DEPENDENT_MISSING" });
  });

  it("NON-DEFAULT ctx identity binds the row at ITS exact version", async () => {
    const sibCaller = row({
      id: "install-caller-sib",
      packageName: CALLER,
      isDefault: false,
      version: "9.9.9",
      dependencyEdges: [edgeTo(TARGET, "install-target-sib")],
    });
    const defCaller = row({ id: "install-caller-def", packageName: CALLER, dependencyEdges: [] });
    const sib = row({ id: "install-target-sib", isDefault: false, version: V });
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({
          rows: { "install-target-sib": sib },
          rowsByPackage: { [CALLER]: [defCaller, sibCaller] },
        }),
        getCtxIdentity: () => ({ packageName: CALLER, version: "9.9.9", isDefault: false }),
      },
    );
    expect(out).toEqual({ kind: "versioned", version: V, resolvedInstallId: "install-target-sib" });
  });

  it("ambiguous ctx-identity match (two live defaults) → refuse (never an arbitrary pick)", async () => {
    const a = row({ id: "install-a", packageName: CALLER, organizationId: "org-1" });
    const b = row({ id: "install-b", packageName: CALLER, organizationId: "org-2" });
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({ rowsByPackage: { [CALLER]: [a, b] } }),
        getCtxIdentity: () => ({ packageName: CALLER, version: null, isDefault: true }),
      },
    );
    expect(out).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_DEPENDENT_AMBIGUOUS" });
  });
});

// ---------------------------------------------------------------------------
// cinatra#1392 S8 — the strict VERSIONED-ONLY dispatch
// ---------------------------------------------------------------------------

describe("dispatchVersionedOnlyExtensionMcpTool — strict matrix (S8)", () => {
  const versionedHandler = vi.fn(async () => ({ served: "versioned" }));

  beforeEach(() => versionedHandler.mockClear());

  function pinnedDeps() {
    const dependent = row({ id: DEP_ID, packageName: "@x/consumer", dependencyEdges: [edgeTo(TARGET, "install-sib")] });
    const sib = row({ id: "install-sib", isDefault: false, version: V });
    return makeDeps({ dependentInstallId: DEP_ID, rows: { [DEP_ID]: dependent, "install-sib": sib } });
  }

  it("versioned + servable → the retained handler", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "only_in_v", handler: versionedHandler, packageName: TARGET });
    sink.commit();
    const out = await dispatchVersionedOnlyExtensionMcpTool(
      { packageName: TARGET, name: "only_in_v" },
      { q: 1 },
      pinnedDeps(),
    );
    expect(out).toEqual({ served: "versioned" });
    expect(versionedHandler).toHaveBeenCalledWith({ q: 1 });
  });

  it("caller with NO pin on the package → EDGE_BOUND_VERSIONED_ONLY_UNBOUND (the tool does not exist for it)", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "only_in_v", handler: versionedHandler, packageName: TARGET });
    sink.commit();
    await expect(
      dispatchVersionedOnlyExtensionMcpTool({ packageName: TARGET, name: "only_in_v" }, {}, makeDeps({})),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_VERSIONED_ONLY_UNBOUND" });
    expect(versionedHandler).not.toHaveBeenCalled();
  });

  it("caller pinned to a DIFFERENT version lacking the name → NO_SUCH_HANDLER", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "other_tool", handler: versionedHandler, packageName: TARGET });
    sink.commit();
    await expect(
      dispatchVersionedOnlyExtensionMcpTool({ packageName: TARGET, name: "only_in_v" }, {}, pinnedDeps()),
    ).rejects.toMatchObject({ code: "NO_SUCH_HANDLER" });
  });

  it("identity refuse propagates with its evidence", async () => {
    await expect(
      dispatchVersionedOnlyExtensionMcpTool(
        { packageName: TARGET, name: "only_in_v" },
        {},
        makeDeps({ dependentInstallId: DEP_ID }), // dependent row missing
      ),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_DEPENDENT_MISSING" });
  });
});

// ---------------------------------------------------------------------------
// cinatra#1392 S8 — the tool DISCOVERY union planner
// ---------------------------------------------------------------------------

describe("planExtensionToolDiscovery — the per-caller tool set (S8)", () => {
  const OTHER = "@x/other";
  const h = async () => ({});
  const defaults = [
    { name: "t_shared", packageName: TARGET, description: "default shared", inputSchema: "SCHEMA_DEFAULT", handler: h },
    { name: "t_default_only", packageName: TARGET, handler: h },
    { name: "o_tool", packageName: OTHER, handler: h },
  ];

  function pinnedDeps(extra: Partial<ResolveEdgeBoundExtensionDeps> = {}) {
    const dependent = row({ id: DEP_ID, packageName: "@x/consumer", dependencyEdges: [edgeTo(TARGET, "install-sib")] });
    const sib = row({ id: "install-sib", isDefault: false, version: V });
    return {
      ...makeDeps({ dependentInstallId: DEP_ID, rows: { [DEP_ID]: dependent, "install-sib": sib } }),
      ...extra,
    };
  }

  it("no identity → the EXACT default replay (order preserved)", async () => {
    const plan = await planExtensionToolDiscovery(defaults, makeDeps({}));
    expect(plan.entries).toEqual(defaults.map((tool) => ({ mode: "default", tool })));
    expect(plan.notes).toEqual([]);
  });

  it("identity refuse → default names stay advertised (call-time refusal carries the evidence) + a note", async () => {
    const plan = await planExtensionToolDiscovery(
      defaults,
      makeDeps({ dependentInstallId: DEP_ID }), // dependent row missing
    );
    expect(plan.entries).toEqual(defaults.map((tool) => ({ mode: "default", tool })));
    expect(plan.notes.join(" ")).toContain("EDGE_BOUND_DEPENDENT_MISSING");
  });

  it("versioned pin: both-present name carries the RESOLVED schema; default-only hidden; versioned-only appended; other packages untouched", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "t_shared", inputSchema: "SCHEMA_V", handler: h, packageName: TARGET } as never);
    sink.retainMcpTool({ name: "t_only_in_v", handler: h, packageName: TARGET });
    sink.commit();

    const plan = await planExtensionToolDiscovery(defaults, pinnedDeps());
    expect(plan.entries.map((e) => [e.mode, e.tool.name])).toEqual([
      ["versioned", "t_shared"],   // in the default position, resolved schema
      // t_default_only HIDDEN (the pinned version does not register it)
      ["default", "o_tool"],       // unpinned package: untouched
      ["versioned", "t_only_in_v"], // appended versioned-only name
    ]);
    const shared = plan.entries[0];
    if (shared.mode !== "versioned") throw new Error("expected versioned");
    expect(shared.tool.inputSchema).toBe("SCHEMA_V");
    expect(shared.defaultTool?.name).toBe("t_shared"); // S7 chokepoint dispatch
    expect(shared.version).toBe(V);
    const last = plan.entries[plan.entries.length - 1];
    if (last.mode !== "versioned") throw new Error("expected versioned");
    expect(last.defaultTool).toBeUndefined(); // strict versioned-only dispatch
  });

  it("torn retained lookup (pin exists, version never retained) → default names advertised + a note", async () => {
    const plan = await planExtensionToolDiscovery(defaults, pinnedDeps());
    expect(plan.entries).toEqual(defaults.map((tool) => ({ mode: "default", tool })));
    expect(plan.notes.join(" ")).toContain("UNKNOWN_VERSION");
  });

  it("an edge-target package with NO default tools still contributes its pinned names", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "fresh_tool", handler: h, packageName: TARGET });
    sink.commit();
    const plan = await planExtensionToolDiscovery(
      defaults.filter((t) => t.packageName !== TARGET), // TARGET registers no default tools
      pinnedDeps(),
    );
    expect(plan.entries.map((e) => [e.mode, e.tool.name])).toEqual([
      ["default", "o_tool"],
      ["versioned", "fresh_tool"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#1392 S8 round-1 — exact installId binding + plan-pinned dispatch
// ---------------------------------------------------------------------------

describe("extension-ctx identity with an EXACT installId (codex round-0 #1)", () => {
  const CALLER = "@x/caller";

  it("binds the exact row — no shape-based derivation", async () => {
    const exact = row({
      id: "install-exact",
      packageName: CALLER,
      dependencyEdges: [edgeTo(TARGET, "install-target-sib")],
    });
    // A same-shape sibling with DIFFERENT edges exists — must not be consulted.
    const sibling = row({ id: "install-shape-sibling", packageName: CALLER, dependencyEdges: [] });
    const sib = row({ id: "install-target-sib", isDefault: false, version: V });
    const out = await resolveEdgeBoundExtensionVersion(
      { targetPackageName: TARGET },
      {
        ...makeDeps({
          rows: { "install-exact": exact, "install-target-sib": sib },
          rowsByPackage: { [CALLER]: [sibling, exact] },
        }),
        getCtxIdentity: () => ({ packageName: CALLER, installId: "install-exact", version: null, isDefault: true }),
      },
    );
    expect(out).toEqual({ kind: "versioned", version: V, resolvedInstallId: "install-target-sib" });
  });

  it("an id whose row is gone or not live REFUSES (torn; never falls back to shape matching)", async () => {
    const archived = row({ id: "install-exact", packageName: CALLER, status: "archived" });
    for (const rows of [{}, { "install-exact": archived }]) {
      const out = await resolveEdgeBoundExtensionVersion(
        { targetPackageName: TARGET },
        {
          ...makeDeps({ rows: rows as never, rowsByPackage: { [CALLER]: [row({ id: "x", packageName: CALLER })] } }),
          getCtxIdentity: () => ({ packageName: CALLER, installId: "install-exact", version: null, isDefault: true }),
        },
      );
      expect(out).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_DEPENDENT_MISSING" });
    }
  });
});

describe("dispatchPlannedExtensionMcpTool — plan-pinned dispatch (codex round-0 #3)", () => {
  const globalHandler = vi.fn(async () => ({ served: "global" }));
  const versionedHandler = vi.fn(async () => ({ served: "versioned" }));
  beforeEach(() => {
    globalHandler.mockClear();
    versionedHandler.mockClear();
  });

  const defaultTool = { packageName: TARGET, name: "the_tool", handler: globalHandler };

  function depsWith(decisionRows: { edges?: boolean; sib?: InstalledExtension }) {
    const dependent = row({
      id: DEP_ID,
      packageName: "@x/consumer",
      dependencyEdges: decisionRows.edges === false ? [] : [edgeTo(TARGET, "install-sib")],
    });
    const sib = decisionRows.sib ?? row({ id: "install-sib", isDefault: false, version: V });
    return makeDeps({ dependentInstallId: DEP_ID, rows: { [DEP_ID]: dependent, "install-sib": sib } });
  }

  it("planned DEFAULT + decision none/default → the global handler", async () => {
    const out = await dispatchPlannedExtensionMcpTool(
      { expected: "default", tool: defaultTool },
      { a: 1 },
      depsWith({ edges: false }),
    );
    expect(out).toEqual({ served: "global" });
  });

  it("planned DEFAULT + decision flips to versioned → EDGE_BOUND_PLAN_DRIFT (never crosses schemas)", async () => {
    await expect(
      dispatchPlannedExtensionMcpTool({ expected: "default", tool: defaultTool }, {}, depsWith({})),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_PLAN_DRIFT" });
    expect(globalHandler).not.toHaveBeenCalled();
  });

  it("planned VERSIONED + decision matches → the retained handler", async () => {
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainMcpTool({ name: "the_tool", handler: versionedHandler, packageName: TARGET });
    sink.commit();
    const out = await dispatchPlannedExtensionMcpTool(
      { expected: "versioned", packageName: TARGET, name: "the_tool", version: V },
      { b: 2 },
      depsWith({}),
    );
    expect(out).toEqual({ served: "versioned" });
    expect(versionedHandler).toHaveBeenCalledWith({ b: 2 });
  });

  it("planned VERSIONED + decision flips to default/none or ANOTHER version → EDGE_BOUND_PLAN_DRIFT", async () => {
    // Flip to none (edge gone).
    await expect(
      dispatchPlannedExtensionMcpTool(
        { expected: "versioned", packageName: TARGET, name: "the_tool", version: V },
        {},
        depsWith({ edges: false }),
      ),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_PLAN_DRIFT" });
    // Flip to a DIFFERENT version.
    await expect(
      dispatchPlannedExtensionMcpTool(
        { expected: "versioned", packageName: TARGET, name: "the_tool", version: "9.9.9" },
        {},
        depsWith({}),
      ),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_PLAN_DRIFT" });
  });

  it("identity refuse propagates with its evidence", async () => {
    await expect(
      dispatchPlannedExtensionMcpTool(
        { expected: "default", tool: defaultTool },
        {},
        makeDeps({ dependentInstallId: DEP_ID }), // dependent row missing
      ),
    ).rejects.toMatchObject({ code: "EDGE_BOUND_DEPENDENT_MISSING" });
  });
});

describe("planSelfInvokerRetainedUnion — collision classes (codex S8 round-2 #1)", () => {
  const P = "@x/pkg";
  const retained = (name: string, version: string, pkg = P) => ({
    packageName: pkg,
    version,
    tool: { name, packageName: pkg, handler: async () => "retained" },
  });

  beforeEach(() => {
    _resetExtensionMcpForTests();
  });

  it("default P:x + retained P@v:x → deduped, NOT unmark-worthy; the default's effective attribution SURVIVES", () => {
    const plan = planSelfInvokerRetainedUnion([retained("x", "0.2.0")], {
      hostClaimedNames: new Set(),
      extensionClaimedNames: new Set(["x"]), // the default replay registered P:x
    });
    expect(plan.register).toEqual([]);
    expect(plan.effective).toEqual([]);
    expect(plan.skippedHostCollisions).toEqual([]);
    expect(plan.dedupedExtensionNames).toEqual([{ name: "x", packageName: P, version: "0.2.0" }]);

    // The full mark/unmark cycle the self-invoker builder runs: the winning
    // default attribution must survive (the regression: pushing the dedupe
    // into the skip list erased it because the packages match, and the
    // deny-by-default boundary then blocked the registered handler).
    markEffectiveExtensionMcpTools([{ name: "x", packageName: P }, ...plan.effective]);
    unmarkEffectiveExtensionMcpToolCollisions(plan.skippedHostCollisions);
    expect(getEffectiveExtensionMcpTool("x")).toEqual({ packageName: P });
  });

  it("two retained versions of P:x → first wins + registers; second deduped; the winner's attribution SURVIVES", () => {
    const plan = planSelfInvokerRetainedUnion([retained("x", "0.2.0"), retained("x", "0.3.0")], {
      hostClaimedNames: new Set(),
      extensionClaimedNames: new Set(), // no default registers the name
    });
    expect(plan.register).toEqual([{ name: "x", packageName: P, version: "0.2.0" }]);
    expect(plan.effective).toEqual([{ name: "x", packageName: P }]);
    expect(plan.skippedHostCollisions).toEqual([]);
    expect(plan.dedupedExtensionNames).toEqual([{ name: "x", packageName: P, version: "0.3.0" }]);

    markEffectiveExtensionMcpTools(plan.effective);
    unmarkEffectiveExtensionMcpToolCollisions(plan.skippedHostCollisions);
    expect(getEffectiveExtensionMcpTool("x")).toEqual({ packageName: P });
  });

  it("cross-package retained collision (P@v:x then Q@w:x) → first wins; loser deduped, winner survives", () => {
    const Q = "@y/other";
    const plan = planSelfInvokerRetainedUnion([retained("x", "0.2.0"), retained("x", "1.0.0", Q)], {
      hostClaimedNames: new Set(),
      extensionClaimedNames: new Set(),
    });
    expect(plan.register).toEqual([{ name: "x", packageName: P, version: "0.2.0" }]);
    expect(plan.dedupedExtensionNames).toEqual([{ name: "x", packageName: Q, version: "1.0.0" }]);

    markEffectiveExtensionMcpTools(plan.effective);
    unmarkEffectiveExtensionMcpToolCollisions(plan.skippedHostCollisions);
    expect(getEffectiveExtensionMcpTool("x")).toEqual({ packageName: P });
  });

  it("host/module/reserved collision → unmark-worthy: a stale attribution to the SAME package is erased (round-1 #3 preserved)", () => {
    const plan = planSelfInvokerRetainedUnion([retained("system_screen_lookup", "0.2.0")], {
      hostClaimedNames: new Set(["system_screen_lookup"]),
      extensionClaimedNames: new Set(),
    });
    expect(plan.register).toEqual([]);
    expect(plan.skippedHostCollisions).toEqual([{ name: "system_screen_lookup", packageName: P }]);

    // A stale effective entry attributing the host name to this package (e.g.
    // from a build before the host claimed the name) must NOT survive.
    markEffectiveExtensionMcpTools([{ name: "system_screen_lookup", packageName: P }]);
    unmarkEffectiveExtensionMcpToolCollisions(plan.skippedHostCollisions);
    expect(getEffectiveExtensionMcpTool("system_screen_lookup")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cinatra#1392 OBJECT-TYPE SERVE — the final positive-serving surface.
// The CONSUME side of `ctx.objects.registerType`, edge-bound + fail-closed, on
// the two object-type consumers (objects_save POINT resolve, objects_types_list
// per-package substitution). Same fail-closed matrix as the MCP-tool kind.
// ---------------------------------------------------------------------------

function retainObjectTypeVersion(pkg: string, ver: string, typeIds: string[]) {
  const sink = beginVersionKeyedRegistration(pkg, ver);
  for (const typeId of typeIds) sink.retainObjectType({ typeId, category: "data" });
  sink.commit();
}

describe("owningPackageOfObjectType", () => {
  it("extracts the owning package from a namespaced id; null otherwise", () => {
    expect(owningPackageOfObjectType("@x/target:event")).toBe("@x/target");
    expect(owningPackageOfObjectType("@cinatra-ai/pkg-name:local-id")).toBe("@cinatra-ai/pkg-name");
    // Dynamic / legacy-dynamic / un-namespaced → NO owning extension package
    // (an LLM-proposed / auto-registered type is never edge-bound to a package).
    expect(owningPackageOfObjectType("@dynamic/types:invoice")).toBeNull();
    expect(owningPackageOfObjectType("@cinatra-ai/dynamic:invoice")).toBeNull();
    expect(owningPackageOfObjectType("plain-type")).toBeNull();
    expect(owningPackageOfObjectType("")).toBeNull();
    expect(owningPackageOfObjectType(undefined as never)).toBeNull();
    // NEAR-MISS (cinatra#1789, prefix-exact): a look-alike scope/package is a
    // NORMAL extension type, NOT a tombstoned dynamic id — it keeps its owning
    // package and stays edge-bindable.
    expect(owningPackageOfObjectType("@dynamics/types:invoice")).toBe("@dynamics/types");
    expect(owningPackageOfObjectType("@dynamic/typesx:invoice")).toBe("@dynamic/typesx");
  });

  it("the inlined dynamic-prefix exclusion set is pinned byte-equal to the objects tombstone source of truth (cinatra#1789)", () => {
    // This host lib cannot import @cinatra-ai/objects (route-graph is
    // shrink-only), so it inlines DYNAMIC_OBJECT_TYPE_ID_PREFIXES — this pin
    // guarantees the inline copy never drifts from the canonical declaration.
    expect([...DYNAMIC_OBJECT_TYPE_ID_PREFIXES]).toEqual([...TOMBSTONED_OBJECT_TYPE_ID_PREFIXES]);
  });
});

describe("resolveEdgeBoundObjectType — POINT serve (objects_save)", () => {
  const TYPE = `${TARGET}:event`;

  it("un-namespaced type → none (no owning package to edge-bind)", async () => {
    const d = await resolveEdgeBoundObjectType("plain-type", makeDeps({ dependentInstallId: DEP_ID }));
    expect(d).toEqual({ kind: "none" });
  });

  it("edge resolves to the DEFAULT install → default (global type governs)", async () => {
    const d = await resolveEdgeBoundObjectType(
      TYPE,
      makeDeps({
        dependentInstallId: DEP_ID,
        rows: {
          [DEP_ID]: row({
            id: DEP_ID,
            packageName: "@x/dependent",
            dependencyEdges: [edgeTo(TARGET, "install-target-default")],
          }),
          "install-target-default": row({ id: "install-target-default", isDefault: true }),
        },
      }),
    );
    expect(d).toEqual({ kind: "default" });
  });

  it("edge pins a NON-DEFAULT version that registered the type → versioned serve", async () => {
    retainObjectTypeVersion(TARGET, V, [TYPE]);
    const d = await resolveEdgeBoundObjectType(
      TYPE,
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(d).toMatchObject({ kind: "versioned", version: V, resolvedInstallId: "install-target-v" });
    if (d.kind !== "versioned") throw new Error("expected versioned");
    expect(d.descriptor.typeId).toBe(TYPE);
  });

  it("edge pins a NON-DEFAULT version that did NOT register the type → refuse (never the default's type)", async () => {
    retainObjectTypeVersion(TARGET, V, [`${TARGET}:other`]); // registers a DIFFERENT type
    const d = await resolveEdgeBoundObjectType(
      TYPE,
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(d).toMatchObject({ kind: "refuse", code: "NO_SUCH_HANDLER" });
  });

  it("edge pins a NON-DEFAULT version with NO retained entry (torn) → refuse UNKNOWN_VERSION", async () => {
    const d = await resolveEdgeBoundObjectType(
      TYPE,
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(d).toMatchObject({ kind: "refuse", code: "UNKNOWN_VERSION" });
  });

  it("an identity refuse (dangling resolved edge) propagates as a refuse", async () => {
    const d = await resolveEdgeBoundObjectType(
      TYPE,
      makeDeps({
        dependentInstallId: DEP_ID,
        rows: {
          [DEP_ID]: row({
            id: DEP_ID,
            packageName: "@x/dependent",
            dependencyEdges: [edgeTo(TARGET, "install-gone")],
          }),
          // resolved row missing → EDGE_BOUND_RESOLVED_MISSING
        },
      }),
    );
    expect(d).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RESOLVED_MISSING" });
  });
});

describe("planEdgeBoundObjectTypeListing — DISCOVERY substitution (objects_types_list)", () => {
  it("no trusted identity → no substitutions (byte-identical default listing)", async () => {
    const listing = await planEdgeBoundObjectTypeListing(makeDeps({}));
    expect(listing.substitutions).toEqual([]);
  });

  it("versioned pin → substitution carrying that version's COMPLETE retained set", async () => {
    retainObjectTypeVersion(TARGET, V, [`${TARGET}:alpha`, `${TARGET}:beta`]);
    const listing = await planEdgeBoundObjectTypeListing(
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(listing.substitutions).toHaveLength(1);
    expect(listing.substitutions[0]).toMatchObject({ packageName: TARGET, version: V });
    expect(listing.substitutions[0].retainedTypes.map((d) => d.typeId)).toEqual([
      `${TARGET}:alpha`,
      `${TARGET}:beta`,
    ]);
  });

  it("drops retained object types NOT owned by the pinned package (no foreign/dynamic leak)", async () => {
    // The pinned version registers one OWNED type + one FOREIGN type + one
    // DYNAMIC id. Only the owned type may substitute; the foreign/dynamic ids
    // must NOT be appended (they would list without suppressing their real
    // owner's default — codex convergence).
    retainObjectTypeVersion(TARGET, V, [
      `${TARGET}:owned`,
      "@x/other:foreign",
      "@dynamic/types:auto",
    ]);
    const listing = await planEdgeBoundObjectTypeListing(
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(listing.substitutions).toHaveLength(1);
    expect(listing.substitutions[0].retainedTypes.map((d) => d.typeId)).toEqual([`${TARGET}:owned`]);
    expect(listing.notes.join(" ")).toMatch(/dropped 2 retained object type/);
  });

  it("a torn retained lookup keeps the default listing (no substitution) + records a note", async () => {
    // Edge pins TARGET@V but nothing was retained for it → torn.
    const listing = await planEdgeBoundObjectTypeListing(
      makeDeps({
        dependentInstallId: DEP_ID,
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
    expect(listing.substitutions).toEqual([]);
    expect(listing.notes.join(" ")).toMatch(/UNKNOWN_VERSION/);
  });

  it("an identity refuse keeps the default listing + records a note (writes will refuse)", async () => {
    const listing = await planEdgeBoundObjectTypeListing(
      makeDeps({ verifiedRunId: "run-gone" }), // no run row → EDGE_BOUND_RUN_MISSING
    );
    expect(listing.substitutions).toEqual([]);
    expect(listing.notes.join(" ")).toMatch(/identity refuse/);
  });
});

describe("object-type serve port — globalThis publish", () => {
  it("is published on the globalThis singleton and delegates the two serve methods", async () => {
    const port = getPublishedObjectTypeServePort();
    expect(port).toBeDefined();
    expect(typeof port!.resolveObjectType).toBe("function");
    expect(typeof port!.planListing).toBe("function");
    // With no ambient trusted identity (no ALS frame in the test env), the port's
    // live-deps resolution is compatibility-preserving: a POINT resolve of an
    // un-namespaced type is `none`, and the listing carries no substitutions.
    await expect(port!.resolveObjectType("plain-type")).resolves.toEqual({ kind: "none" });
    await expect(port!.planListing()).resolves.toMatchObject({ substitutions: [] });
  });
});
