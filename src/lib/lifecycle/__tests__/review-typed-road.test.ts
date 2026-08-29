/**
 * THE TYPED ROAD (cinatra#3080 acceptance item 6) — the words a person types
 * beside a review, and what the platform does with each one.
 *
 * A unit test per word, against the two pure functions the road is made of: what
 * the card LENDS (`controlsLentBy`) and which control a SENTENCE gets
 * (`typedControlFor`). The end-to-end refusal through the six gates of the lent
 * action is in `lent-action-mcp.test.ts`.
 *
 * "continue" performs the former approve transition; "approve" stays a
 * compatibility alias of it; "reject" settles nothing and answers that there is
 * no reject.
 */
import { describe, expect, it } from "vitest";

import { REVIEW_REJECT_RETIRED_REASON } from "@/lib/artifacts/review-surface-model";
import { controlsLentBy, typedControlFor } from "../bound-reference-resolver";

const REVIEW = {
  kind: "review" as const,
  runId: "run_1",
  reviewTaskId: "gate_1",
  pinnedTargets: [{ artifactId: "art_1", representationRevisionId: "rev_1" }],
};
const SCREEN = { kind: "hitl_screen" as const } as never;
const ABSENT = { kind: "absent" as const } as never;

describe("what a review card lends", () => {
  it("lends its own three buttons — Comment, Regenerate and Continue", () => {
    expect([...controlsLentBy(REVIEW as never)]).toEqual(["comment", "regenerate", "continue"]);
  });

  it("lends neither approve nor reject as a control of its own", () => {
    const lent = controlsLentBy(REVIEW as never);
    expect(lent).not.toContain("reject");
    expect(lent).not.toContain("approve");
  });

  it("a card that offers no decision lends none", () => {
    expect([...controlsLentBy(SCREEN)]).toEqual(["submit"]);
    expect([...controlsLentBy(ABSENT)]).toEqual([]);
  });
});

describe("which control a typed sentence gets", () => {
  it('"continue" asks for Continue — the former approve transition', () => {
    expect(typedControlFor(REVIEW as never, "continue")).toEqual({
      kind: "control",
      control: "continue",
    });
  });

  it('"approve" asks for the same thing — a compatibility alias', () => {
    expect(typedControlFor(REVIEW as never, "Approve.")).toEqual({
      kind: "control",
      control: "continue",
    });
  });

  it('"reject" asks for nothing and carries the platform\'s answer', () => {
    const asked = typedControlFor(REVIEW as never, "reject");
    expect(asked).toEqual({ kind: "retired", reason: REVIEW_REJECT_RETIRED_REASON });
  });

  it('"regenerate" asks for Regenerate', () => {
    expect(typedControlFor(REVIEW as never, "regenerate")).toEqual({
      kind: "control",
      control: "regenerate",
    });
  });

  it("an ordinary sentence is filed as a Comment, exactly as it always has been", () => {
    expect(typedControlFor(REVIEW as never, "tighten the opening paragraph")).toEqual({
      kind: "control",
      control: "comment",
    });
  });

  it("a WAITING SCREEN still mints nothing for a sentence", () => {
    expect(typedControlFor(SCREEN, "continue")).toEqual({ kind: "none" });
    expect(typedControlFor(ABSENT, "continue")).toEqual({ kind: "none" });
  });
});
