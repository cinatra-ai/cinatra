/**
 * THE TWO `run_card` SCHEDULE ADAPTERS ARE EXCLUSIVE (cinatra#3004).
 *
 * One renderer of the schedule, two adapters for the run's own host: the run
 * detail opens it as a step in its rail, and the run's schedule tab is the form
 * on its own. They can never draw together, because a run is one screen at a
 * time — and `runScheduleAdapterFor` is where that is decided, in code, rather
 * than being inferred from two mounts sitting in one file.
 *
 * Read off the exported picker, so the rule holds independently of the DB, the
 * session and the Next.js render machinery.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schedule-run-card-adapters-3004.test.ts
 */
import { describe, expect, it } from "vitest";

import { runScheduleAdapterFor } from "../instance-screens";

const SCREENS = ["run_detail", "schedule_tab"] as const;

const TRIGGERS: Array<{ triggerType: string } | null> = [
  null,
  { triggerType: "immediate" },
  { triggerType: "scheduled" },
  { triggerType: "recurring" },
  { triggerType: "webhook" },
];

describe("runScheduleAdapterFor", () => {
  it("answers exactly one adapter for every screen and trigger shape — the two run_card schedule adapters are never both chosen", () => {
    for (const trigger of TRIGGERS) {
      const answers = SCREENS.map((screen) =>
        runScheduleAdapterFor({ screen, trigger }),
      );
      // Every shape gets a decided answer, on every screen.
      for (const answer of answers) {
        expect(["rail_step", "schedule_tab", "none"]).toContain(answer);
      }
      // And the two screens never name the SAME adapter, so no run can carry
      // two rendered instances of the card on one host.
      const drawn = answers.filter((answer) => answer !== "none");
      expect(new Set(drawn).size).toBe(drawn.length);
      // Read straight off the picker, per screen, so the branch each screen
      // takes is named in the expectation rather than only in a collected list.
      expect(runScheduleAdapterFor({ screen: "run_detail", trigger })).not.toBe(
        "schedule_tab",
      );
      expect(runScheduleAdapterFor({ screen: "schedule_tab", trigger })).not.toBe(
        "rail_step",
      );
    }
  });

  it("draws the schedule tab's form for exactly the rows that surface exists for", () => {
    expect(
      runScheduleAdapterFor({ screen: "schedule_tab", trigger: { triggerType: "recurring" } }),
    ).toBe("schedule_tab");
    expect(
      runScheduleAdapterFor({ screen: "schedule_tab", trigger: { triggerType: "scheduled" } }),
    ).toBe("schedule_tab");
    // **Run right after setup** names no moment to open a schedule onto, and a
    // kind nobody has defined a surface for is refused by default.
    expect(
      runScheduleAdapterFor({ screen: "schedule_tab", trigger: { triggerType: "immediate" } }),
    ).toBe("none");
    expect(
      runScheduleAdapterFor({ screen: "schedule_tab", trigger: { triggerType: "webhook" } }),
    ).toBe("none");
    expect(runScheduleAdapterFor({ screen: "schedule_tab", trigger: null })).toBe("none");
  });

  it("leaves the run detail's rail step exactly as it was — every run with a row, and no other", () => {
    for (const trigger of TRIGGERS.filter((t) => t !== null)) {
      expect(runScheduleAdapterFor({ screen: "run_detail", trigger })).toBe("rail_step");
    }
    expect(runScheduleAdapterFor({ screen: "run_detail", trigger: null })).toBe("none");
  });
});
