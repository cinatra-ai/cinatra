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
    // cinatra#2047 D-2 — the live acting actor the core stamps onto the plan.
    actingActorId: () => "user-decider",
    // cinatra#2571 — no suggestions surfaced unless a test says otherwise.
    readSurfacedSuggestions: async () => null,
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

// ---------------------------------------------------------------------------
// THE DECIDING ACTOR (cinatra#2047 D-2).
//
// A lifecycle review exists to let a HUMAN control what the AGENT produced. The
// record the gate must carry is therefore WHO decided — not a restriction on who
// is allowed to. These tests pin both halves: the plan always carries the
// server-resolved acting actor, and the core never consults it to permit or
// refuse a decision.
// ---------------------------------------------------------------------------

describe("submitReviewDecisionCore — the deciding actor is recorded", () => {
  it("stamps the SERVER-resolved acting actor onto the commit plan (approve)", async () => {
    const p = ports({ actingActorId: () => "user-V" });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].decidedBy).toBe("user-V");
  });

  it("stamps the acting actor on a REJECT too (every terminal decision has a decider)", async () => {
    const p = ports({ actingActorId: () => "user-V" });
    const r = await submitReviewDecisionCore(decision({ disposition: "reject" }), p);
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].decidedBy).toBe("user-V");
  });

  it("takes the actor from the PORT, never from the client decision payload", async () => {
    // A client that tries to name a different decider changes nothing: the core
    // reads the host port, which resolves the verified session actor.
    const p = ports({ actingActorId: () => "user-server-resolved" });
    const spoofed = { ...decision(), decidedBy: "user-claimed-by-client" } as ReturnType<typeof decision>;
    const r = await submitReviewDecisionCore(spoofed, p);
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].decidedBy).toBe("user-server-resolved");
  });

  it("records null when the host cannot name an actor (a non-human carrier) — and still commits", async () => {
    const p = ports({ actingActorId: () => null });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].decidedBy).toBeNull();
  });

  it("PINNED CONTRACT — the actor who STARTED the run may decide their own run's review", async () => {
    // The product decision for lifecycle review: any member of the scope the run
    // belongs to may decide the review WITHOUT limitation, explicitly including
    // the person who started the run. Recording who decided is the point;
    // restricting who may decide is not. This is the exact INVERSE of the old
    // separation-of-duties repro, pinned so the decision cannot silently regress.
    const initiator = "user-who-started-the-run";
    const p = ports({ actingActorId: () => initiator });
    const r = await submitReviewDecisionCore(decision(), p);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // Approved, committed, and attributed to the initiator — no refusal path.
    const plan = p.commit.mock.calls[0][0];
    expect(plan.disposition).toBe("approve");
    expect(plan.terminal).toBe(true);
    expect(plan.decidedBy).toBe(initiator);
  });

  it("the core exposes NO actor-based refusal: identical outcome for any two actors", async () => {
    const a = ports({ actingActorId: () => "user-producer" });
    const b = ports({ actingActorId: () => "user-someone-else" });
    const ra = await submitReviewDecisionCore(decision(), a);
    const rb = await submitReviewDecisionCore(decision(), b);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    // Only the recorded decider differs; nothing else about the decision does.
    const strip = (plan: Record<string, unknown>) => ({ ...plan, decidedBy: undefined });
    expect(strip(a.commit.mock.calls[0][0])).toEqual(strip(b.commit.mock.calls[0][0]));
    expect(a.commit.mock.calls[0][0].decidedBy).toBe("user-producer");
    expect(b.commit.mock.calls[0][0].decidedBy).toBe("user-someone-else");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2571 (epic #2564 S6b) — the suggestion partition inside the decision.
// ---------------------------------------------------------------------------

const SURFACED = { snapshotId: "gsug_abc", suggestionIds: ["sug_1", "sug_2", "sug_3"] };

function suggestionPorts(over: Partial<SubmitDecisionPorts> = {}, commitOutcome?: ReviewCommitOutcome) {
  return ports({ readSurfacedSuggestions: async () => SURFACED, ...over }, commitOutcome);
}

describe("S6b — the accepted/dismissed partition is part of the decision IDENTITY", () => {
  it("two partitions with the SAME disposition are DIFFERENT fingerprints", () => {
    const base = {
      runId: "run",
      reviewTaskId: "wayflow-t",
      disposition: "approve" as const,
      comment: null,
      reviewedTargets: PINNED,
    };
    const a = reviewDecisionFingerprint({
      ...base,
      suggestionDecisions: { accepted: ["sug_1"], dismissed: ["sug_2"] },
    });
    const b = reviewDecisionFingerprint({
      ...base,
      suggestionDecisions: { accepted: ["sug_2"], dismissed: ["sug_1"] },
    });
    expect(a).not.toBe(b);
  });

  it("the partition is ORDER-FREE and DUPLICATE-FREE — a reordered resubmit is the SAME decision", () => {
    const base = {
      runId: "run",
      reviewTaskId: "wayflow-t",
      disposition: "approve" as const,
      comment: null,
      reviewedTargets: PINNED,
    };
    const a = reviewDecisionFingerprint({
      ...base,
      suggestionDecisions: { accepted: ["sug_1", "sug_3"], dismissed: ["sug_2"] },
    });
    const b = reviewDecisionFingerprint({
      ...base,
      suggestionDecisions: { accepted: ["sug_3", "sug_1"], dismissed: ["sug_2"] },
    });
    expect(a).toBe(b);
  });

  it("a decision with NO partition keeps its pre-#2571 fingerprint (deploy cannot re-identify it)", () => {
    const base = {
      runId: "run",
      reviewTaskId: "wayflow-t",
      disposition: "approve" as const,
      comment: null,
      reviewedTargets: PINNED,
    };
    // The identity is pinned to a LITERAL, not re-derived from the code under
    // test: a future change that alters the no-partition material would turn every
    // in-flight retry into a conflict, and this is what would catch it. The value
    // was computed INDEPENDENTLY from the pre-#2571 material
    // (`{v:1,runId,reviewTaskId,disposition,comment,targetKeys}`), not copied out
    // of a run of the new code — a literal snapshotted from the implementation it
    // guards would agree with any change it was supposed to catch.
    const LEGACY_FINGERPRINT =
      "b04ea2ba4483de99ae7cc8997a1aa0a245c5e1edf35a78d3786d280d4cb7b0a0";
    const withoutKey = reviewDecisionFingerprint(base);
    const withNull = reviewDecisionFingerprint({ ...base, suggestionDecisions: null });
    const withEmpty = reviewDecisionFingerprint({
      ...base,
      suggestionDecisions: { accepted: [], dismissed: [] },
    });
    expect(withNull).toBe(withoutKey);
    expect(withEmpty).toBe(withoutKey);
    expect(withoutKey).toBe(LEGACY_FINGERPRINT);
  });

  it("an IDENTICAL resubmission is idempotent — the resolved gate's fingerprint matches", async () => {
    const suggestionDecisions = { accepted: ["sug_1"], dismissed: ["sug_2"] };
    const first = suggestionPorts();
    const r1 = await submitReviewDecisionCore(decision({ suggestionDecisions }), first);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("unreachable");

    const retry = suggestionPorts({
      readGateState: async () => ({ status: "resolved", fingerprint: r1.fingerprint }),
    });
    const r2 = await submitReviewDecisionCore(decision({ suggestionDecisions }), retry);
    expect(r2).toMatchObject({ ok: true, idempotent: true, fingerprint: r1.fingerprint });
    expect(retry.commit).not.toHaveBeenCalled();
  });

  it("a DIFFERENT partition against the same resolved gate is a CONFLICT, not an overwrite", async () => {
    const first = suggestionPorts();
    const r1 = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1"], dismissed: [] } }),
      first,
    );
    if (!r1.ok) throw new Error("unreachable");
    const second = suggestionPorts({
      readGateState: async () => ({ status: "resolved", fingerprint: r1.fingerprint }),
    });
    const r2 = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_2"], dismissed: [] } }),
      second,
    );
    expect(r2).toEqual({ ok: false, error: { kind: "gate-conflict" } });
    expect(second.commit).not.toHaveBeenCalled();
  });
});

describe("S6b — forged / replayed suggestion ids are refused PRE-CAS", () => {
  it("an id the pinned snapshot never surfaced is rejected and NOTHING commits", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1", "sug_forged"], dismissed: [] } }),
      p,
    );
    expect(r).toEqual({
      ok: false,
      error: { kind: "suggestion-not-surfaced", suggestionIds: ["sug_forged"] },
    });
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("a gate with NO readable snapshot surfaces nothing — every id is refused", async () => {
    const p = suggestionPorts({ readSurfacedSuggestions: async () => null });
    const r = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1"], dismissed: [] } }),
      p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("suggestion-not-surfaced");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("a DISMISSED forged id is refused too — the whole partition is checked", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: [], dismissed: ["sug_elsewhere"] } }),
      p,
    );
    expect(r.ok).toBe(false);
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("the snapshot is read ONLY after run access + the pending-gate check", async () => {
    const order: string[] = [];
    const p = suggestionPorts({
      verifyRunAccess: async () => (order.push("access"), { ok: true }),
      readGateState: async () => (
        order.push("gate"), { status: "pending" as const, targets: PINNED }
      ),
      readSurfacedSuggestions: async () => (order.push("snapshot"), SURFACED),
    });
    await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1"], dismissed: [] } }),
      p,
    );
    expect(order).toEqual(["access", "gate", "snapshot"]);
  });

  it("an unauthorized caller never reaches the snapshot read (no existence oracle)", async () => {
    const readSurfacedSuggestions = vi.fn(async () => SURFACED);
    const p = suggestionPorts({
      verifyRunAccess: async () => ({ ok: false, status: 403 }),
      readSurfacedSuggestions,
    });
    const r = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1"], dismissed: [] } }),
      p,
    );
    expect(r).toEqual({ ok: false, error: { kind: "run-access-denied", status: 403 } });
    expect(readSurfacedSuggestions).not.toHaveBeenCalled();
  });
});

describe("S6b — a partition can only ride a decision that can carry it", () => {
  it("REFUSES a partition on a non-terminal comment (no per-item pathway)", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({
        disposition: "comment",
        comment: "note",
        suggestionDecisions: { accepted: ["sug_1"], dismissed: [] },
      }),
      p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("invalid-decision");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("REFUSES accepted suggestions on a reject (they would patch tombstoned work)", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({
        disposition: "reject",
        suggestionDecisions: { accepted: ["sug_1"], dismissed: [] },
      }),
      p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("invalid-decision");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("ALLOWS dismissals on a reject — the reviewer looked and declined", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({
        disposition: "reject",
        suggestionDecisions: { accepted: [], dismissed: ["sug_1"] },
      }),
      p,
    );
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].suggestionPlan).toEqual({
      snapshotId: SURFACED.snapshotId,
      accepted: [],
      dismissed: ["sug_1"],
    });
  });

  it("REFUSES an id that is both accepted and dismissed", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_1"], dismissed: ["sug_1"] } }),
      p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("invalid-decision");
    expect(p.commit).not.toHaveBeenCalled();
  });

  it("REFUSES a partition declared under the pre-#2571 payload version", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(
      decision({
        decisionApiVersion: 1,
        suggestionDecisions: { accepted: ["sug_1"], dismissed: [] },
      }),
      p,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("invalid-decision");
  });

  it("still ACCEPTS a v1 payload with no partition (an old client keeps working)", async () => {
    const p = suggestionPorts();
    const r = await submitReviewDecisionCore(decision({ decisionApiVersion: 1 }), p);
    expect(r.ok).toBe(true);
    expect(p.commit.mock.calls[0][0].suggestionPlan).toBeNull();
  });
});

describe("S6b — the commit plan carries the ledger + intent inputs", () => {
  it("binds the plan to the SNAPSHOT the ids were validated against, canonically sorted", async () => {
    const p = suggestionPorts();
    await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: ["sug_3", "sug_1"], dismissed: ["sug_2"] } }),
      p,
    );
    expect(p.commit.mock.calls[0][0].suggestionPlan).toEqual({
      snapshotId: "gsug_abc",
      accepted: ["sug_1", "sug_3"],
      dismissed: ["sug_2"],
    });
  });

  it("a decision that surfaces suggestions but decides NONE carries no plan at all", async () => {
    const p = suggestionPorts();
    await submitReviewDecisionCore(
      decision({ suggestionDecisions: { accepted: [], dismissed: [] } }),
      p,
    );
    expect(p.commit.mock.calls[0][0].suggestionPlan).toBeNull();
  });
});
