/**
 * WHERE THE UNREACHED SKILLS ENTRY SITS (cinatra#3221 item 3, fix leg 7).
 *
 * The ratified drawing, the review surface, section II — "The Skills step, the
 * first entry on the rail": "WHERE a run begins by recommending the skills it
 * proposes to use, that question is the run's first gate — the first entry on
 * the step rail, where it is named Skills, ahead of the work steps it would
 * authorize." Section I fixes the other half: "The step the run is paused on is
 * highlighted; steps already passed sit above it, steps still to come below."
 *
 * WHAT THE THIRD PROOF ROUND MEASURED, at the scheduling reading: the elected
 * Schedule step with an UNREACHED Skills entry drawn above it — a still-to-come
 * row standing where the drawing puts the run's history, and above the entry the
 * reader is standing on.
 *
 * The row is pinned to the head by `instance-screens`, and this pins the rule
 * that decides whether it is drawn there at all.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-rail-skills-entry-placement.test.ts
 */
import { describe, it, expect } from "vitest";

import { upcomingSkillsEntryHeadsTheRail } from "../instance-screens";

describe("the unreached Skills entry heads the rail only while the run has not passed it", () => {
  it("heads an EMPTY rail — the run has drawn nothing it could stand after", () => {
    expect(upcomingSkillsEntryHeadsTheRail([])).toBe(true);
  });

  it("heads the rail above the run's own input form (cinatra#3047 fix leg 8)", () => {
    // The case the head placement was written for: an input form is one of "the
    // work steps it would authorize", and the Skills entry stands above it.
    expect(
      upcomingSkillsEntryHeadsTheRail([{ key: "input:0", reached: true }]),
    ).toBe(true);
  });

  it("is NOT drawn once the rail carries the schedule the run reached", () => {
    // The scheduling reading the proof round photographed.
    expect(
      upcomingSkillsEntryHeadsTheRail([
        { key: "input:0", reached: true },
        { key: "schedule" },
      ]),
    ).toBe(false);
  });

  it("is NOT drawn once the rail carries the gate the run is stopped at", () => {
    expect(
      upcomingSkillsEntryHeadsTheRail([
        { key: "input:0", reached: true },
        { key: "gate", reached: true },
      ]),
    ).toBe(false);
  });

  it("still heads the rail above a LATER gate the run has not reached", () => {
    // A forecast row for a gate still ahead is not the run standing past the
    // skills question — it is the rest of the lifecycle drawn below.
    expect(
      upcomingSkillsEntryHeadsTheRail([
        { key: "input:0", reached: true },
        { key: "review", reached: false },
      ]),
    ).toBe(true);
  });
});
