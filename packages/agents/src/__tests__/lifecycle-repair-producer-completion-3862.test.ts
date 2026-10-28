import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3862 leg 1 — the generic repair completer, read with its ports
// replaced: the database is a queue of read results (each `db.select()` chain
// ending in `.limit()` takes the next one; an unexpected read throws), and the
// repair store, the dispatch store, the membership read and the revision door
// are spies. No database, no run, no queue.
//
// cinatra#3862 leg 7 (slice 2): the completer takes EVERY dispatched repair. The
// retired CMS bridge stays mocked here only as a witness: its ownership read is
// never asked, and in the second case the module refuses to load at all.
//
// The completer is imported INSIDE each case, so a module that does not exist
// fails the case rather than the file's collection. The mocks are registered
// per case (vi.doMock) and removed again after it (vi.doUnmock + resetModules),
// so nothing this file mocks leaks into another file of the package's run.

const ports = {
  reads: [] as unknown[][],
  readRepair: vi.fn(),
  submitRepairResponse: vi.fn(),
  readDeliveredRepairRequest: vi.fn(),
  resolveCmsRepairBaseTarget: vi.fn(),
  resolveOrgRoleForUser: vi.fn(),
  refileRevisionOntoArtifact: vi.fn(),
};

const MOCKED = [
  "server-only",
  "../db",
  "../lifecycle-repair-store",
  "../lifecycle-repair-dispatch-store",
  "../lifecycle-repair-cms-production-bridge",
  "@/lib/auth-session",
  "@/lib/artifacts/artifact-revision-append",
] as const;

function dispatchedRepair(baseArtifactId: string, baseRepresentationRevisionId: string) {
  return {
    id: "repair-1",
    orgId: "org-1",
    gateId: "gate-1",
    lineageId: "lineage-1",
    attempt: 1,
    route: "producer_repair",
    status: "dispatched",
    baseArtifactId,
    baseRepresentationRevisionId,
    expectedBaseRevisionId: baseRepresentationRevisionId,
    findings: [{ id: "finding-1", path: "title", message: "Use a shorter title", severity: "minor" }],
    successorGateId: null,
    successorArtifactId: null,
    successorRepresentationRevisionId: null,
    findingOutcomes: null,
    changeSummary: null,
  };
}

beforeEach(() => {
  ports.reads = [];
  vi.doMock("server-only", () => ({}));
  vi.doMock("../db", () => ({
    db: {
      select: () => {
        const query = {
          from: () => query, where: () => query, orderBy: () => query,
          limit: async () => {
            const result = ports.reads.shift();
            if (!result) throw new Error("Unexpected database read");
            return result;
          },
        };
        return query;
      },
    },
  }));
  vi.doMock("../lifecycle-repair-store", () => ({
    readRepair: ports.readRepair,
    submitRepairResponse: ports.submitRepairResponse,
  }));
  vi.doMock("../lifecycle-repair-dispatch-store", () => ({
    repairRunId: (id: string) => "lifecycle-repair-run-" + id,
    readDeliveredRepairRequest: ports.readDeliveredRepairRequest,
  }));
  vi.doMock("../lifecycle-repair-cms-production-bridge", () => ({
    resolveCmsRepairBaseTarget: ports.resolveCmsRepairBaseTarget,
  }));
  vi.doMock("@/lib/auth-session", () => ({
    resolveOrgRoleForUser: ports.resolveOrgRoleForUser,
  }));
  vi.doMock("@/lib/artifacts/artifact-revision-append", () => ({
    refileRevisionOntoArtifact: ports.refileRevisionOntoArtifact,
    advanceArtifactPointerOntoRevision: () => "advanced",
    SemanticArtifactRevisionAppendRefusal: class extends Error {},
  }));
});

afterEach(() => {
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cinatra#3862 leg 1 — the generic repair completer", () => {
  it("a finished repair run whose base is not a CMS snapshot is completed and its successor recorded on the reviewed artifact", async () => {
    ports.readRepair.mockResolvedValue(dispatchedRepair("art-base", "rev-base"));
    ports.resolveCmsRepairBaseTarget.mockResolvedValue(null);
    ports.reads = [
      [{ id: "repair-1" }],
      [{ status: "completed" }],
      [{ artifactId: "art-run", representationRevisionId: "rev-run" }],
      [{ deletedAt: null }],
    ];
    ports.readDeliveredRepairRequest.mockResolvedValue({ originatingRunBy: "user-1" });
    ports.resolveOrgRoleForUser.mockResolvedValue("member");
    ports.refileRevisionOntoArtifact.mockReturnValue({ artifactId: "art-base", representationRevisionId: "rev-refiled" });
    ports.submitRepairResponse.mockResolvedValue({ ok: true });

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary).toEqual({
      scanned: 1, completed: 1, pending: 0, unresolved: 0, failed: 0,
    });
    expect(ports.submitRepairResponse).toHaveBeenCalledTimes(1);
    expect(ports.submitRepairResponse).toHaveBeenCalledWith(expect.objectContaining({
      repairId: "repair-1",
      currentBaseRevisionId: "rev-base",
      reauthorized: true,
      response: expect.objectContaining({
        successorTarget: { artifactId: "art-base", representationRevisionId: "rev-refiled" },
      }),
    }));
    expect(ports.refileRevisionOntoArtifact).toHaveBeenCalledTimes(1);
    expect(ports.refileRevisionOntoArtifact).toHaveBeenCalledWith(expect.objectContaining({
      targetArtifactId: "art-base",
      sourceArtifactId: "art-run",
      sourceRepresentationRevisionId: "rev-run",
    }));
    expect(ports.reads).toHaveLength(0);
  });

  // The base below HAS a cms_snapshot_targets row (the bridge's resolver finds
  // one). Before leg 7 the completer skipped such a repair and left it to the
  // CMS bridge; now the generic completer finishes it like any other repair.
  function finishedRunOnBase(base: string, rev: string) {
    ports.readRepair.mockResolvedValue(dispatchedRepair(base, rev));
    ports.reads = [
      [{ id: "repair-1" }],
      [{ status: "completed" }],
      [{ artifactId: "art-run", representationRevisionId: "rev-run" }],
      [{ deletedAt: null }],
    ];
    ports.readDeliveredRepairRequest.mockResolvedValue({ originatingRunBy: "user-1" });
    ports.resolveOrgRoleForUser.mockResolvedValue("member");
    ports.refileRevisionOntoArtifact.mockReturnValue({ artifactId: base, representationRevisionId: "rev-refiled" });
    ports.submitRepairResponse.mockResolvedValue({ ok: true });
  }

  it("a repair whose base is a captured CMS snapshot is completed by the generic completer, not left to the bridge", async () => {
    finishedRunOnBase("art-cms", "rev-cms");
    ports.resolveCmsRepairBaseTarget.mockResolvedValue({
      artifactId: "art-cms", snapshotRevisionId: "rev-cms", connectorInstance: "cms-1",
      resourceType: "page", resourceId: "page-1", scopeManifest: { paths: ["title"] },
    });

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary).toEqual({ scanned: 1, completed: 1, pending: 0, unresolved: 0, failed: 0 });
    expect(ports.resolveCmsRepairBaseTarget).not.toHaveBeenCalled();
    expect(ports.submitRepairResponse).toHaveBeenCalledTimes(1);
    expect(ports.submitRepairResponse).toHaveBeenCalledWith(expect.objectContaining({
      repairId: "repair-1",
      response: expect.objectContaining({
        baseTarget: { artifactId: "art-cms", representationRevisionId: "rev-cms" },
        successorTarget: { artifactId: "art-cms", representationRevisionId: "rev-refiled" },
      }),
    }));
    expect(ports.reads).toHaveLength(0);
  });

  it("the completer never loads the CMS bridge: a bridge that cannot load changes nothing", async () => {
    finishedRunOnBase("art-cms", "rev-cms");
    vi.doMock("../lifecycle-repair-cms-production-bridge", () => {
      throw new Error("the generic completer must not load the CMS bridge");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary).toEqual({ scanned: 1, completed: 1, pending: 0, unresolved: 0, failed: 0 });
    expect(ports.submitRepairResponse).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(ports.reads).toHaveLength(0);
  });
});
