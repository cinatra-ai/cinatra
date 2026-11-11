import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3080, acceptance item 4 and the 2026-10-13 decision: "On a review
// whose producing step declares no such input, Regenerate is refused with a
// plain reason, and Comment and Continue work as usual."
//
// The test is the producing STEP's declared Note input, never the agent-level
// `repairCapable` flag. This file drives the real composer and the real
// canonical operation with their ports replaced: the database is a queue of
// read results (each `db.select()` chain ending in `.limit()` takes the next
// one; a chain awaited without `.limit()` reads as no rows), and
// `db.transaction` is a spy, so "nothing was written" is a fact the test can
// read. The declaration read is NOT replaced: its real answer is what is pinned.

const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
  transaction: vi.fn(async () => {
    throw new Error("the transaction was opened");
  }),
  // Any write outside a transaction (an insert or an update straight on the
  // database) lands here, so "nothing was written" covers that road too.
  write: vi.fn(() => {
    throw new Error("a write was attempted");
  }),
  readReviewGate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  db: {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          const result = ports.reads.shift();
          if (!result) throw new Error("Unexpected database read");
          return result;
        },
        then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
          Promise.resolve([] as unknown[]).then(resolve, reject),
      };
      return query;
    },
    transaction: ports.transaction,
    insert: ports.write,
    update: ports.write,
  },
}));
vi.mock("../artifact-review-gate-store", () => ({
  readReviewGate: ports.readReviewGate,
  emitArtifactReviewGate: vi.fn(),
  ArtifactReviewGateError: class extends Error {},
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  readProducedEvent: vi.fn(async () => null),
}));
vi.mock("../run-wait-notifier", () => ({
  dispatchAutoGateOpen: vi.fn(async () => {}),
  dispatchAutoGateResolved: vi.fn(async () => {}),
}));

const RUN = "run-3080-mf2";
const BASE = { artifactId: "art-3080-mf2", representationRevisionId: "rev-3080-mf2" };
const TASK = "lifecycle-review:3080-mf2";

beforeEach(() => {
  ports.transaction.mockClear();
  ports.write.mockClear();
  ports.readReviewGate.mockReset();
  ports.readReviewGate.mockResolvedValue({
    id: "gate-3080-mf2",
    runId: RUN,
    orgId: "org-3080-mf2",
    reviewTaskId: TASK,
    status: "pending",
    pinnedTargets: [BASE],
  });
  // The reads in order: the producing run's template, that template's compiled
  // lifecycle block (the agent DOES declare `repairCapable: true`), the
  // canonical operation's existing-repair lookup (none), and the gate's own
  // state as the canonical operation reads it (still pending).
  ports.reads = [
    [{ templateId: "tmpl-3080-mf2" }],
    [{ lifecycleConfig: JSON.stringify({ repairCapable: true }) }],
    [],
    [{ status: "pending" }],
  ];
});

/** The reads of a gate whose decision a Continue (or any other) already made:
 *  the gate read the composer makes and the gate state the canonical operation
 *  reads both say RESOLVED. */
function gateAlreadyResolved() {
  ports.readReviewGate.mockResolvedValue({
    id: "gate-3080-mf2",
    runId: RUN,
    orgId: "org-3080-mf2",
    reviewTaskId: TASK,
    status: "resolved",
    pinnedTargets: [BASE],
  });
  ports.reads[3] = [{ status: "resolved" }];
}

async function press(origin?: "typed" | "regenerate", reviewTaskId: string = TASK) {
  const { recordReviewSurfaceChangesRequested } = await import(
    "../lifecycle-review-changes-requested-store"
  );
  return recordReviewSurfaceChangesRequested({
    runId: RUN,
    reviewTaskId,
    baseTarget: BASE,
    currentBaseRevisionId: BASE.representationRevisionId,
    feedback: "make the sky bluer",
    decidedBy: "user-3080-mf2",
    ...(origin ? { origin } : {}),
  });
}

describe("cinatra#3080 — Regenerate needs the producing step's declared Note input", () => {
  it("REFUSES a repair-capable agent whose producing step declares no Note input, with the plain reason, and writes nothing", async () => {
    const result = await press("regenerate");

    // Refused before the transaction: the gate is not settled, no repair opens.
    // (The `repairCapable` proxy let this press through to the write.)
    expect(ports.transaction).not.toHaveBeenCalled();
    const { REGENERATE_NO_NOTE_INPUT } = await import("@/lib/artifacts/review-surface-model");
    expect(typeof REGENERATE_NO_NOTE_INPUT).toBe("string");
    expect(result).toEqual({
      ok: false,
      code: "regenerate-unavailable",
      error: REGENERATE_NO_NOTE_INPUT,
    });
  });

  it("the real declaration read finds none: the contract has no field that could hold one", async () => {
    const { readProducingStepNoteInput } = await import("../lifecycle-repair-producer-registry");
    expect(await readProducingStepNoteInput(RUN)).toBeNull();
    expect(await readProducingStepNoteInput(null)).toBeNull();
  });

  it("the TYPED road on the same agent is unchanged: it still goes on to record the change request", async () => {
    // The typed road makes no gate-state read of its own. After the existing-
    // repair lookup the canonical operation derives the lineage from the decided
    // gate's own row (cinatra#4312, `deriveDecidedGateLineage`): this gate's
    // task id starts a fresh lineage.
    ports.reads[3] = [{ id: "gate-3080-mf2", runId: RUN, reviewTaskId: TASK, orgId: "org-3080-mf2" }];
    await press();
    // It reaches the write, exactly as before: the narrowing is Regenerate's only.
    expect(ports.transaction).toHaveBeenCalledTimes(1);
    expect(ports.reads).toEqual([]);
  });
});

// cinatra#3080. The refusal above must not answer for a gate
// that is no longer pending. A Regenerate that lands after a Continue meets a
// gate whose decision is already made: the first decision stands, and the
// answer is the BLOCKED one (`gate-not-pending`), never the retryable
// "Regenerate is not available" refusal. The declaration read is the REAL one
// (it finds none), and no test-owned declaration stands in for it.
describe("cinatra#3080 — a Regenerate on a RESOLVED gate is blocked, not refused", () => {
  it("answers gate-not-pending on a gate a Continue already resolved, with the real declaration read, and writes nothing", async () => {
    gateAlreadyResolved();
    const { readProducingStepNoteInput } = await import("../lifecycle-repair-producer-registry");
    expect(await readProducingStepNoteInput(RUN)).toBeNull();

    const result = await press("regenerate");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("gate-not-pending");
    expect(ports.transaction).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
  });

  it("the surface reads that answer as BLOCKED (no longer pending), not as a retryable error", async () => {
    gateAlreadyResolved();
    const result = await press("regenerate");
    const { mapChangesRequestedToOutcome } = await import("@/lib/artifacts/review-surface-model");
    expect(mapChangesRequestedToOutcome(result)).toEqual({
      kind: "blocked",
      reason: "no-longer-pending",
    });
  });
});

// cinatra#3080, on main's lineage derivation (#4312). A
// repair-SUCCESSOR gate and a verification-REOPEN gate join an earlier repair's
// lineage. The canonical operation derives that lineage from the decided gate's
// own row (`deriveDecidedGateLineage`: a read of the gate, then of the repair),
// and it does so only after Regenerate's refusals: the gate-state read and the
// Note-input refusal answer first. These cases pin, on a pending gate and on a
// resolved one, what such a Regenerate answers, that the lineage reads are not
// made for it, and that nothing is written. The typed road on the same gate does
// derive the lineage, and goes on to the write.
describe("cinatra#3080 — on a successor or reopen gate, Regenerate is refused before the lineage is read, and nothing is written", () => {
  const REPAIR_ID = "00000000-0000-4000-8000-000000003080";
  const LINEAGE = "lineage-3080-note2";
  const repairRow = {
    id: REPAIR_ID,
    lineageId: LINEAGE,
    gateId: "gate-3080-earlier",
    orgId: "org-3080-mf2",
    attempt: 1,
    route: "producer_repair",
    status: "completed",
    baseArtifactId: BASE.artifactId,
    baseRepresentationRevisionId: "rev-3080-earlier",
    expectedBaseRevisionId: "rev-3080-earlier",
    findings: [],
    successorGateId: "gate-3080-mf2",
    successorArtifactId: BASE.artifactId,
    successorRepresentationRevisionId: BASE.representationRevisionId,
    findingOutcomes: null,
    changeSummary: null,
  };
  const SUCCESSOR_TASK = `lifecycle-review:repair:${REPAIR_ID}:1`;
  const REOPEN_TASK = "lifecycle-review:verify:verify:gate-3080-successor";
  /** The decided gate's own row, as the lineage derivation reads it. */
  const gateRow = (task: string) => ({ id: "gate-3080-mf2", runId: RUN, reviewTaskId: task, orgId: "org-3080-mf2" });

  for (const [name, task] of [
    ["repair-successor", SUCCESSOR_TASK],
    ["verification-reopen", REOPEN_TASK],
  ] as const) {
    it(`a ${name} gate, still pending: the plain refusal comes before the lineage reads; nothing is written`, async () => {
      // The lineage reads (the gate row, then the repair row) queue after the
      // gate-state read: they are taken only if the operation gets that far.
      ports.reads.push([gateRow(task)], [repairRow]);
      const result = await press("regenerate", task);

      const { REGENERATE_NO_NOTE_INPUT } = await import("@/lib/artifacts/review-surface-model");
      expect(result).toEqual({
        ok: false,
        code: "regenerate-unavailable",
        error: REGENERATE_NO_NOTE_INPUT,
      });
      // The refusal answered first: both lineage reads are still queued.
      expect(ports.reads).toEqual([[gateRow(task)], [repairRow]]);
      expect(ports.transaction).not.toHaveBeenCalled();
      expect(ports.write).not.toHaveBeenCalled();
    });

    it(`a ${name} gate, already resolved: gate-not-pending before the lineage reads; nothing is written`, async () => {
      gateAlreadyResolved();
      ports.reads.push([gateRow(task)], [repairRow]);
      const result = await press("regenerate", task);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("gate-not-pending");
      expect(ports.reads).toEqual([[gateRow(task)], [repairRow]]);
      expect(ports.transaction).not.toHaveBeenCalled();
      expect(ports.write).not.toHaveBeenCalled();
    });
  }

  it("the TYPED road on a repair-successor gate reads the lineage (the gate row, then the repair) and goes on to the write", async () => {
    // No gate-state read on the typed road: the derivation's two reads follow
    // the existing-repair lookup directly.
    ports.reads.splice(3, 1, [gateRow(SUCCESSOR_TASK)], [repairRow]);
    await press(undefined, SUCCESSOR_TASK);

    expect(ports.reads).toEqual([]);
    expect(ports.transaction).toHaveBeenCalledTimes(1);
  });
});
