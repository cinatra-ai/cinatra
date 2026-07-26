/**
 * cinatra#2038 (epic #2037 S0) — the BATCH contract (AC-5): seal provability,
 * partition determinism, all four aggregate dispositions, and the carry-forward
 * rule. Pure.
 */
import { describe, it, expect } from "vitest";

import {
  sealBatch,
  partitionBatchTargets,
  aggregateBatchDisposition,
  carryForwardApprovals,
  MAX_BATCH_PARTITION,
  type BatchTarget,
  type PerTargetOutcome,
} from "../lifecycle-batch";

function t(a: string, r: string): BatchTarget {
  return { artifactId: a, representationRevisionId: r };
}

describe("AC-5: sealed membership", () => {
  it("an explicit list seals immediately (deduped)", () => {
    const res = sealBatch({ kind: "explicit", targets: [t("a", "1"), t("a", "1"), t("b", "2")] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.targets).toHaveLength(2);
  });
  it("a counted batch seals ONLY when closed AND the count matches", () => {
    const notClosed = sealBatch({ kind: "counted", expectedCount: 2, observed: [t("a", "1"), t("b", "2")], closeMarker: false });
    expect(notClosed.ok).toBe(false);
    const wrongCount = sealBatch({ kind: "counted", expectedCount: 3, observed: [t("a", "1"), t("b", "2")], closeMarker: true });
    expect(wrongCount.ok).toBe(false);
    const sealed = sealBatch({ kind: "counted", expectedCount: 2, observed: [t("a", "1"), t("b", "2")], closeMarker: true });
    expect(sealed.ok).toBe(true);
  });
  it("an empty batch is not sealable", () => {
    expect(sealBatch({ kind: "explicit", targets: [] }).ok).toBe(false);
  });
});

describe("injective target key (adversarial ids)", () => {
  it("does NOT collide {a:'a', r:'b c'} with {a:'a b', r:'c'} (dedupe keeps both)", () => {
    const res = sealBatch({ kind: "explicit", targets: [t("a", "b c"), t("a b", "c")] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.targets).toHaveLength(2);
  });
  it("carry-forward does not cross-match distinct tuples that share a naive join", () => {
    const r = carryForwardApprovals([t("a", "b c")], [{ artifactId: "a b", representationRevisionId: "c" }]);
    expect(r.carried).toHaveLength(0);
    expect(r.mustReReview).toHaveLength(1);
  });
});

describe("AC-5: deterministic ≤50 partitions", () => {
  it("a non-finite maxPartition falls back to the default (never drops targets)", () => {
    const targets = [t("a", "1"), t("b", "2")];
    // NaN would compute size=NaN and silently drop targets without the guard.
    const parts = partitionBatchTargets(targets, Number.NaN);
    expect(parts.flat()).toHaveLength(2);
  });
  it("the SAME sealed set yields byte-identical partitions regardless of input order", () => {
    const forward = Array.from({ length: 120 }, (_, i) => t("art", `rev-${String(i).padStart(3, "0")}`));
    const reversed = [...forward].reverse();
    const p1 = partitionBatchTargets(forward);
    const p2 = partitionBatchTargets(reversed);
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
  });
  it("no partition exceeds MAX_BATCH_PARTITION (50)", () => {
    const targets = Array.from({ length: 137 }, (_, i) => t("art", `rev-${i}`));
    const parts = partitionBatchTargets(targets);
    expect(parts.length).toBe(Math.ceil(137 / MAX_BATCH_PARTITION));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_BATCH_PARTITION);
    expect(parts.flat()).toHaveLength(137);
  });
});

describe("AC-5: the four aggregate dispositions", () => {
  const A = t("a", "1");
  const B = t("b", "1");
  const C = t("c", "1");
  it("all approve → approved (effects releasable)", () => {
    const d = aggregateBatchDisposition([
      { target: A, disposition: "approve" },
      { target: B, disposition: "approve" },
    ]);
    expect(d.aggregate).toBe("approved");
    expect(d.effectsReleasable).toBe(true);
    expect(d.terminal).toBe(true);
  });
  it("any changes_requested → changes_requested (union findings; rejected excluded from repair)", () => {
    const outcomes: PerTargetOutcome[] = [
      { target: A, disposition: "approve" },
      { target: B, disposition: "changes_requested", findings: [{ id: "f1", message: "x" }, { id: "f2", message: "y" }] },
      { target: C, disposition: "reject" },
    ];
    const d = aggregateBatchDisposition(outcomes);
    expect(d.aggregate).toBe("changes_requested");
    expect(d.terminal).toBe(false);
    expect(d.effectsReleasable).toBe(false);
    expect(d.repairScope).toEqual([B]); // rejected C excluded
    expect(d.unionFindings.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
  it("all reject → rejected (terminal, no effects)", () => {
    const d = aggregateBatchDisposition([
      { target: A, disposition: "reject" },
      { target: B, disposition: "reject" },
    ]);
    expect(d.aggregate).toBe("rejected");
    expect(d.terminal).toBe(true);
    expect(d.effectsReleasable).toBe(false);
  });
  it("approve + reject (no changes_requested) → partially_approved (terminal)", () => {
    const d = aggregateBatchDisposition([
      { target: A, disposition: "approve" },
      { target: B, disposition: "reject" },
    ]);
    expect(d.aggregate).toBe("partially_approved");
    expect(d.terminal).toBe(true);
    expect(d.effectsReleasable).toBe(false);
  });
  it("de-dupes union findings across targets", () => {
    const d = aggregateBatchDisposition([
      { target: A, disposition: "changes_requested", findings: [{ id: "shared", message: "x" }] },
      { target: B, disposition: "changes_requested", findings: [{ id: "shared", message: "x" }, { id: "b-only", message: "z" }] },
    ]);
    expect(d.unionFindings.map((f) => f.id).sort()).toEqual(["b-only", "shared"]);
  });
});

describe("AC-5: carry-forward (approval carries only for unchanged pinned revisions)", () => {
  it("carries an approval forward for an unchanged revision; re-pinned must re-review", () => {
    const successor = [t("a", "1"), t("b", "2-new"), t("c", "1")];
    const priorApprovals = [
      { artifactId: "a", representationRevisionId: "1" }, // unchanged
      { artifactId: "b", representationRevisionId: "2-old" }, // re-pinned in successor
      { artifactId: "c", representationRevisionId: "1" }, // unchanged
    ];
    const r = carryForwardApprovals(successor, priorApprovals);
    expect(r.carried.map((x) => x.artifactId).sort()).toEqual(["a", "c"]);
    expect(r.mustReReview.map((x) => x.artifactId)).toEqual(["b"]);
  });
});
