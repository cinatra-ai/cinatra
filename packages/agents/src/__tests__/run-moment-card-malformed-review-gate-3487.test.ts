/**
 * A MALFORMED REVIEW GATE ON THE RUN ROW (cinatra#3487, unit T, case 1).
 *
 * `parseRunMomentCard` reads the run row's `reviewGate` so a conversation's
 * container can ask the run panel's own question (`runMomentCardDrawsAReview`)
 * without a second request. The route sends `{ ref: string | null, awaiting:
 * boolean }`; anything else on that field is a shape the route does not send.
 *
 * WHAT IS PINNED HERE: such a shape never throws, never invents a review, and
 * never masks the rest of the row. A finished run whose gate field is not the
 * route's shape answers "draws no review", on every host, which is the
 * container's fail-closed reading; and on each shape below the panel's own
 * slot parser (`parseRunReviewSlot`) comes to the same answer, so the
 * container and the panel cannot disagree about one run.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-moment-card-malformed-review-gate-3487.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  parseRunMomentCard,
  parseRunReviewSlot,
  runMomentCardDrawsAReview,
} from "../lifecycle-card-runtime";

const finishedRow = {
  id: "run-unit-t",
  status: "completed",
  lifecycleMoment: null,
  lifecycleCard: null,
};

/** Gate fields that are not the route's shape, each with no usable ref and no awaiting flag. */
const MALFORMED_GATES: Array<[string, unknown]> = [
  ["a bare string", "gate-ref"],
  ["a number", 42],
  ["the value true", true],
  ["an array", ["gate-ref"]],
  ["an empty object", {}],
  ["a numeric ref", { ref: 42, awaiting: false }],
  ["an empty ref", { ref: "", awaiting: false }],
  ["an object ref", { ref: { value: "gate-ref" }, awaiting: false }],
  ["a null ref and no awaiting field", { ref: null }],
  ["null", null],
];

const HOSTS = ["chat_thread", "site_widget", "run_card", "page_gate_region", null] as const;

describe("3487 unit T (1): a malformed review gate given to parseRunMomentCard", () => {
  it.each(MALFORMED_GATES)(
    "%s: parses without throwing, reads no review and draws none on any host",
    (_label, reviewGate) => {
      const parse = () => parseRunMomentCard({ ...finishedRow, reviewGate });
      expect(parse).not.toThrow();
      const card = parse();
      expect(card).not.toBeNull();
      expect(card!.status).toBe("completed");
      expect(card!.reviewRef).toBeNull();
      expect(card!.reviewAwaiting).toBe(false);
      for (const host of HOSTS) {
        expect(runMomentCardDrawsAReview(card!, host)).toBe(false);
      }
    },
  );

  it.each(MALFORMED_GATES)(
    "%s: the panel's own slot parser reads no review either",
    (_label, reviewGate) => {
      const slot = parseRunReviewSlot({ ...finishedRow, reviewGate });
      expect(slot === null || (slot.ref === null && slot.awaiting === false)).toBe(true);
    },
  );

  it("a malformed gate does not mask the rest of the row", () => {
    const card = parseRunMomentCard({
      id: "run-unit-t",
      status: "running",
      lifecycleMoment: "setup",
      lifecycleCard: { kind: "setup_form", ref: "card-ref" },
      reviewGate: { ref: 42, awaiting: "later" },
    });
    expect(card).toEqual({
      status: "running",
      moment: "setup",
      kind: "setup_form",
      ref: "card-ref",
      reviewRef: null,
      reviewAwaiting: false,
    });
  });

  it("a well-formed ref is still read when the awaiting flag beside it is malformed", () => {
    const row = { ...finishedRow, reviewGate: { ref: "gate-ref", awaiting: { not: "a boolean" } } };
    const card = parseRunMomentCard(row)!;
    expect(card.reviewRef).toBe("gate-ref");
    expect(runMomentCardDrawsAReview(card, "chat_thread")).toBe(true);
    expect(parseRunReviewSlot(row)?.ref).toBe("gate-ref");
  });

  it("a well-formed gate on a row with no status is still no answer at all", () => {
    expect(
      parseRunMomentCard({ id: "run-unit-t", reviewGate: { ref: "gate-ref", awaiting: true } }),
    ).toBeNull();
    expect(
      parseRunMomentCard({ id: "run-unit-t", status: "", reviewGate: { ref: "gate-ref" } }),
    ).toBeNull();
  });
});
