/**
 * Unit tests for the recipients-review passthrough seam shaper (cinatra#1960):
 *   src/app/api/agents/passthrough/recipients-review-seam.ts
 *
 * The recipients analogue of ./drafts-review-passthrough-seam.test.ts. The seam
 * is FAIL-CLOSED: an unparseable / unrecognized / wrong-typed payload THROWS
 * (shaper-throw → HTTP 400, the apply ApiNode fails visibly). The operative field
 * is `removedRecipients` (the operator's EXPLICIT removals) — the primitive's
 * non-destructive semantics make an empty batch a benign no-op, so the failure
 * mode is a corrupt/unrecognized envelope, not accidental deletion.
 */
import { describe, it, expect } from "vitest";
import {
  shapeRecipientsReviewResumeInput,
  unwrapRecipientsResumePayload,
  isRecipientsReviewFailureResult,
} from "@/app/api/agents/passthrough/recipients-review-seam";

describe("shapeRecipientsReviewResumeInput", () => {
  it("projects the operator's removedRecipients[] + the kept approvedRecipientIds from a valid payload", () => {
    const payload = {
      campaignId: "c1",
      approvedRecipientIds: ["r1"],
      edited: true,
      removedRecipients: [{ id: "r2", contactId: "r2", accountId: "a2", recipientEmail: "b@x.com" }],
    };
    const shaped = shapeRecipientsReviewResumeInput({ resumePayloadJson: JSON.stringify(payload) });
    expect(shaped).toEqual({
      removedRecipients: [{ id: "r2", contactId: "r2", accountId: "a2", recipientEmail: "b@x.com" }],
      approvedRecipientIds: ["r1"],
    });
  });

  it("preserves an intentionally-empty removal batch (valid payload, removedRecipients: []) — a clean approval", () => {
    const shaped = shapeRecipientsReviewResumeInput({
      resumePayloadJson: JSON.stringify({ approvedRecipientIds: ["r1"], removedRecipients: [] }),
    });
    expect(shaped).toEqual({ removedRecipients: [], approvedRecipientIds: ["r1"] });
  });

  it("defaults approvedRecipientIds to [] when the payload omits it (legacy/degenerate)", () => {
    const shaped = shapeRecipientsReviewResumeInput({
      resumePayloadJson: JSON.stringify({ removedRecipients: [{ contactId: "r1" }] }),
    });
    expect(shaped).toEqual({ removedRecipients: [{ contactId: "r1" }], approvedRecipientIds: [] });
  });

  it("unwraps the canonical attachment envelope and reads the nested `text` payload", () => {
    const inner = { removedRecipients: [{ contactId: "r1" }], approvedRecipientIds: ["k1"] };
    const envelope = { text: JSON.stringify(inner), attachments: [{ name: "f.pdf" }] };
    const shaped = shapeRecipientsReviewResumeInput({ resumePayloadJson: JSON.stringify(envelope) });
    expect(shaped).toEqual({ removedRecipients: [{ contactId: "r1" }], approvedRecipientIds: ["k1"] });
  });

  it("THROWS on an absent resumePayloadJson (a wiring fault, not an empty approval)", () => {
    expect(() => shapeRecipientsReviewResumeInput({})).toThrow(/resumePayloadJson is required/);
  });

  it("THROWS on unparseable JSON rather than degrading to an empty set", () => {
    expect(() =>
      shapeRecipientsReviewResumeInput({ resumePayloadJson: "{not json" }),
    ).toThrow(/not valid JSON/);
  });

  it("THROWS when the payload is not an object (e.g. a bare array)", () => {
    expect(() =>
      shapeRecipientsReviewResumeInput({ resumePayloadJson: JSON.stringify([1, 2, 3]) }),
    ).toThrow(/did not resolve to a recipients-review resume payload object/);
  });

  it("THROWS when `removedRecipients` is present but not an array", () => {
    expect(() =>
      shapeRecipientsReviewResumeInput({ resumePayloadJson: JSON.stringify({ removedRecipients: "nope" }) }),
    ).toThrow(/`removedRecipients` must be a present array/);
  });

  it("THROWS when `removedRecipients` is ABSENT rather than coercing to an empty batch (fail-closed)", () => {
    // A valid object payload that simply LACKS a `removedRecipients` key is an
    // unrecognized envelope (a wiring/tamper fault) — it must NOT be coerced.
    expect(() =>
      shapeRecipientsReviewResumeInput({
        resumePayloadJson: JSON.stringify({ campaignId: "c1", approvedRecipientIds: ["r1"] }),
      }),
    ).toThrow(/`removedRecipients` must be a present array/);
  });

  it("THROWS when the wrapped envelope's `text` is not valid JSON", () => {
    const envelope = { text: "{not json", attachments: [{ name: "f.pdf" }] };
    expect(() =>
      shapeRecipientsReviewResumeInput({ resumePayloadJson: JSON.stringify(envelope) }),
    ).toThrow(/wrapped resume envelope's `text` payload is not valid JSON/);
  });
});

describe("unwrapRecipientsResumePayload", () => {
  it("passes through a valid object payload verbatim", () => {
    const obj = { campaignId: "c1", removedRecipients: [] };
    expect(unwrapRecipientsResumePayload(JSON.stringify(obj))).toEqual(obj);
  });

  it("does NOT unwrap a `text` field without an attachments array (not the envelope)", () => {
    const obj = { text: "hello", removedRecipients: [{ contactId: "r1" }] };
    expect(unwrapRecipientsResumePayload(JSON.stringify(obj))).toEqual(obj);
  });
});

describe("isRecipientsReviewFailureResult (gate #2 — 422-vs-2xx decision)", () => {
  it("flags an { error } envelope as a failure (→ non-2xx)", () => {
    expect(isRecipientsReviewFailureResult({ error: "no recipients bundle object" })).toBe(true);
  });

  it("flags an explicit ok:false as a failure (→ non-2xx)", () => {
    expect(isRecipientsReviewFailureResult({ ok: false, reason: "x" })).toBe(true);
  });

  it("does NOT flag a success (ok:true with reviewed outputs → stays 2xx)", () => {
    expect(
      isRecipientsReviewFailureResult({ ok: true, matched: 1, removed: 0, reviewedRecipients: [], reviewedCount: 0 }),
    ).toBe(false);
  });

  it("does NOT flag non-object / array / null results", () => {
    expect(isRecipientsReviewFailureResult(null)).toBe(false);
    expect(isRecipientsReviewFailureResult("nope")).toBe(false);
    expect(isRecipientsReviewFailureResult([{ error: "x" }])).toBe(false);
  });
});
