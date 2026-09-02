/**
 * THE SCHEDULE CARD'S TURN, AS THE RATIFIED DRAWING WRITES IT (cinatra#3174,
 * fix leg 1 after the first graded proof round).
 *
 * TWO SENTENCES THE FIRST ROUND GRADED FALSE, and both are pinned here.
 *
 * 1. THE WAIT LINE IS PROSE. Section VI draws the schedule card's turn with the
 *    assistant speaking in plain words over the rows — "Schedule proposal is
 *    ready. Confirm it on the card below and I will arm it; change the rows
 *    first if it is not right." — and the section's own rule for the card is
 *    that "The card is the scheduling step, in the turn — and it is the only
 *    thing drawn." No example in that section carries a package chip or a run
 *    token. The graded frame drew a Dispatched head with two monospace code
 *    chips ahead of the clause, which is the head this pins gone.
 *
 *    The dispatch head stays on every OTHER reading: section V's recommendation
 *    card draws it verbatim, so this is a narrowing to the one reading section
 *    VI draws, never a rewrite of the line.
 *
 * 2. THE CHAIN STILL REACHES THE FIRED READING. The wait line and the fired
 *    one-off's line are a chain: a turn corrected to the wait is corrected
 *    again when the one-off fires. The wait line used to keep the run id so the
 *    second pass could find it. With the head gone the second pass has to find
 *    a standing clause instead, and it must refuse where a turn carries more
 *    than one — a correction that rewrote the wrong run's line would be a
 *    second author of the turn.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schedule-turn-per-drawing-3193-fix1.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  RUN_START_SCHEDULE_FIRED_SENTENCE,
  RUN_START_SCHEDULE_WAIT_CLAUSE,
  correctRunStartSentenceForFiredSchedule,
  correctRunStartSentenceForScheduleWait,
  describeStartedRun,
  runHasActuallyRun,
} from "../run-status";

const STARTED = {
  packageName: "@cinatra-ai/blog-idea-generator",
  runId: "789345b6-9883-4b1a-ada5-cc463d696d21",
};

const WAITING = ["armed", "pending_trigger"] as const;

describe("the schedule-wait line is the prose section VI draws, and nothing else", () => {
  it("carries NO monospace chip — no backtick survives in the line", () => {
    for (const status of WAITING) {
      const line = describeStartedRun({ ...STARTED, status, moment: "schedule" });
      expect(line).not.toContain("`");
    }
  });

  it("carries NO run token — neither the word nor the id itself", () => {
    for (const status of WAITING) {
      const line = describeStartedRun({ ...STARTED, status, moment: "schedule" });
      expect(line).not.toContain("runId");
      expect(line).not.toContain(STARTED.runId);
      expect(line).not.toContain(STARTED.packageName);
      expect(line).not.toContain("Dispatched");
    }
  });

  it("pins the whole sentence, so the head cannot grow back", () => {
    for (const status of WAITING) {
      expect(describeStartedRun({ ...STARTED, status, moment: "schedule" })).toBe(
        RUN_START_SCHEDULE_WAIT_CLAUSE,
      );
    }
  });

  it("leaves every reading the drawing keeps the head on exactly as it was", () => {
    for (const status of ["queued", "pending_input", "pending_trigger", "running", "failed"]) {
      const line = describeStartedRun({ ...STARTED, status });
      expect(line).toContain("runId: `" + STARTED.runId + "`");
      expect(line).toContain("status: `" + status + "`");
    }
  });
});

describe("the correction chain still reaches the fired reading over a headless wait line", () => {
  it("corrects the dispatch line to the prose wait line, and is idempotent", () => {
    const turn = describeStartedRun({ ...STARTED, status: "queued" });
    const once = correctRunStartSentenceForScheduleWait({ text: turn, runId: STARTED.runId });
    expect(once).toBe(RUN_START_SCHEDULE_WAIT_CLAUSE);
    expect(correctRunStartSentenceForScheduleWait({ text: once, runId: STARTED.runId })).toBe(once);
  });

  it("replaces a STANDING wait line when the one-off fires", () => {
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: RUN_START_SCHEDULE_WAIT_CLAUSE,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId],
      }),
    ).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE);
  });

  it("REFUSES the headless line where the turn is drawing a SECOND schedule run", () => {
    // The corruption the convergence round found: the caller applies this
    // correction for every fired run against every text part, so a fired run
    // whose own sentence lives in another part would reach into the part
    // holding a run that is STILL WAITING and tell the reader it has run.
    const other = "5f1b8f6c-2c31-4a1f-9d1e-3c9a7c2f0b44";
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: RUN_START_SCHEDULE_WAIT_CLAUSE,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId, other],
      }),
    ).toBe(RUN_START_SCHEDULE_WAIT_CLAUSE);
  });

  it("REFUSES the headless line where the caller cannot name the turn's schedule runs", () => {
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: RUN_START_SCHEDULE_WAIT_CLAUSE,
        runId: STARTED.runId,
      }),
    ).toBe(RUN_START_SCHEDULE_WAIT_CLAUSE);
  });

  it("the keyed road is untouched by that refusal — a line naming its run is still corrected", () => {
    const turn = describeStartedRun({ ...STARTED, status: "queued" });
    const other = "5f1b8f6c-2c31-4a1f-9d1e-3c9a7c2f0b44";
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: turn,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId, other],
      }),
    ).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE);
  });

  it("does not fire twice: a corrected sentence beside another run's standing line is left alone", () => {
    const other = "5f1b8f6c-2c31-4a1f-9d1e-3c9a7c2f0b44";
    const turn = RUN_START_SCHEDULE_FIRED_SENTENCE + "\n\n" + RUN_START_SCHEDULE_WAIT_CLAUSE;
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: turn,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId, other],
      }),
    ).toBe(turn);
  });

  it("still corrects a turn that never reached the wait reading", () => {
    const turn = describeStartedRun({ ...STARTED, status: "queued" });
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: turn,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId],
      }),
    ).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE);
  });

  it("REFUSES where the turn carries two standing wait lines — it cannot tell them apart", () => {
    const two = RUN_START_SCHEDULE_WAIT_CLAUSE + "\n\n" + RUN_START_SCHEDULE_WAIT_CLAUSE;
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: two,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId],
      }),
    ).toBe(two);
  });

  it("corrects EVERY standing line once every schedule run in the turn has fired", () => {
    // THE OTHER HALF OF THE REFUSAL (converge round). Refusing while a second
    // run is still waiting is right; refusing FOREVER is not, and a corrected
    // line carries no run id for the keyed road to find later — so a turn whose
    // schedule runs have all fired would have gone on saying that runs which
    // have all started have not. Where they have all fired the clauses do not
    // need telling apart: the drawing gives every one of them this sentence.
    const other = "5f1b8f6c-2c31-4a1f-9d1e-3c9a7c2f0b44";
    const two = RUN_START_SCHEDULE_WAIT_CLAUSE + "\n\n" + RUN_START_SCHEDULE_WAIT_CLAUSE;
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: two,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId, other],
        firedScheduleRunIds: [STARTED.runId, other],
      }),
    ).toBe(RUN_START_SCHEDULE_FIRED_SENTENCE + "\n\n" + RUN_START_SCHEDULE_FIRED_SENTENCE);
  });

  it("and still refuses while ONE of the turn's schedule runs is still waiting", () => {
    const other = "5f1b8f6c-2c31-4a1f-9d1e-3c9a7c2f0b44";
    const two = RUN_START_SCHEDULE_WAIT_CLAUSE + "\n\n" + RUN_START_SCHEDULE_WAIT_CLAUSE;
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: two,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId, other],
        firedScheduleRunIds: [STARTED.runId],
      }),
    ).toBe(two);
  });

  it("leaves a QUOTED wait clause alone — it does not own its line", () => {
    const quoted = 'The card says "' + RUN_START_SCHEDULE_WAIT_CLAUSE + '" and nothing else.';
    expect(
      correctRunStartSentenceForFiredSchedule({
        text: quoted,
        runId: STARTED.runId,
        scheduleRunIds: [STARTED.runId],
      }),
    ).toBe(quoted);
  });
});

describe("a run that never ran has not run — the durable record, read directly", () => {
  it("a FAILED run with no start stamp never ran", () => {
    // The exact row the first proof round graded: the gate was released, the
    // task failed, and the run never started.
    expect(runHasActuallyRun({ status: "failed", startedAt: null })).toBe(false);
  });

  it("a run standing at its schedule has not run", () => {
    for (const status of ["armed", "pending_trigger", "queued", "pending_input"]) {
      expect(runHasActuallyRun({ status, startedAt: null })).toBe(false);
    }
  });

  it("a start stamp is the record, whatever the status became afterwards", () => {
    expect(runHasActuallyRun({ status: "failed", startedAt: new Date() })).toBe(true);
    expect(runHasActuallyRun({ status: "stopped", startedAt: new Date() })).toBe(true);
  });

  it("a status only execution can reach is the record too", () => {
    for (const status of ["running", "waiting_trigger", "completed"]) {
      expect(runHasActuallyRun({ status, startedAt: null })).toBe(true);
    }
  });

  it("no run at all is not a run that ran", () => {
    expect(runHasActuallyRun(null)).toBe(false);
    expect(runHasActuallyRun(undefined)).toBe(false);
  });
});
