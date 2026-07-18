/**
 * WayFlow review-REJECTION semantics (cinatra#1795, epic #1620 S12, item 6).
 * Pins the load-bearing invariant: a reject payload is STRUCTURALLY DISTINCT from
 * an approve payload and can never read as an approval nor ride the approve wire.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION,
  buildReviewApproveEnvelope,
  buildReviewRejectEnvelope,
  buildReviewResumeText,
  payloadAssertsApproval,
} from "../artifact-review-rejection";

const targets = [{ artifactId: "a", representationRevisionId: "1" }];

describe("buildReviewApproveEnvelope", () => {
  it("carries the approval marker + the typed review block", () => {
    const env = buildReviewApproveEnvelope({ reviewTaskId: "wayflow-t", comment: "ok", targets });
    expect(env.approved).toBe(true);
    expect(env.review).toEqual({
      envelopeVersion: ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION,
      decision: "approved",
      reviewTaskId: "wayflow-t",
      comment: "ok",
      targets: [{ artifactId: "a", representationRevisionId: "1" }],
    });
  });
});

describe("buildReviewRejectEnvelope", () => {
  it("has NO `approved` key and decision === rejected", () => {
    const env = buildReviewRejectEnvelope({ reviewTaskId: "wayflow-t", comment: null, targets });
    expect("approved" in env).toBe(false);
    expect(env.review.decision).toBe("rejected");
  });

  it("only pins the immutable {artifactId, representationRevisionId} pair per target", () => {
    const env = buildReviewRejectEnvelope({
      reviewTaskId: "wayflow-t",
      comment: null,
      // extra fields on the input must not leak into the envelope target.
      targets: [{ artifactId: "a", representationRevisionId: "1", digest: "x" } as never],
    });
    expect(env.review.targets).toEqual([{ artifactId: "a", representationRevisionId: "1" }]);
  });
});

describe("buildReviewResumeText — discriminated so reject cannot ride the approve wire", () => {
  it("approve → { kind: approve, userResponse }", () => {
    const r = buildReviewResumeText({ disposition: "approve", reviewTaskId: "wayflow-t", comment: null, targets });
    expect(r.kind).toBe("approve");
    if (r.kind !== "approve") throw new Error("unreachable");
    expect(payloadAssertsApproval(JSON.parse(r.userResponse))).toBe(true);
  });

  it("reject → { kind: reject, rejectResponse } — a DIFFERENT field name", () => {
    const r = buildReviewResumeText({ disposition: "reject", reviewTaskId: "wayflow-t", comment: null, targets });
    expect(r.kind).toBe("reject");
    if (r.kind !== "reject") throw new Error("unreachable");
    // The reject text is not under `userResponse` (the approve send's field), and
    // it never asserts approval.
    expect((r as Record<string, unknown>).userResponse).toBeUndefined();
    const parsed = JSON.parse(r.rejectResponse);
    expect(payloadAssertsApproval(parsed)).toBe(false);
    expect("approved" in parsed).toBe(false);
  });
});

describe("payloadAssertsApproval", () => {
  it("true for an approve envelope, false for a reject envelope", () => {
    expect(payloadAssertsApproval(buildReviewApproveEnvelope({ reviewTaskId: "t", comment: null, targets }))).toBe(true);
    expect(payloadAssertsApproval(buildReviewRejectEnvelope({ reviewTaskId: "t", comment: null, targets }))).toBe(false);
  });

  it("false for non-objects and legacy plain text", () => {
    expect(payloadAssertsApproval(null)).toBe(false);
    expect(payloadAssertsApproval("[Approved by operator]")).toBe(false);
    expect(payloadAssertsApproval({ approved: "true" })).toBe(false); // string, not boolean
  });
});
