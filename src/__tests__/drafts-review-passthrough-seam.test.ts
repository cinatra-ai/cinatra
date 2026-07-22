/**
 * Unit tests for the drafts-review passthrough seam shaper (cinatra#1959):
 *   src/app/api/agents/passthrough/drafts-review-seam.ts
 *
 * Covers codex nit #2's request for malformed / attachment-wrapped input
 * coverage on the resume-payload seam. The seam is FAIL-CLOSED: an
 * unparseable / unrecognized / wrong-typed payload THROWS (shaper-throw →
 * HTTP 400, the apply ApiNode fails visibly) rather than degrading to an empty
 * edit set that would silently discard the operator's approved drafts.
 */
import { describe, it, expect } from "vitest";
import {
  shapeDraftsReviewResumeInput,
  unwrapDraftsResumePayload,
  isDraftsReviewFailureResult,
} from "@/app/api/agents/passthrough/drafts-review-seam";

describe("shapeDraftsReviewResumeInput", () => {
  it("projects the per-recipient drafts[] from a valid payload", () => {
    const payload = {
      campaignId: "c1",
      approvedDraftIds: ["d1"],
      edited: true,
      editedIds: ["d1"],
      drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B" }],
    };
    const shaped = shapeDraftsReviewResumeInput({ resumePayloadJson: JSON.stringify(payload) });
    expect(shaped).toEqual({
      drafts: [{ id: "d1", recipientEmail: "a@x.com", subject: "NEW", body: "B" }],
    });
  });

  it("preserves an intentionally-empty reviewed set (valid payload, drafts: [])", () => {
    const shaped = shapeDraftsReviewResumeInput({
      resumePayloadJson: JSON.stringify({ approvedDraftIds: [], drafts: [] }),
    });
    expect(shaped).toEqual({ drafts: [] });
  });

  it("unwraps the canonical attachment envelope and reads the nested `text` payload", () => {
    const inner = { drafts: [{ id: "d1", subject: "S", body: "B" }] };
    const envelope = { text: JSON.stringify(inner), attachments: [{ name: "f.pdf" }] };
    const shaped = shapeDraftsReviewResumeInput({ resumePayloadJson: JSON.stringify(envelope) });
    expect(shaped).toEqual({ drafts: [{ id: "d1", subject: "S", body: "B" }] });
  });

  it("THROWS on an absent resumePayloadJson (a wiring fault, not an empty approval)", () => {
    expect(() => shapeDraftsReviewResumeInput({})).toThrow(/resumePayloadJson is required/);
  });

  it("THROWS on unparseable JSON rather than degrading to an empty edit set", () => {
    expect(() =>
      shapeDraftsReviewResumeInput({ resumePayloadJson: "{not json" }),
    ).toThrow(/not valid JSON/);
  });

  it("THROWS when the payload is not an object (e.g. a bare array)", () => {
    expect(() =>
      shapeDraftsReviewResumeInput({ resumePayloadJson: JSON.stringify([1, 2, 3]) }),
    ).toThrow(/did not resolve to a drafts-review resume payload object/);
  });

  it("THROWS when `drafts` is present but not an array", () => {
    expect(() =>
      shapeDraftsReviewResumeInput({ resumePayloadJson: JSON.stringify({ drafts: "nope" }) }),
    ).toThrow(/`drafts` must be a present array/);
  });

  it("THROWS when `drafts` is ABSENT rather than degrading to an empty edit set (fail-closed)", () => {
    // A valid object payload that simply LACKS a `drafts` key is unrecognized —
    // it must NOT become { drafts: [] } and silently drop the approval.
    expect(() =>
      shapeDraftsReviewResumeInput({
        resumePayloadJson: JSON.stringify({ campaignId: "c1", approvedDraftIds: ["d1"] }),
      }),
    ).toThrow(/`drafts` must be a present array/);
  });

  it("THROWS when the wrapped envelope's `text` is not valid JSON", () => {
    const envelope = { text: "{not json", attachments: [{ name: "f.pdf" }] };
    expect(() =>
      shapeDraftsReviewResumeInput({ resumePayloadJson: JSON.stringify(envelope) }),
    ).toThrow(/wrapped resume envelope's `text` payload is not valid JSON/);
  });
});

describe("unwrapDraftsResumePayload", () => {
  it("passes through a valid object payload verbatim", () => {
    const obj = { campaignId: "c1", drafts: [] };
    expect(unwrapDraftsResumePayload(JSON.stringify(obj))).toEqual(obj);
  });

  it("does NOT unwrap a `text` field without an attachments array (not the envelope)", () => {
    // A plain payload that happens to carry a string `text` field is NOT the
    // attachment envelope (no attachments[]), so it is used as-is.
    const obj = { text: "hello", drafts: [{ id: "d1" }] };
    expect(unwrapDraftsResumePayload(JSON.stringify(obj))).toEqual(obj);
  });
});

describe("isDraftsReviewFailureResult (gate #2 — 422-vs-2xx decision)", () => {
  it("flags an { error } envelope as a failure (→ non-2xx)", () => {
    expect(isDraftsReviewFailureResult({ error: "no draft-bundle object" })).toBe(true);
  });

  it("flags an explicit ok:false as a failure (→ non-2xx)", () => {
    expect(isDraftsReviewFailureResult({ ok: false, reason: "x" })).toBe(true);
  });

  it("does NOT flag a success (ok:true with reviewed outputs → stays 2xx)", () => {
    expect(
      isDraftsReviewFailureResult({ ok: true, matched: 1, updated: 1, reviewedBundle: {}, reviewedDocument: "d" }),
    ).toBe(false);
  });

  it("does NOT flag non-object / array / null results", () => {
    expect(isDraftsReviewFailureResult(null)).toBe(false);
    expect(isDraftsReviewFailureResult("nope")).toBe(false);
    expect(isDraftsReviewFailureResult([{ error: "x" }])).toBe(false);
  });
});
