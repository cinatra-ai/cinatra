// THE CARRIAGE RECORD'S TWO AXES (cinatra#2930, epic #2926 W3).
//
// The plan: "`LIFECYCLE_CARD_CARRIAGE` becomes per kind
// `{ canonical: run_state, represent: data_part }` for the run-carried kinds,
// with `trigger_schedule_proposal` canonical `data_part` while held and
// `run_state` once confirmed."
//
// What is pinned here is that the two axes are independent and that adding the
// canonical one did not move the wire one — the derived membership every other
// consumer reads must be byte-identical to what it was before this wave.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_INTERRUPT_KINDS,
  LIFECYCLE_MOMENTS,
  LIFECYCLE_MOMENT_CARD_KIND,
  LIFECYCLE_RUN_CARRIED_KINDS,
  canonicalCarriageForKind,
  isRunCarriedLifecycleKind,
} from "../renderable-views/lifecycle-cards";

describe("the lifecycle carriage record", () => {
  it("states BOTH axes for every kind — where the truth lives, and how it reaches a transcript", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = LIFECYCLE_CARD_CARRIAGE[kind];
      expect(["run_state", "data_part"]).toContain(row.canonical);
      expect(["data_part", "interrupt"]).toContain(row.represent);
    }
  });

  it("makes every RUN-CARRIED kind's truth the run's own row", () => {
    // Four of the five. A card mounted from run state is a card no model can
    // withhold, which is the whole claim the injection makes.
    expect([...LIFECYCLE_RUN_CARRIED_KINDS].sort()).toEqual([
      "agent_hitl_screen",
      "artifact_review_gate",
      "recommendation_hold",
      "verification_summary",
    ]);
  });

  it("keeps the HELD schedule canonical in the turn, and moves it to the run once confirmed", () => {
    // "the held schedule … is the person's own instruction read back to them, so
    // it is the one card that arrives through the assistant's own turn rather
    // than from a run's state; it never enters the run outbox, because there is
    // no run."
    expect(canonicalCarriageForKind("trigger_schedule_proposal")).toBe("data_part");
    expect(
      canonicalCarriageForKind("trigger_schedule_proposal", { scheduleConfirmed: false }),
    ).toBe("data_part");
    expect(
      canonicalCarriageForKind("trigger_schedule_proposal", { scheduleConfirmed: true }),
    ).toBe("run_state");
    expect(isRunCarriedLifecycleKind("trigger_schedule_proposal")).toBe(false);
    expect(
      isRunCarriedLifecycleKind("trigger_schedule_proposal", { scheduleConfirmed: true }),
    ).toBe(true);
  });

  it("reads the confirm flag for the SCHEDULE only — no other kind's canonical carriage moves", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      if (kind === "trigger_schedule_proposal") continue;
      expect(canonicalCarriageForKind(kind, { scheduleConfirmed: true })).toBe(
        canonicalCarriageForKind(kind),
      );
    }
  });

  it("did NOT move the wire axis: the derived membership is exactly what it was", () => {
    // The two lists below are read by the resolve route, the resolve-envelope
    // registry, the interrupt registry, the host-parity ratchet and the widget
    // carriage suite. Adding an axis must not have added a resolve envelope to a
    // kind the run wire never mints one for.
    expect([...LIFECYCLE_DATA_PART_VIEW_TYPES].sort()).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
    expect([...LIFECYCLE_INTERRUPT_KINDS].sort()).toEqual([
      "agent_hitl_screen",
      "recommendation_hold",
    ]);
  });

  it("gives every moment a card whose carriage is stated", () => {
    for (const moment of LIFECYCLE_MOMENTS) {
      const kind = LIFECYCLE_MOMENT_CARD_KIND[moment];
      expect(LIFECYCLE_CARD_CARRIAGE[kind]).toBeDefined();
    }
  });
});
