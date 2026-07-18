/**
 * The artifact-review DECISION core (cinatra#1795, epic #1620 S12, items 4 + 5;
 * AC-3). Proves submit-time re-validation, TRUE idempotency (sequential retry +
 * concurrent race), SERVER-derived audit provenance (never client-supplied),
 * reject → tombstone (never hard-delete), the terminal resume folded into the
 * atomic commit as an exactly-once outbox intent, and — the load-bearing
 * invariant — ZERO PARTIAL COMMIT: any re-validation or persistence failure
 * commits nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  rendererProvenanceFromMount,
  reviewDecisionFingerprint,
  submitReviewDecisionCore,
  type ArtifactReviewDecision,
  type ReviewCommitOutcome,
  type ReviewGateState,
  type ReviewRendererProvenance,
  type SubmitDecisionPorts,
} from "../artifact-review-decision";
import type { SerializedRuntimeRendererDescriptor } from "../runtime-renderer-descriptor";
import type { ArtifactReviewTarget } from "../artifact-review-target";

const t = (a: string, r: string): ArtifactReviewTarget => ({ artifactId: a, representationRevisionId: r });
const PROV: ReviewRendererProvenance = { kind: "build-map", packageName: "@x/ext", digest: null };
const PINNED = [t("a", "1"), t("b", "2")];

function decision(over: Partial<ArtifactReviewDecision> = {}): ArtifactReviewDecision {
  return {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: "run",
    reviewTaskId: "wayflow-t",
    disposition: "approve",
    comment: null,
    reviewedTargets: [t("a", "1"), t("b", "2")],
    ...over,
  };
}

function ports(
  over: Partial<SubmitDecisionPorts> = {},
  commitOutcome: ReviewCommitOutcome = { status: "committed" },
): SubmitDecisionPorts & { commit: ReturnType<typeof vi.fn> } {
  const commit = vi.fn(async () => commitOutcome);
  return {
    verifyRunAccess: async () => ({ ok: true }),
    readGateState: async (): Promise<ReviewGateState> => ({ status: "pending", targets: PINNED }),
    revisionMember: () => ({ mime: "application/json" }),
    deriveProvenance: async () => PROV,
    commit,
    ...over,
  } as SubmitDecisionPorts & { commit: ReturnType<typeof vi.fn> };
}

describe("submitReviewDecisionCore — terminal approve", () => {
  it("commits a plan with SERVER-derived audit provenance + an APPROVE resume intent", async () => {
    const p = ports();
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.idempotent).toBe(false);
    expect(p.commit).toHaveBeenCalledTimes(1);
    const plan = p.commit.mock.calls[0][0];
    // Audit rows: one per reviewed target, capturing revision + host-derived provenance.
    expect(plan.auditRows).toEqual([
      { artifactId: "a", representationRevisionId: "1", disposition: "approve", rendererProvenance: PROV },
      { artifactId: "b", representationRevisionId: "2", disposition: "approve", rendererProvenance: PROV },
    ]);
    expect(plan.dispositionOps).toEqual([]);
    expect(plan.resumeIntent.kind).toBe("approve");
    expect(plan.resumeIntent.userResponse).toContain('"approved":true');
    expect(plan.fingerprint).toBe(reviewDecisionFingerprint(decision()));
  });

  it("audit provenance comes from deriveProvenance (server), not the client decision", async () => {
    const derived = vi.fn(async () => ({ kind: "runtime" as const, packageName: "@x/ext", digest: "z".repeat(64) }));
    const p = ports({ deriveProvenance: derived });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    expect(derived).toHaveBeenCalledTimes(2);
    const plan = p.commit.mock.calls[0][0];
    expect(plan.auditRows[0].rendererProvenance).toEqual({ kind: "runtime", packageName: "@x/ext", digest: "z".repeat(64) });
  });
});

describe("submitReviewDecisionCore — terminal reject", () => {
  it("records a TOMBSTONE disposition per target (never hard-delete) + a REJECT resume intent", async () => {
    const p = ports();
    const r = await submitReviewDecisionCore(decision({ disposition: "reject", comment: "no" }), p);
    expect(r.ok).toBe(true);
    const plan = p.commit.mock.calls[0][0];
    expect(plan.dispositionOps).toEqual([
      { artifactId: "a", representationRevisionId: "1", kind: "tombstone" },
      { artifactId: "b", representationRevisionId: "2", kind: "tombstone" },
    ]);
    expect(plan.resumeIntent.kind).toBe("reject");
    expect(plan.resumeIntent.rejectResponse).not.toContain('"approved"');
    expect(plan.resumeIntent.userResponse).toBeUndefined();
  });
});

describe("submitReviewDecisionCore — comment (non-terminal)", () => {
  it("audits without a terminal resume or disposition; gate stays pending", async () => {
    const p = ports();
    const r = await submitReviewDecisionCore(decision({ disposition: "comment", reviewedTargets: [t("a", "1")] }), p);
    expect(r.ok).toBe(true);
    const plan = p.commit.mock.calls[0][0];
    expect(plan.terminal).toBe(false);
    expect(plan.dispositionOps).toEqual([]);
    expect(plan.resumeIntent).toBeNull();
  });
});

describe("submitReviewDecisionCore — idempotency", () => {
  it("SEQUENTIAL retry: a gate already resolved by an IDENTICAL decision → idempotent success, NO re-commit", async () => {
    const fp = reviewDecisionFingerprint(decision());
    const p = ports({ readGateState: async () => ({ status: "resolved", fingerprint: fp }) });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r).toEqual({ ok: true, idempotent: true, fingerprint: fp, plan: null });
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("CONCURRENT race: gate pending at read, commit reports already-resolved (matching fp) → idempotent success", async () => {
    const p = ports({}, { status: "already-resolved" });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.idempotent).toBe(true);
  });

  it("a gate resolved by a DIFFERENT decision (fingerprint mismatch) → gate-conflict, NO commit", async () => {
    const p = ports({ readGateState: async () => ({ status: "resolved", fingerprint: "deadbeef" }) });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r).toEqual({ ok: false, error: { kind: "gate-conflict" } });
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("fingerprint is order-independent in the targets (a reordered retry is still idempotent)", async () => {
    expect(reviewDecisionFingerprint(decision({ reviewedTargets: [t("a", "1"), t("b", "2")] }))).toBe(
      reviewDecisionFingerprint(decision({ reviewedTargets: [t("b", "2"), t("a", "1")] })),
    );
  });

  it("reordered targets emit a BYTE-IDENTICAL plan (canonical order matches the order-independent fingerprint)", async () => {
    const fwd = ports();
    const rev = ports();
    await submitReviewDecisionCore(decision({ disposition: "reject", reviewedTargets: [t("a", "1"), t("b", "2")] }), fwd);
    await submitReviewDecisionCore(decision({ disposition: "reject", reviewedTargets: [t("b", "2"), t("a", "1")] }), rev);
    const planFwd = fwd.commit.mock.calls[0][0];
    const planRev = rev.commit.mock.calls[0][0];
    // Same fingerprint AND same audit-row / disposition / resume-intent bytes.
    expect(planRev.fingerprint).toBe(planFwd.fingerprint);
    expect(planRev.auditRows).toEqual(planFwd.auditRows);
    expect(planRev.dispositionOps).toEqual(planFwd.dispositionOps);
    expect(planRev.resumeIntent).toEqual(planFwd.resumeIntent);
  });
});

describe("submitReviewDecisionCore — ZERO PARTIAL COMMIT", () => {
  it("a persistence failure (commit throws) commits nothing → commit-failed", async () => {
    const commit = vi.fn(async () => {
      throw new Error("db down");
    });
    const r = await submitReviewDecisionCore(decision(), { ...ports(), commit });
    expect(r).toEqual({ ok: false, error: { kind: "commit-failed", message: "db down" } });
  });

  it("a commit conflict → gate-conflict (nothing resumed — resume rides the committed outbox only)", async () => {
    const p = ports({}, { status: "conflict" });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r).toEqual({ ok: false, error: { kind: "gate-conflict" } });
  });

  it("one non-member target aborts BEFORE any commit (no persistence)", async () => {
    const p = ports({ revisionMember: (artifactId) => (artifactId === "b" ? null : { mime: "application/json" }) });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("revision-not-member");
    expect(p.commit).not.toHaveBeenCalled();
  });
});

describe("submitReviewDecisionCore — re-validation gates", () => {
  it("substituted reviewed target → target-substitution, no commit", async () => {
    const p = ports();
    const r = await submitReviewDecisionCore(decision({ reviewedTargets: [t("c", "9"), t("a", "1"), t("b", "2")] }), p);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("target-substitution");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("a TERMINAL decision must cover EVERY pinned target (partial → incomplete-coverage)", async () => {
    const p = ports();
    const r = await submitReviewDecisionCore(decision({ reviewedTargets: [t("a", "1")] }), p);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("incomplete-coverage");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("run-access denied → error, no gate read / commit", async () => {
    const readGateState = vi.fn(async (): Promise<ReviewGateState> => ({ status: "pending", targets: PINNED }));
    const p = ports({ verifyRunAccess: async () => ({ ok: false, status: 403 }), readGateState });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r).toEqual({ ok: false, error: { kind: "run-access-denied", status: 403 } });
    expect(readGateState).not.toHaveBeenCalled();
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("approve/reject demand approveHitl; comment demands respondToHitl", async () => {
    const ops: string[] = [];
    const spy = ports({ verifyRunAccess: async (_run, op) => (ops.push(op), { ok: true }) });
    await submitReviewDecisionCore(decision({ disposition: "approve" }), spy);
    await submitReviewDecisionCore(decision({ disposition: "comment", reviewedTargets: [t("a", "1")] }), spy);
    expect(ops).toEqual(["approveHitl", "respondToHitl"]);
  });

  it("gate unavailable (absent / terminal-other) → gate-not-pending", async () => {
    const p = ports({ readGateState: async () => ({ status: "unavailable" }) });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r).toEqual({ ok: false, error: { kind: "gate-not-pending" } });
    expect(p.commit).not.toHaveBeenCalled();
  });
});

describe("submitReviewDecisionCore — invalid decisions", () => {
  it("rejects an unsupported api version / unknown disposition / empty targets", async () => {
    const p = ports();
    expect((await submitReviewDecisionCore(decision({ decisionApiVersion: 99 }), p)).ok).toBe(false);
    expect((await submitReviewDecisionCore(decision({ disposition: "yeet" as never }), p)).ok).toBe(false);
    expect((await submitReviewDecisionCore(decision({ reviewedTargets: [] }), p)).ok).toBe(false);
  });
});

describe("rendererProvenanceFromMount", () => {
  it("captures package + digest for runtime, package-only for build-map, and floor", () => {
    const desc = { tuple: { digest: "d".repeat(64) } } as SerializedRuntimeRendererDescriptor;
    expect(rendererProvenanceFromMount({ kind: "build-map", slot: "detail", packageName: "@x/ext", generatedKey: "k" })).toEqual({
      kind: "build-map",
      packageName: "@x/ext",
      digest: null,
    });
    expect(rendererProvenanceFromMount({ kind: "runtime", slot: "detail", packageName: "@x/ext", descriptor: desc })).toEqual({
      kind: "runtime",
      packageName: "@x/ext",
      digest: "d".repeat(64),
    });
    expect(rendererProvenanceFromMount({ kind: "floor", slot: "detail", packageName: null, reason: "no-semantic-renderer" })).toEqual({
      kind: "floor",
      packageName: null,
      digest: null,
    });
  });
});
