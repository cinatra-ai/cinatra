import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// cinatra#3862 leg 1, the review findings on the generic repair completer:
// the base read compares the artifact's CURRENT pointer, the pointer moves only
// behind an accepted successor, and the candidate window rotates so rows the
// drain cannot finish never hide the ones behind them.
//
// The database is a small fake that answers by TABLE and by the rendered
// query's parameters (no database, no run, no queue). The ports are spies, as
// in lifecycle-repair-producer-completion-3862.test.ts. Each case imports the
// completer inside the case and the mocks are removed after it.

const dialect = new PgDialect();

type Row = Record<string, unknown>;
interface FakeDb {
  candidates: Array<{ id: string; createdAt: string }>;
  runStatus: Record<string, string>;
  production: Record<string, Row>;
  pointer: string | null;
}

const fake: FakeDb = { candidates: [], runStatus: {}, production: {}, pointer: null };
let tables: { lifecycleRepair: unknown; agentRuns: unknown; artifactProducedOutbox: unknown };

const ports = {
  readRepair: vi.fn(),
  submitRepairResponse: vi.fn(),
  readDeliveredRepairRequest: vi.fn(),
  resolveCmsRepairBaseTarget: vi.fn(),
  resolveOrgRoleForUser: vi.fn(),
  refileRevisionOntoArtifact: vi.fn(),
  advanceArtifactPointerOntoRevision: vi.fn(),
};

class FakeRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MOCKED = [
  "server-only",
  "../db",
  "../lifecycle-repair-store",
  "../lifecycle-repair-dispatch-store",
  "../lifecycle-repair-cms-production-bridge",
  "@/lib/auth-session",
  "@/lib/artifacts/artifact-revision-append",
] as const;

function params(where: unknown): unknown[] {
  return where ? dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]).params : [];
}
function text(where: unknown): string {
  return where ? dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]).sql : "";
}

function answer(table: unknown, where: unknown, n: number): Row[] {
  const p = params(where);
  if (table === tables.lifecycleRepair) {
    const all = fake.candidates;
    if (/not in/i.test(text(where))) return all.filter((c) => !p.includes(c.id)).slice(0, n);
    const at = all.findIndex((c) => p.includes(c.id));
    return (at >= 0 ? all.slice(at + 1) : all).slice(0, n);
  }
  if (table === tables.agentRuns) {
    const runId = p.find((v) => typeof v === "string" && v in fake.runStatus) as string | undefined;
    return runId ? [{ status: fake.runStatus[runId] }] : [];
  }
  if (table === tables.artifactProducedOutbox) {
    const runId = p.find((v) => typeof v === "string" && v in fake.production) as string | undefined;
    return runId ? [fake.production[runId]] : [];
  }
  // objects: the base artifact's liveness and pointer
  return [{ deletedAt: null, pointer: fake.pointer }];
}

function repairRow(id: string, base = "art-base", rev = "rev-base") {
  return {
    id, orgId: "org-1", gateId: `gate-${id}`, lineageId: `lineage-${id}`, attempt: 1,
    route: "producer_repair", status: "dispatched",
    baseArtifactId: base, baseRepresentationRevisionId: rev, expectedBaseRevisionId: rev,
    findings: [{ id: "finding-1", path: "title", message: "Use a shorter title", severity: "minor" }],
    successorGateId: null, successorArtifactId: null, successorRepresentationRevisionId: null,
    findingOutcomes: null, changeSummary: null,
  };
}

const runOf = (id: string) => `lifecycle-repair-run-${id}`;

beforeEach(async () => {
  fake.candidates = [];
  fake.runStatus = {};
  fake.production = {};
  fake.pointer = null;
  tables = await import("../schema");
  vi.doMock("server-only", () => ({}));
  vi.doMock("../db", () => ({
    db: {
      select: () => {
        let table: unknown;
        let where: unknown;
        const query = {
          from: (t: unknown) => { table = t; return query; },
          where: (w: unknown) => { where = w; return query; },
          orderBy: () => query,
          limit: async (n: number) => answer(table, where, n),
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
    repairRunId: runOf,
    readDeliveredRepairRequest: ports.readDeliveredRepairRequest,
  }));
  vi.doMock("../lifecycle-repair-cms-production-bridge", () => ({
    resolveCmsRepairBaseTarget: ports.resolveCmsRepairBaseTarget,
  }));
  vi.doMock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: ports.resolveOrgRoleForUser }));
  vi.doMock("@/lib/artifacts/artifact-revision-append", () => ({
    refileRevisionOntoArtifact: ports.refileRevisionOntoArtifact,
    advanceArtifactPointerOntoRevision: ports.advanceArtifactPointerOntoRevision,
    SemanticArtifactRevisionAppendRefusal: FakeRefusal,
  }));
  ports.resolveCmsRepairBaseTarget.mockResolvedValue(null);
  ports.readDeliveredRepairRequest.mockResolvedValue({ originatingRunBy: "user-1" });
  ports.resolveOrgRoleForUser.mockResolvedValue("member");
  ports.readRepair.mockImplementation(async (id: string) => repairRow(id));
  ports.refileRevisionOntoArtifact.mockReturnValue({ artifactId: "art-base", representationRevisionId: "rev-refiled" });
  ports.advanceArtifactPointerOntoRevision.mockReturnValue("advanced");
  ports.submitRepairResponse.mockResolvedValue({ ok: true, successorGateId: "gate-next", successorTaskId: "task-next" });
});

afterEach(() => {
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function oneFinishedRepair() {
  fake.candidates = [{ id: "repair-1", createdAt: "2026-10-01 10:00:00.000001+00" }];
  fake.runStatus[runOf("repair-1")] = "completed";
  fake.production[runOf("repair-1")] = { artifactId: "art-run", representationRevisionId: "rev-run" };
}

describe("cinatra#3862 leg 1, review findings on the generic repair completer", () => {
  it("(1) a base whose pointer moved after the review is submitted with the CURRENT pointer, so the store refuses it stale", async () => {
    oneFinishedRepair();
    fake.pointer = "rev-saved-later";
    ports.submitRepairResponse.mockResolvedValue({ ok: false, code: "stale-base", error: "moved" });

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(ports.submitRepairResponse).toHaveBeenCalledWith(
      expect.objectContaining({ repairId: "repair-1", currentBaseRevisionId: "rev-saved-later" }),
    );
    expect(summary.completed).toBe(0);
    expect(summary.unresolved).toBe(1);
    expect(ports.advanceArtifactPointerOntoRevision).not.toHaveBeenCalled();
  });

  it("(1) a pointer still on the reviewed revision is submitted as that revision", async () => {
    oneFinishedRepair();
    fake.pointer = "rev-base";

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    await completeDispatchedProducerRepairs();

    expect(ports.submitRepairResponse).toHaveBeenCalledWith(
      expect.objectContaining({ currentBaseRevisionId: "rev-base" }),
    );
  });

  it("(2) the re-file leaves the pointer alone and the pointer moves only after the submit is accepted, from the revision read", async () => {
    oneFinishedRepair();
    fake.pointer = "rev-base";

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary.completed).toBe(1);
    expect(ports.refileRevisionOntoArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ targetArtifactId: "art-base", advancePointer: false }),
    );
    expect(ports.advanceArtifactPointerOntoRevision).toHaveBeenCalledTimes(1);
    expect(ports.advanceArtifactPointerOntoRevision).toHaveBeenCalledWith({
      orgId: "org-1",
      artifactId: "art-base",
      fromRepresentationRevisionId: "rev-base",
      toRepresentationRevisionId: "rev-refiled",
    });
    const submitAt = ports.submitRepairResponse.mock.invocationCallOrder[0];
    const advanceAt = ports.advanceArtifactPointerOntoRevision.mock.invocationCallOrder[0];
    expect(advanceAt).toBeGreaterThan(submitAt);
  });

  it("(2) a refused submit leaves the pointer where it was", async () => {
    oneFinishedRepair();
    fake.pointer = "rev-base";
    ports.submitRepairResponse.mockResolvedValue({ ok: false, code: "successor-pin-conflict", error: "occupied" });

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary.unresolved).toBe(1);
    expect(ports.refileRevisionOntoArtifact).toHaveBeenCalledWith(expect.objectContaining({ advancePointer: false }));
    expect(ports.advanceArtifactPointerOntoRevision).not.toHaveBeenCalled();
  });

  it("(3) an answer the reviewed artifact's type does not accept is refused by the door and the repair stays open", async () => {
    oneFinishedRepair();
    fake.pointer = "rev-base";
    ports.refileRevisionOntoArtifact.mockImplementation(() => {
      throw new FakeRefusal("accepts-mismatch", "image/png is not accepted");
    });

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const summary = await completeDispatchedProducerRepairs();

    expect(summary).toMatchObject({ completed: 0, unresolved: 1, failed: 0 });
    expect(ports.submitRepairResponse).not.toHaveBeenCalled();
    expect(ports.advanceArtifactPointerOntoRevision).not.toHaveBeenCalled();
  });

  it("(4) a full window of repairs that cannot finish does not hide the completable repair behind it", async () => {
    // limit 1 => a window of 8; eight wedged repairs at the head, one finished behind them
    for (let i = 1; i <= 9; i += 1) {
      const id = `repair-${String(i).padStart(2, "0")}`;
      fake.candidates.push({ id, createdAt: `2026-10-01 10:00:0${i}.000001+00` });
      fake.runStatus[runOf(id)] = i <= 8 ? "pending_input" : "completed";
    }
    fake.production[runOf("repair-09")] = { artifactId: "art-run", representationRevisionId: "rev-run" };
    fake.pointer = "rev-base";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
    const first = await completeDispatchedProducerRepairs({ limit: 1 });
    const second = await completeDispatchedProducerRepairs({ limit: 1 });

    expect(first.completed + second.completed).toBe(1);
    expect(ports.submitRepairResponse).toHaveBeenCalledTimes(1);
    expect(ports.submitRepairResponse).toHaveBeenCalledWith(expect.objectContaining({ repairId: "repair-09" }));
  });
});
