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
  reviewSettledCopy,
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTypeLabel,
  REVIEW_DISPOSITIONS,
} from "../review-surface-model";
import type { RecordChangesRequestedResult } from "@cinatra-ai/agents/lifecycle-review-changes-requested";
import { LIFECYCLE_SETTLED_OUTCOMES } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const form: ReviewTargetMount = {
  kind: "form",
  slot: "detail",
  arm: "first-party",
  form: "markdown",
};

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

  // cinatra#2931 W4 — the maintainer's answer of 2026-08-23 (Q1): the built-in
  // markdown / plain-text rendering carries NO label above the reviewed work.
  // §V of the pinned review spec draws a provenance strip for the two renderer
  // tiers a PACKAGE supplies and for the floor; the host's own text rendering is
  // none of those three, and it is not given a fourth strip — it is given none.
  // The reviewer sees the draft, and nothing above the draft.
  it("the form rung has NO provenance region at all — no fourth strip, no reused one", () => {
    expect(reviewProvenanceConformanceId(form)).toBeNull();
  });

  it("provenance label kind + package identity for a runtime; 'Floor' for a floor", () => {
    expect(reviewProvenanceLabel(buildMap)).toMatchObject({ kind: "build-time" });
    expect(reviewProvenanceLabel(runtime)).toMatchObject({ kind: "runtime", packageName: "@acme/support" });
    expect(reviewProvenanceLabel(floor)).toMatchObject({ kind: "floor" });
  });

  it("the form rung has no provenance label to print", () => {
    expect(reviewProvenanceLabel(form)).toBeNull();
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

// ---------------------------------------------------------------------------
// §IV — the SETTLED reading (cinatra#2855; plan §4.2)
// ---------------------------------------------------------------------------

describe("the settled copy names the outcome and its decider", () => {
  it("is keyed on the SAME closed set the wire carries", () => {
    // This model deliberately keeps its own local union rather than importing
    // the wire type, so the two are pinned together HERE. A value added on one
    // side and not the other fails this, in front of the switch that would
    // otherwise fall through to nothing.
    const covered = [...LIFECYCLE_SETTLED_OUTCOMES].map((outcome) =>
      reviewSettledCopy(outcome),
    );
    expect(covered).toHaveLength(3);
    for (const copy of covered) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  it("names the decider when there is one to name", () => {
    expect(reviewSettledCopy("approved", "Dana Okonkwo")).toEqual({
      title: "Approved by Dana Okonkwo",
      body: "The gate is resolved and the run has been released to continue.",
    });
    expect(reviewSettledCopy("rejected", "Dana Okonkwo").title).toBe(
      "Rejected by Dana Okonkwo",
    );
    expect(reviewSettledCopy("changes_requested", "Dana Okonkwo").title).toBe(
      "Changes requested by Dana Okonkwo",
    );
  });

  it("reads as a finished sentence with no decider at all", () => {
    // The resolver drops a decider it cannot name safely, so the copy must not
    // depend on one: never "Approved by" and a dangling nothing.
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      const { title } = reviewSettledCopy(outcome);
      expect(title.endsWith(" by")).toBe(false);
      expect(title.includes(" by ")).toBe(false);
    }
    expect(reviewSettledCopy("approved").title).toBe("Approved");
    expect(reviewSettledCopy("rejected").title).toBe("Rejected");
    expect(reviewSettledCopy("changes_requested").title).toBe("Changes requested");
  });

  it("does NOT claim a live repair the way the post-press notice does", () => {
    // The decision bar's `requested` line says "a repair is now in flight" — a
    // fact about what the reviewer's own press started. A settled card has not
    // read that, so it may not assert it.
    expect(reviewSettledCopy("changes_requested").body).toBe(
      "The gate is resolved and the reviewed work has been turned back for repair.",
    );
    expect(reviewSettledCopy("changes_requested").body).not.toContain("in flight");
  });

  it("is a DIFFERENT reading from the generic blocked copy it replaces", () => {
    // The generic sentence survives — for a settled card with no outcome — and
    // the two must not converge into one vague line.
    const generic = reviewBlockedCopy("no-longer-pending");
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      expect(reviewSettledCopy(outcome).title).not.toBe(generic.title);
      expect(reviewSettledCopy(outcome).body).not.toBe(generic.body);
    }
    expect(generic.title).toBe("This review is no longer open");
  });
});
