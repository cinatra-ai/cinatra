/**
 * cinatra#2906 × cinatra#2824 §V — the mark a settled chip carries after a
 * Confirm, composed over the two pure halves a real decision runs through: the
 * offered-set derivation that writes the selection row, and the settled reading
 * that turns the run's durable evidence back into one mark per chip.
 *
 * Neither half is wrong on its own, which is why this composition earns its own
 * file: the derivation decides a SELECTION SOURCE and the reading decides a
 * MARK, and the defect this covers lived in the join between them — a source
 * that means "the reader shaped this one" recorded for a press that shaped
 * nothing.
 *
 * The held-turn flow asserts exactly this chain on a real runtime after its
 * Confirm press (`tests/e2e/chat-hitl-held-turn/held-turn.spec.ts` — the card's
 * chip marks read `["confirmed"]`). Composing the halves here states the same
 * fact without a browser, so the join is covered by the unit tier too.
 */
import { describe, it, expect } from "vitest";

import { deriveSelectionFromOfferedSet } from "@cinatra-ai/skills/recommendation";
import { decidedSkillsFromEvidence } from "@/lib/run-selected-skill-revisions";

/**
 * The card's offer: ONE chip, scored BELOW `recommendThreshold`. The row draws
 * every candidate and marks which of them it recommends, so this chip is drawn,
 * is offered, and carries its own Confirm — exactly the shape the held-turn
 * flow's single assigned skill takes.
 */
const OFFER = [
  { skillId: "@vendor/pkg:only-skill", skillRevisionId: "rev-1", recommended: false, rank: 1 },
];
const KEPT = OFFER.map((o) => o.skillId);

/** Press the row, then read the settled row's marks back off the evidence. */
function marksAfterPress(adjustedSkillIds?: string[]): string[] {
  const derived = deriveSelectionFromOfferedSet({
    offered: OFFER,
    confirmedSkillIds: KEPT,
    ...(adjustedSkillIds ? { adjustedSkillIds } : {}),
    honourableSkillIds: KEPT,
  });
  if (!derived.ok) throw new Error(`the confirm refused: ${derived.staleSkillIds.join(", ")}`);
  return decidedSkillsFromEvidence(derived.selection, []).map((d) => d.mark);
}

describe("the mark a settled chip carries after a decision (cinatra#2824 §V)", () => {
  it("reads `confirmed` for a chip pressed with CONFIRM, whatever it scored", () => {
    expect(marksAfterPress()).toEqual(["confirmed"]);
  });

  it("reads `adjusted` only for a chip settled through ADJUST", () => {
    expect(marksAfterPress(KEPT)).toEqual(["adjusted"]);
  });
});
