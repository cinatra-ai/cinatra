/**
 * NOTHING STANDS BETWEEN THE READER AND THE FORM (cinatra#3174 fix leg 3).
 *
 * The ratified drawing's section VI: "One card, five readings, and never a
 * second card … No summary box is ever drawn, no status label, and nothing
 * stands between the reader and the form — the rows are the reading."
 *
 * The second graded proof round measured a three-bullet schedule summary —
 * schedule, timezone, agent — above the configured card. It is not drawn by any
 * renderer in this tree (the card's own suite asserts the card draws no summary
 * node, and the platform's start sentence is one line): it is the assistant's
 * own prose, so the product's lever is the instruction the producer tool
 * carries. This pins that the lever is actually there and says the right thing.
 *
 *   pnpm exec vitest run \
 *     src/lib/lifecycle/__tests__/schedule-card-is-the-whole-reading-3193-fix3.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD,
  SCHEDULE_PROPOSAL_TOOL_META,
} from "../schedule-proposal-mcp";

describe("the producer tool tells the model the card is the whole reading", () => {
  it("carries the rule in the description the model actually reads", () => {
    expect(SCHEDULE_PROPOSAL_TOOL_META.description).toContain(
      SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD,
    );
  });

  it("names each thing the graded summary restated, so none of them reads as allowed", () => {
    for (const word of ["schedule", "timezone", "agent", "recurrence"]) {
      expect(SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD).toContain(word);
    }
    expect(SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD).toContain("no summary");
    expect(SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD).toContain(
      "the rows are the reading",
    );
  });

  it("still says what the tool does — the rule is added, not substituted", () => {
    expect(SCHEDULE_PROPOSAL_TOOL_META.description).toContain("PROPOSE a schedule");
    expect(SCHEDULE_PROPOSAL_TOOL_META.description).toContain("Creates NOTHING");
  });
});
