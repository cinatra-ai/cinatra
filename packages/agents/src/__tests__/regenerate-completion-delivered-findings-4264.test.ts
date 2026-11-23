import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// cinatra#4264: the completer of a Regenerate reports applied only the
// findings whose words the segment run was given. A picture's Regenerate
// records two review fields, the Note and the picture's prompt; the picture
// step declares its prompt, so only the prompt's words reach the run. A note
// with other words reached no input of the run and is reported skipped, never
// applied. An ordinary repair run is handed every finding and keeps every
// finding applied.
//
// The database is a small fake that answers by TABLE (no database, no run, no
// queue), as in lifecycle-repair-producer-completion-fix1-3862.test.ts. The
// segment claim is a spy, and both claims answer the run's one write on the
// reviewed artifact itself (no re-file).

const dialect = new PgDialect();
type Row = Record<string, unknown>;
let tables: { lifecycleRepair: unknown; agentRuns: unknown; artifactProducedOutbox: unknown };

const ports = {
  readRepair: vi.fn(),
  submitRepairResponse: vi.fn(),
  readDeliveredRepairRequest: vi.fn(),
  resolveOrgRoleForUser: vi.fn(),
  claimSegmentProduction: vi.fn(),
};

const MOCKED = [
  "server-only",
  "../db",
  "../lifecycle-repair-store",
  "../lifecycle-repair-dispatch-store",
  "../regenerate-segment",
  "@/lib/auth-session",
  "@/lib/artifacts/artifact-revision-append",
] as const;

const RUN = "lifecycle-repair-run-repair-1";
const NOTE = "Make the sky brighter";
const PROMPT = "A lighthouse at dusk, wide angle";

function answer(table: unknown, where: unknown): Row[] {
  const params = where ? dialect.sqlToQuery(where as Parameters<PgDialect["sqlToQuery"]>[0]).params : [];
  if (table === tables.lifecycleRepair) {
    return params.includes("repair-1") ? [] : [{ id: "repair-1", createdAt: "2026-11-01 10:00:00+00" }];
  }
  if (table === tables.agentRuns) return [{ status: "completed" }];
  // an ordinary repair run's latest write, on the reviewed artifact itself
  if (table === tables.artifactProducedOutbox) return [{ artifactId: "art-base", representationRevisionId: "rev-run" }];
  // the base artifact's liveness and pointer
  return [{ deletedAt: null, pointer: "rev-base" }];
}

function repairRow(findings: Row[], regenerateNodeId: string | null) {
  return {
    id: "repair-1", orgId: "org-1", gateId: "gate-1", lineageId: "lineage-1", attempt: 1,
    route: "producer_repair", status: "dispatched", regenerateNodeId,
    baseArtifactId: "art-base", baseRepresentationRevisionId: "rev-base", expectedBaseRevisionId: "rev-base",
    findings,
    successorGateId: null, successorArtifactId: null, successorRepresentationRevisionId: null,
    findingOutcomes: null, changeSummary: null,
  };
}

beforeEach(async () => {
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
          limit: async () => answer(table, where),
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
    repairRunId: () => RUN,
    readDeliveredRepairRequest: ports.readDeliveredRepairRequest,
  }));
  vi.doMock("../regenerate-segment", async () => ({
    ...(await vi.importActual<typeof import("../regenerate-segment")>("../regenerate-segment")),
    claimSegmentProduction: ports.claimSegmentProduction,
  }));
  vi.doMock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: ports.resolveOrgRoleForUser }));
  vi.doMock("@/lib/artifacts/artifact-revision-append", () => ({
    refileRevisionOntoArtifact: vi.fn(() => { throw new Error("Unexpected re-file"); }),
    advanceArtifactPointerOntoRevision: vi.fn(),
    SemanticArtifactRevisionAppendRefusal: class extends Error {},
  }));
  ports.readDeliveredRepairRequest.mockResolvedValue({ originatingRunBy: "user-1" });
  ports.resolveOrgRoleForUser.mockResolvedValue("member");
  ports.claimSegmentProduction.mockResolvedValue({ artifactId: "art-base", representationRevisionId: "rev-run" });
  ports.submitRepairResponse.mockResolvedValue({ ok: true, successorGateId: "gate-next", successorTaskId: "task-next" });
});

afterEach(() => {
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

async function completeOne() {
  const { completeDispatchedProducerRepairs } = await import("../lifecycle-repair-producer-completion-store");
  const summary = await completeDispatchedProducerRepairs();
  expect(summary.completed).toBe(1);
  const call = ports.submitRepairResponse.mock.calls[0][0] as {
    response: { findingOutcomes: Array<{ findingId: string; applied: boolean; skipReason?: string }>; changeSummary: string };
  };
  return call.response;
}

describe("the completer reports applied only the findings a Regenerate delivered", () => {
  // red-first-expect: expected [ { …(2) }, { …(2) } ] to deeply equal [ { …(3) }, { …(2) } ]
  it("a picture's Regenerate whose note differs from its prompt: the prompt is applied, the note is skipped", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: PROMPT }], "file_image"),
    );
    const response = await completeOne();
    expect(response.findingOutcomes).toEqual([
      { findingId: "prompt-window", applied: false, skipReason: expect.any(String) },
      { findingId: "picture-prompt", applied: true },
    ]);
    expect(response.changeSummary).toContain("answered 1 requested change(s)");
  });

  it("a picture's Regenerate whose note is the prompt's words: both are applied", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "prompt-window", message: PROMPT }, { id: "picture-prompt", message: PROMPT }], "file_image"),
    );
    const response = await completeOne();
    expect(response.findingOutcomes).toEqual([
      { findingId: "prompt-window", applied: true },
      { findingId: "picture-prompt", applied: true },
    ]);
  });

  it("an ordinary repair run is handed every finding, so every finding stays applied", async () => {
    ports.readRepair.mockResolvedValue(
      repairRow([{ id: "finding-1", message: NOTE }, { id: "finding-2", message: PROMPT }], null),
    );
    const response = await completeOne();
    expect(ports.claimSegmentProduction).not.toHaveBeenCalled();
    expect(response.findingOutcomes).toEqual([
      { findingId: "finding-1", applied: true },
      { findingId: "finding-2", applied: true },
    ]);
    expect(response.changeSummary).toContain("answered 2 requested change(s)");
  });
});
