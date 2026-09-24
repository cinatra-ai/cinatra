/**
 * THE REVIEW FLOOR — Comment · Regenerate · Continue (cinatra#3080, epic #3023).
 *
 * The pure vocabulary every review surface draws from, and the typed road the
 * chat resolves a person's words through. Ratified drawings: the review and
 * cards specifications at the revision the conformance suite pins.
 *
 * Reject is RETIRED here, at the vocabulary, so no surface can offer it and no
 * word can ask for it; the negative test at the decision operation itself lives
 * in `artifact-review-decision.test.ts`.
 */
import { describe, it, expect } from "vitest";

import {
  REVIEW_FLOOR_ACTIONS,
  REVIEW_FLOOR_LABELS,
  REVIEW_REJECT_RETIRED_REASON,
  REGENERATE_NEEDS_A_NOTE,
  REGENERATE_MULTI_TARGET_REASON,
  floorActionDisposition,
  floorActionRunAccessOp,
  resolveReviewFloorSubmission,
  resolveTypedReviewWord,
  reviewPicturePrompt,
} from "@/lib/artifacts/review-surface-model";

describe("acceptance item 1 — the floor is exactly three actions", () => {
  it("offers Comment, Regenerate and Continue, in that order, and nothing else", () => {
    expect([...REVIEW_FLOOR_ACTIONS]).toEqual(["comment", "regenerate", "continue"]);
    expect(REVIEW_FLOOR_ACTIONS.map((a) => REVIEW_FLOOR_LABELS[a])).toEqual([
      "Comment",
      "Regenerate",
      "Continue",
    ]);
  });

  it("draws neither Reject nor Approve", () => {
    const labels = REVIEW_FLOOR_ACTIONS.map((a) => REVIEW_FLOOR_LABELS[a]);
    expect(labels).not.toContain("Reject");
    expect(labels).not.toContain("Approve");
  });
});

describe("acceptance item 2 — Continue is the former approve; reject is retired", () => {
  it("Continue stores the disposition `approve` (no migration)", () => {
    expect(floorActionDisposition("continue")).toBe("approve");
  });

  it("Comment stores the disposition `comment`", () => {
    expect(floorActionDisposition("comment")).toBe("comment");
  });

  it("Regenerate carries NO gate disposition — it rides the change road", () => {
    expect(floorActionDisposition("regenerate")).toBeNull();
  });

  it("`approve` is accepted as a compatibility alias of Continue", () => {
    expect(resolveReviewFloorSubmission("approve")).toEqual({
      kind: "action",
      action: "continue",
      alias: true,
    });
  });

  it("`continue` is the canonical submission and is not an alias", () => {
    expect(resolveReviewFloorSubmission("continue")).toEqual({
      kind: "action",
      action: "continue",
      alias: false,
    });
  });

  it("`reject` is refused with a stated reason, never mapped to an action", () => {
    const resolved = resolveReviewFloorSubmission("reject");
    expect(resolved.kind).toBe("retired");
    if (resolved.kind !== "retired") throw new Error("unreachable");
    expect(resolved.reason).toBe(REVIEW_REJECT_RETIRED_REASON);
    expect(resolved.reason.toLowerCase()).toContain("no reject");
  });
});

describe("acceptance item 4 — Regenerate needs the right a terminal decision needs", () => {
  it("Regenerate and Continue both need approve access; Comment needs respond access", () => {
    expect(floorActionRunAccessOp("regenerate")).toBe("approveHitl");
    expect(floorActionRunAccessOp("continue")).toBe("approveHitl");
    expect(floorActionRunAccessOp("comment")).toBe("respondToHitl");
  });

  it("names its refusals rather than failing silently", () => {
    expect(REGENERATE_NEEDS_A_NOTE.length).toBeGreaterThan(0);
    expect(REGENERATE_MULTI_TARGET_REASON.length).toBeGreaterThan(0);
  });
});

describe("acceptance item 6 — the typed road, a test per word", () => {
  it('"continue" performs the former approve transition', () => {
    expect(resolveTypedReviewWord("continue")).toEqual({
      kind: "action",
      action: "continue",
      alias: false,
    });
  });

  it('"approve" stays a compatibility alias of "continue"', () => {
    expect(resolveTypedReviewWord("Approve.")).toEqual({
      kind: "action",
      action: "continue",
      alias: true,
    });
  });

  it('"reject" settles nothing and answers that there is no reject', () => {
    const resolved = resolveTypedReviewWord("reject");
    expect(resolved.kind).toBe("retired");
    if (resolved.kind !== "retired") throw new Error("unreachable");
    expect(resolved.reason).toBe(REVIEW_REJECT_RETIRED_REASON);
  });

  it('"regenerate" and "comment" are the other two words the floor answers to', () => {
    expect(resolveTypedReviewWord("regenerate")).toMatchObject({ action: "regenerate" });
    expect(resolveTypedReviewWord("comment")).toMatchObject({ action: "comment" });
  });

  it("an unrelated sentence is not a floor word", () => {
    expect(resolveTypedReviewWord("what does this do?")).toEqual({ kind: "unknown" });
  });
});

describe("acceptance item 5 — the picture prompt is its own value", () => {
  it("reads the recorded prompt off the reviewed revision's ledger row", () => {
    expect(reviewPicturePrompt({ properties: { imagePrompt: "a red bicycle" } })).toBe(
      "a red bicycle",
    );
  });

  it("is absent when the ledger row records no prompt", () => {
    expect(reviewPicturePrompt({ properties: {} })).toBeNull();
    expect(reviewPicturePrompt({ properties: null })).toBeNull();
    expect(reviewPicturePrompt({ properties: { imagePrompt: "   " } })).toBeNull();
    expect(reviewPicturePrompt({ properties: { imagePrompt: 7 } })).toBeNull();
  });

  it("asks NOTHING about the artifact's type, mime or renderer (G1-clean)", () => {
    // The surface may not key on identity. A revision that records a prompt has
    // one to show; nothing here sniffs an `image/` mime to decide that, which is
    // both the artifact-UI boundary's rule and the more truthful question.
    //
    // Read off the FUNCTION rather than the file: the surface model legitimately
    // knows about mounts and mimes elsewhere, and a whole-file assertion would
    // be about the wrong thing.
    const code = reviewPicturePrompt.toString();
    expect(code).not.toMatch(/image\//);
    expect(code).not.toMatch(/\bmime\b/);
    expect(code).not.toMatch(/objectType|rendererId/);
  });
});
