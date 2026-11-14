// cinatra#4390 — the one-card gate's row for the schedule card names the
// Confirm control by the value §VI draws on both undecided floors
// (`specs/app-lifecycle-cards.html`, design@06230d4e8de397e86e3216199342d15c0b4fc5a6):
// `data-action="confirm-schedule -> scheduled"`.

import { describe, expect, it } from "vitest";

import { carriageRowFor } from "../held-turn-card-contract";

describe("cinatra#4390: the held-turn carriage row names the drawn Confirm", () => {
  it("trigger_schedule_proposal.decisionControls is the drawn selector alone", () => {
    expect([...carriageRowFor("trigger_schedule_proposal").decisionControls]).toEqual([
      '[data-action="confirm-schedule -> scheduled"]',
    ]);
  });
});
