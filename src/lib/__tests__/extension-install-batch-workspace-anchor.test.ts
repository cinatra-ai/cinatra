// THE EXECUTOR HOP of the write path (cinatra#2694 / S2 #2696).
//
// Before this slice the batch executor derived row ownership solely from the
// actor's organization and DISCARDED each planned member's `rowOwnership` — the
// ledger recorded the tuple and nothing honored it. Here the field is LIVE:
//
//   1. every member is installed AT ITS OWN planned anchor (the dispatcher
//      receives the tuple, not the actor's org);
//   2. the durable creation-provenance capture, the pre-state read and the
//      install-op journal read all address the member's own scope — an org-NULL
//      workspace row is invisible to an org-scoped read, so a batch that got
//      this wrong could not compensate what it created;
//   3. compensation of a failed batch tears down exactly the rows it created,
//      at each member's own scope — mixed anchors included — and never a
//      pre-existing live row;
//   4. boot recovery reads the member's recorded anchor for the same reason;
//   5. WITHOUT a threaded tuple everything resolves to the batch's org, so
//      organization-target installs are byte-identical to before.
import { describe, expect, it, vi } from "vitest";

import {
  installExtensionWithDependencies,
  sweepStaleInstallBatches,
  BatchMemberInstallError,
  type InstallBatchSagaDeps,
} from "@/lib/extension-install-batch";
import type { InstallBatch, InstallBatchMember } from "@/lib/extension-install-batch-ops";
import type { DependencyInstallPlan, PlannedMember, RowOwnership } from "@/lib/extension-dependency-plan";
import { defaultRowOwnership } from "@/lib/extension-dependency-plan";
import { WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "@cinatra-ai/extensions/install-access-target";
import type { Actor } from "@cinatra-ai/extension-types";

const ORG = "org-1";
const actor: Actor = { actorType: "human", source: "ui", userId: "u1", orgId: ORG };
const ROOT = "@cinatra-ai/ws-root";
const ART_DEP = "@cinatra-ai/ws-artifact-dep";
const AGENT_DEP = "@cinatra-ai/ws-agent-dep";

const WORKSPACE: RowOwnership = { ...WORKSPACE_ANCHOR_ROW_OWNERSHIP };
const ORG_ANCHOR: RowOwnership = defaultRowOwnership(ORG);

function member(packageName: string, over: Partial<PlannedMember> = {}): PlannedMember {
  return {
    packageName,
    version: "1.0.0",
    typeId: "artifact",
    edges: [],
    alreadyInstalled: false,
    rowOwnership: ORG_ANCHOR,
    action: "install",
    ...over,
  };
}

/**
 * A SCOPE-AWARE harness: the in-memory canonical store keys rows by
 * (package, scope), and `installMember` creates the row at the scope the saga
 * addressed for that member. A saga that addressed the wrong scope therefore
 * fails these tests for the right reason (the provenance/compensation reads and
 * the row it created disagree), not by assertion bookkeeping.
 */
function makeHarness(opts: {
  plan: PlannedMember[];
  installFail?: string;
  /** Rows that existed BEFORE the batch: [packageName, scope]. */
  preExisting?: [string, string | null][];
}) {
  const events: string[] = [];
  const installedWith: { packageName: string; rowOwnership?: RowOwnership }[] = [];
  const provenanceScopes: { packageName: string; scope: string | null }[] = [];
  const preStateScopes: { packageName: string; scope: string | null }[] = [];
  const compensationTargets: { packageName: string; scopeOrgId: string | null; createdRowIds: string[] | null }[] =
    [];
  const ledgerRows = new Map<string, InstallBatch>();
  const canonicalRows = new Map<string, string[]>();
  let rowSeq = 0;
  const key = (pkg: string, scope: string | null): string => `${pkg}::${scope ?? "(platform)"}`;
  const createRow = (pkg: string, scope: string | null): string => {
    const id = `iext_${pkg.replace(/[^a-z0-9]/gi, "")}_${++rowSeq}`;
    canonicalRows.set(key(pkg, scope), [...(canonicalRows.get(key(pkg, scope)) ?? []), id]);
    return id;
  };
  const preExistingIds: string[] = [];
  for (const [pkg, scope] of opts.preExisting ?? []) preExistingIds.push(createRow(pkg, scope));

  const deps: InstallBatchSagaDeps = {
    isGatekeptInstallEnabled: () => false,
    getActiveGrantContext: () => null,
    authorizeRoot: vi.fn(),
    refreshGrant: vi.fn(),
    withGrantContext: async (_c, fn) => fn(),
    withGlobalLifecycleLock: async (fn) => fn(),
    withSagaOwnedFanout: async (_r, fn) => fn(),
    triggerAgentRuntimeReload: vi.fn(async () => ({ ok: true as const })),
    plan: async (input): Promise<DependencyInstallPlan> => {
      events.push(`plan:rootAnchor=${input.rowOwnership?.organizationId ?? "(platform)"}`);
      return {
        ordered: opts.plan,
        root: { packageName: ROOT, version: "1.0.0" },
        source: "manifest-walk",
        memberKinds: new Map(),
      };
    },
    installMember: vi.fn(async (m) => {
      installedWith.push({ packageName: m.packageName, rowOwnership: m.rowOwnership });
      if (opts.installFail === m.packageName) {
        events.push(`install-FAIL:${m.packageName}`);
        throw new Error(`gate refused ${m.packageName}`);
      }
      // The dispatcher writes the row AT THE THREADED ANCHOR (cinatra#2696).
      const scope = m.rowOwnership ? (m.rowOwnership.organizationId ?? null) : ORG;
      if ((canonicalRows.get(key(m.packageName, scope)) ?? []).length === 0) {
        createRow(m.packageName, scope);
      }
      events.push(`install:${m.packageName}@scope=${scope ?? "(platform)"}`);
    }),
    updateMemberPackage: vi.fn(async () => undefined),
    isMemberProtected: vi.fn(async () => false),
    uninstallMemberRowScoped: vi.fn(async (m) => {
      compensationTargets.push({
        packageName: m.packageName,
        scopeOrgId: m.scopeOrgId ?? null,
        createdRowIds: m.createdRowIds ?? null,
      });
      if (m.createdRowIds == null) throw new Error("no durable provenance (harness)");
      const k = key(m.packageName, m.scopeOrgId ?? null);
      canonicalRows.set(
        k,
        (canonicalRows.get(k) ?? []).filter((id) => !m.createdRowIds!.includes(id)),
      );
      events.push(`compensate:${m.packageName}@scope=${m.scopeOrgId ?? "(platform)"}`);
    }),
    listScopedRowIds: vi.fn(async (packageName: string, scope: string | null) => {
      provenanceScopes.push({ packageName, scope });
      return [...(canonicalRows.get(key(packageName, scope)) ?? [])];
    }),
    withPackageInstallLock: async (_p, fn) => fn(),
    installMemberSideBySide: vi.fn(),
    uninstallSideBySideMember: vi.fn(),
    readInstallOpForVersion: async () => null,
    readLiveRowVersion: vi.fn(async (pkg: string, scope: string | null) => {
      preStateScopes.push({ packageName: pkg, scope });
      const rows = canonicalRows.get(key(pkg, scope)) ?? [];
      return rows.length > 0 ? { present: true, version: "0.9.0" } : { present: false };
    }),
    readInstallOp: async (pkg: string, scope: string | null) => ({
      installOpId: `${pkg}@${scope ?? "(platform)"}@op`,
      phase: "finalized",
    }),
    ledger: {
      begin: async (i) => {
        const b: InstallBatch = {
          batchId: i.batchId,
          rootPackage: i.rootPackage,
          orgId: i.orgId,
          phase: "planning",
          members: i.members,
          createdAt: "now",
          updatedAt: "now",
        };
        ledgerRows.set(i.batchId, b);
        return b;
      },
      setPhase: async (id, phase) => {
        const b = ledgerRows.get(id)!;
        b.phase = phase;
        events.push(`ledger:phase:${phase}`);
        return b;
      },
      updateMember: async (id, pkg, patch) => {
        const b = ledgerRows.get(id)!;
        b.members = b.members.map((m) => (m.packageName === pkg ? { ...m, ...patch } : m));
        return b;
      },
      listActive: async () => [],
    },
    now: () => Date.now(),
  };

  return {
    deps,
    events,
    installedWith,
    provenanceScopes,
    preStateScopes,
    compensationTargets,
    ledgerRows,
    preExistingIds,
    rowsAt: (pkg: string, scope: string | null) => [...(canonicalRows.get(key(pkg, scope)) ?? [])],
    allRowIds: () => [...canonicalRows.values()].flat(),
  };
}

/** The MIXED closure: workspace root + workspace non-agent dep + org-anchored agent dep. */
const MIXED_PLAN = (): PlannedMember[] => [
  member(ART_DEP, { rowOwnership: WORKSPACE }),
  member(AGENT_DEP, { typeId: "agent", rowOwnership: ORG_ANCHOR }),
  member(ROOT, { rowOwnership: WORKSPACE }),
];

describe("cinatra#2696 — the executor consumes the planned per-member rowOwnership", () => {
  it("threads each member's anchor into the dispatcher (mixed closure)", async () => {
    const h = makeHarness({ plan: MIXED_PLAN() });

    await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
      h.deps,
    );

    expect(h.events[0]).toBe("plan:rootAnchor=(platform)");
    expect(h.installedWith).toEqual([
      { packageName: ART_DEP, rowOwnership: WORKSPACE },
      { packageName: AGENT_DEP, rowOwnership: ORG_ANCHOR },
      { packageName: ROOT, rowOwnership: WORKSPACE },
    ]);
    // The rows landed at the members' own anchors.
    expect(h.rowsAt(ROOT, null)).toHaveLength(1);
    expect(h.rowsAt(ART_DEP, null)).toHaveLength(1);
    expect(h.rowsAt(AGENT_DEP, ORG)).toHaveLength(1);
    expect(h.rowsAt(ROOT, ORG)).toHaveLength(0);
  });

  it("the pre-state + provenance reads address each member's OWN scope", async () => {
    const h = makeHarness({ plan: MIXED_PLAN() });

    await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
      h.deps,
    );

    expect(h.preStateScopes).toEqual([
      { packageName: ART_DEP, scope: null },
      { packageName: AGENT_DEP, scope: ORG },
      { packageName: ROOT, scope: null },
    ]);
    for (const probe of h.provenanceScopes) {
      expect(probe.scope, probe.packageName).toBe(probe.packageName === AGENT_DEP ? ORG : null);
    }
  });

  it("the LEDGER records each member's own anchor (the field is live, not decorative)", async () => {
    const h = makeHarness({ plan: MIXED_PLAN() });

    await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
      h.deps,
    );

    const batch = [...h.ledgerRows.values()][0]!;
    const byName = new Map(batch.members.map((m) => [m.packageName, m]));
    expect(byName.get(ROOT)!.rowOwnership).toEqual(WORKSPACE);
    expect(byName.get(ART_DEP)!.rowOwnership).toEqual(WORKSPACE);
    expect(byName.get(AGENT_DEP)!.rowOwnership).toEqual(ORG_ANCHOR);
    // The batch itself stays stamped with the ACTOR's org (its own identity).
    expect(batch.orgId).toBe(ORG);
  });

  it("ROOT-ONLY fast path: a depless workspace root is still installed at the workspace anchor", async () => {
    const h = makeHarness({ plan: [member(ROOT, { rowOwnership: WORKSPACE })] });

    const res = await installExtensionWithDependencies(
      { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
      h.deps,
    );

    expect(res.batchId).toBeNull(); // no ledger row on the fast path
    expect(h.installedWith).toEqual([{ packageName: ROOT, rowOwnership: WORKSPACE }]);
    expect(h.rowsAt(ROOT, null)).toHaveLength(1);
  });
});

describe("cinatra#2696 — rollback of a failed workspace-target install", () => {
  it("leaves NO rows behind, compensating each member at its OWN anchor", async () => {
    const h = makeHarness({ plan: MIXED_PLAN(), installFail: ROOT });

    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    // Compensation ran in INVERSE order, each at the member's own scope.
    expect(h.compensationTargets.map((t) => [t.packageName, t.scopeOrgId])).toEqual([
      [AGENT_DEP, ORG],
      [ART_DEP, null],
    ]);
    // Zero rows survive from this batch.
    expect(h.allRowIds()).toEqual([]);
    expect(h.events).toContain("ledger:phase:compensated");
  });

  it("a PRE-EXISTING live row is never destroyed — at either anchor", async () => {
    // The artifact dep already exists at the WORKSPACE anchor; the agent dep
    // already exists in the org. Both pre-date the batch, so neither may be
    // torn down when the root fails.
    const h = makeHarness({
      plan: MIXED_PLAN(),
      installFail: ROOT,
      preExisting: [
        [ART_DEP, null],
        [AGENT_DEP, ORG],
      ],
    });
    const survivors = [...h.preExistingIds];

    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    // Both pre-existing rows are still there; nothing else is.
    expect(h.allRowIds().sort()).toEqual(survivors.sort());
    expect(h.rowsAt(ROOT, null)).toEqual([]);
  });

  it("a MID-CLOSURE failure compensates the earlier members at their own anchors", async () => {
    const h = makeHarness({ plan: MIXED_PLAN(), installFail: AGENT_DEP });

    await expect(
      installExtensionWithDependencies(
        { packageName: ROOT, version: "1.0.0", actor, rowOwnership: WORKSPACE },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    // Only ART_DEP had been installed; it is torn down at the WORKSPACE anchor
    // (the batch org would not have matched its row).
    expect(h.compensationTargets.map((t) => [t.packageName, t.scopeOrgId])).toEqual([[ART_DEP, null]]);
    expect(h.allRowIds()).toEqual([]);
  });
});

describe("cinatra#2696 — organization-target regression (byte-identical)", () => {
  it("with NO threaded tuple every scope is the batch org, as before", async () => {
    const plan = [member(ART_DEP), member(AGENT_DEP, { typeId: "agent" }), member(ROOT)];
    const h = makeHarness({ plan });

    await installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps);

    expect(h.events[0]).toBe(`plan:rootAnchor=${ORG}`);
    for (const probe of [...h.preStateScopes, ...h.provenanceScopes]) {
      expect(probe.scope, probe.packageName).toBe(ORG);
    }
    expect(h.rowsAt(ROOT, ORG)).toHaveLength(1);
    expect(h.rowsAt(ROOT, null)).toHaveLength(0);
  });

  it("with NO threaded tuple a failed batch compensates at the batch org, as before", async () => {
    const plan = [member(ART_DEP), member(ROOT)];
    const h = makeHarness({ plan, installFail: ROOT });

    await expect(
      installExtensionWithDependencies({ packageName: ROOT, version: "1.0.0", actor }, h.deps),
    ).rejects.toBeInstanceOf(BatchMemberInstallError);

    expect(h.compensationTargets).toEqual([
      { packageName: ART_DEP, scopeOrgId: ORG, createdRowIds: expect.any(Array) },
    ]);
    expect(h.allRowIds()).toEqual([]);
  });
});

describe("cinatra#2696 — boot recovery reads the member's recorded anchor", () => {
  function staleBatch(members: InstallBatchMember[]): InstallBatch {
    return {
      batchId: "batch-stale",
      rootPackage: ROOT,
      orgId: ORG,
      phase: "installing",
      members,
      createdAt: "then",
      updatedAt: "then",
    };
  }

  it("sweeps a workspace-anchored member at its org-NULL scope, not the batch org", async () => {
    const uninstallMemberRowScoped = vi.fn(
      async (_m: { packageName: string; scopeOrgId: string | null; createdRowIds?: string[] | null }) =>
        undefined,
    );
    await sweepStaleInstallBatches(undefined, {
      listStale: async () => [
        staleBatch([
          {
            packageName: ROOT,
            version: "1.0.0",
            typeId: "artifact",
            status: "installed",
            action: "install",
            rowOwnership: WORKSPACE,
            createdRowIds: ["iext_ws_1"],
            preState: { present: false },
          } as InstallBatchMember,
        ]),
      ],
      setPhase: vi.fn(async () => ({}) as InstallBatch),
      updateMember: vi.fn(async () => ({}) as InstallBatch),
      isMemberProtected: async () => false,
      uninstallMemberRowScoped,
    });

    expect(uninstallMemberRowScoped).toHaveBeenCalledTimes(1);
    expect(uninstallMemberRowScoped.mock.calls[0]![0]).toMatchObject({
      packageName: ROOT,
      scopeOrgId: null,
      createdRowIds: ["iext_ws_1"],
    });
  });

  it("REGRESSION: a member with no recorded anchor still sweeps at the batch org", async () => {
    const uninstallMemberRowScoped = vi.fn(
      async (_m: { packageName: string; scopeOrgId: string | null; createdRowIds?: string[] | null }) =>
        undefined,
    );
    await sweepStaleInstallBatches(undefined, {
      listStale: async () => [
        staleBatch([
          {
            packageName: ROOT,
            version: "1.0.0",
            typeId: "artifact",
            status: "installed",
            action: "install",
            createdRowIds: ["iext_org_1"],
            preState: { present: false },
          } as InstallBatchMember,
        ]),
      ],
      setPhase: vi.fn(async () => ({}) as InstallBatch),
      updateMember: vi.fn(async () => ({}) as InstallBatch),
      isMemberProtected: async () => false,
      uninstallMemberRowScoped,
    });

    expect(uninstallMemberRowScoped.mock.calls[0]![0]).toMatchObject({ scopeOrgId: ORG });
  });
});
