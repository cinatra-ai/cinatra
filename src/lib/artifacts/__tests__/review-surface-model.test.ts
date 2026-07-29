/**
 * Unit tests for the PURE artifact-review surface model (cinatra#1795 S12 item 4;
 * spec design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891). Proves the §III provenance mapping, the §V permission
 * copy, and — the load-bearing rule — the FAIL-CLOSED submit-result → outcome
 * mapping (§IV: a fingerprint conflict / settled gate is a BLOCK, never a silent
 * success). No React / DB — every seam is plain data.
 */
import { describe, expect, it } from "vitest";

import type { ReviewTargetMount } from "@/lib/artifacts/artifact-review-preparation";
import type {
  SubmitDecisionError,
  SubmitDecisionResult,
} from "@/lib/artifacts/artifact-review-decision";
import {
  mapSubmitResultToOutcome,
  mapChangesRequestedToOutcome,
  reviewBlockedCopy,
  reviewDecideDisabledReason,
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTypeLabel,
  REVIEW_DISPOSITIONS,
} from "../review-surface-model";
import type { RecordChangesRequestedResult } from "@cinatra-ai/agents/lifecycle-review-changes-requested";

const buildMap: ReviewTargetMount = {
  kind: "build-map",
  slot: "detail",
  packageName: "@cinatra-ai/email",
  generatedKey: "@cinatra-ai/email::detail",
};
const runtime: ReviewTargetMount = {
  kind: "runtime",
  slot: "detail",
  packageName: "@acme/support",
  // Only .kind/.slot/.packageName are read by the model; a minimal descriptor
  // stands in for the (unused) runtime tuple.
  descriptor: { tuple: { digest: "d".repeat(64) } },
} as ReviewTargetMount;
const floor: ReviewTargetMount = {
  kind: "floor",
  slot: "detail",
  packageName: "@acme/support",
  reason: "requires-rebuild",
};

describe("§III — provenance conformance id from the OPAQUE mount kind", () => {
  it("build-map → native, runtime → marketplace, floor → generic-floor anchor", () => {
    expect(reviewProvenanceConformanceId(buildMap)).toBe("review-provenance-native");
    expect(reviewProvenanceConformanceId(runtime)).toBe("review-provenance-marketplace");
    expect(reviewProvenanceConformanceId(floor)).toBe("review-target-floor");
  });

  it("provenance label kind + package identity for a runtime; 'Floor' for a floor", () => {
    expect(reviewProvenanceLabel(buildMap).kind).toBe("build-time");
    expect(reviewProvenanceLabel(runtime)).toMatchObject({ kind: "runtime", packageName: "@acme/support" });
    expect(reviewProvenanceLabel(floor).kind).toBe("floor");
  });
});

describe("§II — the immutable header projections", () => {
  it("prettifies an object-type id into a short type label", () => {
    expect(reviewTypeLabel("@cinatra-ai/email:draft")).toBe("Email");
    expect(reviewTypeLabel("@acme/support-desk:case")).toBe("Support Desk");
    expect(reviewTypeLabel("plain")).toBe("Plain");
  });

  it("truncates a long revision id for display, preserving the exact id", () => {
    const m = reviewRevisionMarker("rev_0123456789abcdef");
    expect(m.full).toBe("rev_0123456789abcdef");
    expect(m.short.endsWith("…")).toBe(true);
    expect(reviewRevisionMarker("rev_short").short).toBe("rev_short");
  });
});

describe("§V — permission copy + blocked copy", () => {
  it("no disabled reason when the reviewer may decide", () => {
    expect(reviewDecideDisabledReason({ canDecide: true, canComment: true })).toBeNull();
  });
  it("a comment-only reviewer sees the terminal-needs-approve reason", () => {
    const reason = reviewDecideDisabledReason({ canDecide: false, canComment: true });
    expect(reason).toMatch(/approve access/);
    expect(reason).toMatch(/Comment/);
  });
  it("a reviewer with neither sees the no-approve-access reason", () => {
    expect(reviewDecideDisabledReason({ canDecide: false, canComment: false })).toMatch(/approve access/);
  });
  it("blocked copy covers every closed reason", () => {
    expect(reviewBlockedCopy("no-longer-pending").title).toMatch(/no longer open/);
    expect(reviewBlockedCopy("targets-mismatch").title).toMatch(/out of date/);
    expect(reviewBlockedCopy("revision-not-live").title).toMatch(/no longer live/);
  });
});

describe("§IV — the disposition set is exactly three (no 'request changes')", () => {
  it("approve / reject / comment only", () => {
    expect([...REVIEW_DISPOSITIONS].sort()).toEqual(["approve", "comment", "reject"]);
  });
});

describe("§IV/§V — FAIL-CLOSED submit-result → visible outcome", () => {
  const ok = (idempotent: boolean): SubmitDecisionResult => ({
    ok: true,
    idempotent,
    fingerprint: "fp",
    plan: null,
  });
  const err = (error: SubmitDecisionError): SubmitDecisionResult => ({ ok: false, error });

  it("an approved commit → decided(approve); idempotent flag carried", () => {
    expect(mapSubmitResultToOutcome(ok(false), "approve")).toEqual({
      kind: "decided",
      disposition: "approve",
      idempotent: false,
    });
    expect(mapSubmitResultToOutcome(ok(true), "reject")).toEqual({
      kind: "decided",
      disposition: "reject",
      idempotent: true,
    });
  });

  it("a committed comment → annotated (non-terminal, gate stays pending)", () => {
    expect(mapSubmitResultToOutcome(ok(false), "comment")).toEqual({ kind: "annotated" });
  });

  it("a fingerprint conflict is a BLOCK, never a silent success", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "gate-conflict" }), "approve")).toEqual({
      kind: "blocked",
      reason: "no-longer-pending",
    });
  });

  it("a settled / moved-on gate blocks", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "gate-not-pending" }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "no-longer-pending",
    });
  });

  it("a substituted / incomplete target set is a hard block (targets-mismatch)", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "target-substitution", substituted: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
    expect(mapSubmitResultToOutcome(err({ kind: "incomplete-coverage", missing: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
  });

  it("a vanished revision blocks as revision-not-live", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "revision-not-member", targets: [] }), "approve")).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
  });

  it("a run-access denial disables (not-permitted), never a block/success", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "run-access-denied", status: 403 }), "reject")).toMatchObject({
      kind: "not-permitted",
    });
  });

  it("a transient (invalid / commit-failed) is a retryable error, not a block", () => {
    expect(mapSubmitResultToOutcome(err({ kind: "invalid-decision", message: "x" }), "approve")).toMatchObject({
      kind: "error",
    });
    expect(mapSubmitResultToOutcome(err({ kind: "commit-failed", message: "db" }), "approve")).toMatchObject({
      kind: "error",
    });
  });
});

// ---------------------------------------------------------------------------
// The LIFECYCLE prompt-window path (cinatra#2063; owner ruling 2026-07-25):
// mapChangesRequestedToOutcome maps the S2 recordChangesRequested store result to
// the surface outcome — a committed request is `changes-requested`; every failure
// reuses the SAME fail-closed blocked/error states as the base decision (never a
// silent success on a settled gate).
// ---------------------------------------------------------------------------

describe("mapChangesRequestedToOutcome — lifecycle prompt-window path (§IV/§V fail-closed)", () => {
  const ok = (
    over: Partial<Extract<RecordChangesRequestedResult, { ok: true }>> = {},
  ): RecordChangesRequestedResult => ({
    ok: true,
    repairId: "rep-1",
    route: { kind: "producer_repair", continuationMode: "async_effects_gated" },
    attempt: 1,
    status: "requested",
    idempotent: false,
    ...over,
  });
  const fail = (code: string): RecordChangesRequestedResult => ({ ok: false, code, error: code });

  it("a repair-capable producer's request is `changes-requested` (requested, gate resolved into a repair)", () => {
    expect(mapChangesRequestedToOutcome(ok())).toEqual({
      kind: "changes-requested",
      status: "requested",
      idempotent: false,
    });
  });

  it("an escalated request (non-repairing / cycle bound) is `changes-requested` (escalated)", () => {
    expect(mapChangesRequestedToOutcome(ok({ status: "escalated" }))).toMatchObject({
      kind: "changes-requested",
      status: "escalated",
    });
  });

  it("a response-lost idempotent re-drive carries idempotent:true", () => {
    expect(mapChangesRequestedToOutcome(ok({ idempotent: true }))).toMatchObject({
      kind: "changes-requested",
      idempotent: true,
    });
  });

  it("FAIL-CLOSED: a settled / conflicting / non-lifecycle gate is a BLOCK (no-longer-pending), never a silent success", () => {
    for (const code of ["gate-conflict", "gate-not-pending", "not-a-lifecycle-gate"]) {
      expect(mapChangesRequestedToOutcome(fail(code))).toMatchObject({
        kind: "blocked",
        reason: "no-longer-pending",
      });
    }
  });

  it("a tombstoned / moved base blocks as revision-not-live (the review no longer applies)", () => {
    expect(mapChangesRequestedToOutcome(fail("tombstoned-base"))).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
    expect(mapChangesRequestedToOutcome(fail("stale-base"))).toMatchObject({
      kind: "blocked",
      reason: "revision-not-live",
    });
  });

  it("a mismatched pinned set blocks as targets-mismatch", () => {
    expect(mapChangesRequestedToOutcome(fail("targets-mismatch"))).toMatchObject({
      kind: "blocked",
      reason: "targets-mismatch",
    });
  });

  it("any other failure (invalid-request / idempotency-key-reuse / empty-feedback) is a retryable error", () => {
    for (const code of ["invalid-request", "idempotency-key-reuse", "empty-feedback"]) {
      expect(mapChangesRequestedToOutcome(fail(code))).toMatchObject({ kind: "error" });
    }
  });
});
