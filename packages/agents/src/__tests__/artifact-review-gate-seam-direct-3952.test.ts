import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  readReviewGate: vi.fn(),
  listReviewGatesForRun: vi.fn(),
  listReviewLineageForRun: vi.fn(),
  hasPendingProducedEventForAttempt: vi.fn(),
  emitArtifactReviewGate: vi.fn(),
  emitDeclaredReviewGateFamily: vi.fn(),
  decideDeclaredReviewForGate: vi.fn(),
}));

// Isolate the database ports, not the seam under test. The real binder below
// installs the implementation that the run executor reads from globalThis.
vi.mock("../artifact-review-gate-store", () => ({
  readReviewGate: store.readReviewGate,
  listReviewGatesForRun: store.listReviewGatesForRun,
  listReviewLineageForRun: store.listReviewLineageForRun,
  hasPendingProducedEventForAttempt: store.hasPendingProducedEventForAttempt,
  emitArtifactReviewGate: store.emitArtifactReviewGate,
  emitDeclaredReviewGateFamily: store.emitDeclaredReviewGateFamily,
  ArtifactReviewGateError: class extends Error {},
}));
vi.mock("../lifecycle-declared-review-store", () => ({
  decideDeclaredReviewForGate: store.decideDeclaredReviewForGate,
}));

import {
  bindArtifactReviewGateSeam,
  type ArtifactReviewGateSeam,
} from "../artifact-review-gate-seam";

const slot = globalThis as {
  __cinatraArtifactReviewGateSeam?: ArtifactReviewGateSeam;
};
let previousSeam: ArtifactReviewGateSeam | undefined;

const runId = "run-seam-direct";
const orgId = "org-seam-direct";
const firstTarget = {
  artifactId: "artifact-first",
  representationRevisionId: "revision-first",
};
const secondTarget = {
  artifactId: "artifact-second",
  representationRevisionId: "revision-second",
};

const readings = [
  { label: "single-artifact", reviewTaskId: "gate-single", status: "pending", pinnedTargets: [firstTarget] },
  { label: "historical combined", reviewTaskId: "gate-combined", status: "resolved", pinnedTargets: [firstTarget, secondTarget] },
] as const;

beforeEach(() => {
  previousSeam = slot.__cinatraArtifactReviewGateSeam;
  vi.resetAllMocks();
  bindArtifactReviewGateSeam();
});

afterEach(() => {
  if (previousSeam === undefined) delete slot.__cinatraArtifactReviewGateSeam;
  else slot.__cinatraArtifactReviewGateSeam = previousSeam;
});

function boundSeam(): ArtifactReviewGateSeam {
  const seam = slot.__cinatraArtifactReviewGateSeam;
  if (!seam) throw new Error("The real binder did not install its seam");
  return seam;
}

describe("the actual artifact-review gate seam", () => {
  it.each(readings)("projects complete pinned identity for a $label gate", async ({ reviewTaskId, status, pinnedTargets }) => {
    store.readReviewGate.mockResolvedValue({
      runId, orgId, reviewTaskId, status, pinnedTargets,
      disposition: null,
      fingerprint: "store-only-fingerprint",
    });

    const result = await boundSeam().readGate(runId, reviewTaskId);

    expect(store.readReviewGate).toHaveBeenCalledExactlyOnceWith(runId, reviewTaskId);
    expect(result).toEqual({
      orgId,
      status,
      targets: pinnedTargets,
    });
  });

  it.each(readings)("lists a $label gate once alongside the next waiting gate", async ({ reviewTaskId, status, pinnedTargets }) => {
    store.listReviewGatesForRun.mockResolvedValue([
      { runId, orgId, reviewTaskId, status, pinnedTargets },
      { runId, orgId, reviewTaskId: "gate-next", status: "pending", pinnedTargets: [secondTarget] },
    ]);

    const seam = boundSeam();
    expect(seam.listGates).toBeTypeOf("function");
    expect(await seam.listGates(runId)).toEqual([
      { reviewTaskId, status },
      { reviewTaskId: "gate-next", status: "pending" },
    ]);
    expect(store.listReviewGatesForRun).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("keeps an absent gate absent", async () => {
    store.readReviewGate.mockResolvedValue(null);
    expect(await boundSeam().readGate(runId, "missing-gate")).toBeNull();
    expect(store.readReviewGate).toHaveBeenCalledExactlyOnceWith(runId, "missing-gate");
  });

  it("keeps an empty run gate list empty", async () => {
    store.listReviewGatesForRun.mockResolvedValue([]);
    const seam = boundSeam();
    expect(seam.listGates).toBeTypeOf("function");
    expect(await seam.listGates(runId)).toEqual([]);
    expect(store.listReviewGatesForRun).toHaveBeenCalledExactlyOnceWith(runId);
  });

  it("propagates a gate read failure", async () => {
    const failure = new Error("read port failed");
    store.readReviewGate.mockRejectedValue(failure);
    await expect(boundSeam().readGate(runId, "gate-single")).rejects.toBe(failure);
  });

  it("propagates a gate list failure", async () => {
    const failure = new Error("list port failed");
    store.listReviewGatesForRun.mockRejectedValue(failure);
    const seam = boundSeam();
    expect(seam.listGates).toBeTypeOf("function");
    await expect(seam.listGates(runId)).rejects.toBe(failure);
  });
});

describe("the run's reviews, as the publish gate reads them (cinatra#4762)", () => {
  const HUMAN = "a".repeat(64);

  // red-first-expect: expected [ undefined, undefined, undefined ] to deeply equal [ 'expiry:gate-1', …(2) ]
  it("carry each review's resolving fingerprint, so the publish gate can tell a person's approval from an expiry", async () => {
    const createdAt = new Date("2026-11-20T10:05:00.000Z");
    const rows = [
      { id: "g1", reviewTaskId: "r1", status: "resolved", disposition: "approve", createdAt, runGeneration: 0, fingerprint: "expiry:gate-1", successorGateId: null },
      { id: "g2", reviewTaskId: "r2", status: "resolved", disposition: "approve", createdAt, runGeneration: 0, fingerprint: HUMAN, successorGateId: null },
      { id: "g3", reviewTaskId: "r3", status: "pending", disposition: null, createdAt, runGeneration: 0, fingerprint: null, successorGateId: null },
    ];
    // The plain gate list answers the same rows: only the lineage read carries the successor, whichever the seam reads.
    store.listReviewLineageForRun.mockResolvedValue(rows);
    store.listReviewGatesForRun.mockResolvedValue(rows);
    const seam = slot.__cinatraArtifactReviewGateSeam! as unknown as { listReviews?: (runId: string) => Promise<Array<{ fingerprint?: unknown }>> };
    const listed = typeof seam.listReviews === "function" ? await seam.listReviews(runId) : [{}, {}, {}];
    expect(listed.map((r) => r.fingerprint)).toEqual(["expiry:gate-1", HUMAN, null]);
  });

  // red-first-expect: seam.listReviews is not a function
  it("carry each gate's identity and the successor its repair recorded, read in one statement of the store", async () => {
    const createdAt = new Date("2026-11-20T10:05:00.000Z");
    const rows = [
      { id: "g1", reviewTaskId: "r1", status: "resolved", disposition: "changes_requested", createdAt, createdAtMicros: "1795169100000100", runGeneration: null, fingerprint: HUMAN, successorGateId: "g2" },
      { id: "g2", reviewTaskId: "r2", status: "resolved", disposition: "approve", createdAt, createdAtMicros: "1795169100000900", runGeneration: 0, fingerprint: HUMAN, successorGateId: null },
    ];
    store.listReviewLineageForRun.mockResolvedValue(rows);
    store.listReviewGatesForRun.mockResolvedValue(rows.map(({ successorGateId: _successor, ...gate }) => gate));
    const seam = slot.__cinatraArtifactReviewGateSeam!;
    expect(await seam.listReviews(runId)).toEqual([
      { id: "g1", status: "resolved", disposition: "changes_requested", createdAt, runGeneration: null, fingerprint: HUMAN, successorGateId: "g2" },
      { id: "g2", status: "resolved", disposition: "approve", createdAt, runGeneration: 0, fingerprint: HUMAN, successorGateId: null },
    ]);
    expect(store.listReviewLineageForRun).toHaveBeenCalledWith(runId);
    expect(store.listReviewGatesForRun).not.toHaveBeenCalled();
  });

  // red-first-expect: expected 'undefined' to be 'function'
  it("ask the store whether an output of the attempt still waits for the review orchestration", async () => {
    store.hasPendingProducedEventForAttempt.mockResolvedValue(true);
    const seam = slot.__cinatraArtifactReviewGateSeam!;
    expect(typeof seam.hasPendingProducedReview).toBe("function");
    expect(await seam.hasPendingProducedReview({ orgId, runId, generation: 2 })).toBe(true);
    expect(store.hasPendingProducedEventForAttempt).toHaveBeenCalledWith({ orgId, runId, generation: 2 });
  });

  // red-first-expect: expected "vi.fn()" to be called with arguments: [ …(2) ]
  it("read in the transaction the publish store hands them, so the fence is read under the run row's lock", async () => {
    const tx = { the: "run-row lock's transaction" };
    store.hasPendingProducedEventForAttempt.mockResolvedValue(false);
    store.listReviewLineageForRun.mockResolvedValue([]);
    const seam = slot.__cinatraArtifactReviewGateSeam! as unknown as {
      hasPendingProducedReview: (input: unknown, executor?: unknown) => Promise<boolean>;
      listReviews: (runId: string, executor?: unknown) => Promise<unknown[]>;
    };
    if (typeof seam.hasPendingProducedReview === "function") await seam.hasPendingProducedReview({ orgId, runId, generation: 2 }, tx);
    expect(store.hasPendingProducedEventForAttempt).toHaveBeenCalledWith({ orgId, runId, generation: 2 }, tx);
    await seam.listReviews(runId, tx);
    expect(store.listReviewLineageForRun).toHaveBeenCalledWith(runId, tx);
  });
});
