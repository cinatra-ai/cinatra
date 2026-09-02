// ---------------------------------------------------------------------------
// THE LINE OVER A ONE-OFF THAT HAS ALREADY FIRED (cinatra#3044).
// ---------------------------------------------------------------------------
// The wait correction beside this file answers a run standing AT its schedule.
// This one answers the reading after it. The tenth graded set measured the
// sentence frozen into the turn at dispatch still standing over a spent
// schedule -- "The run is queued and will start on its own." on a run that had
// already run, with the run's own identifier and status printed beside it --
// while the ratified drawing's section VI gives that reading its own line and
// draws it as the assistant's whole sentence:
//
//   "It ran at the time you set. A one-time schedule is spent once it fires, so
//    the rows below are the record of it and cannot be changed."
//
// Two things are pinned here and both are load-bearing:
//
//   1. THE WORDS ARE THE DRAWING'S, BYTE FOR BYTE, and the dispatch head goes
//      with them: over a spent schedule the subject is the schedule, not the
//      run, so a head naming the package, the run and a status is not a
//      shortened truth, it is the retired tense said again.
//   2. IT REACHES ONLY THE PLATFORM'S OWN SENTENCE, only for the run it was
//      given, and it is idempotent -- the same three properties the wait
//      correction is held to, because a correction that could reach arbitrary
//      text would be a second author of the turn.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/run-start-fired-sentence-3053.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  RUN_START_QUEUED_CLAUSE,
  RUN_START_SCHEDULE_FIRED_SENTENCE,
  RUN_START_SCHEDULE_WAIT_CLAUSE,
  correctRunStartSentenceForFiredSchedule,
  correctRunStartSentenceForScheduleWait,
  describeStartedRun,
} from "../run-status";

const RUN = {
  packageName: "@cinatra-ai/blog-draft-writer-agent",
  runId: "b6c2b0f4-52a3-4d7e-9c31-7a2b1f0e5d84",
};

/** The drawing's own words, quoted from section VI's fired example. */
const DRAWN =
  "It ran at the time you set. A one-time schedule is spent once it fires, " +
  "so the rows below are the record of it and cannot be changed.";

describe("the sentence over a fired one-off follows the drawing", () => {
  it("is the drawing's line, byte for byte", () => {
    expect(RUN_START_SCHEDULE_FIRED_SENTENCE).toBe(DRAWN);
  });

  it("replaces the queued claim the pictures caught over a spent schedule", () => {
    const dispatched = describeStartedRun({ ...RUN, status: "queued" });
    // The sentence the turn was frozen with, and the untruth in it.
    expect(dispatched).toContain(RUN_START_QUEUED_CLAUSE);

    const corrected = correctRunStartSentenceForFiredSchedule({
      text: dispatched,
      runId: RUN.runId,
    });
    expect(corrected).toBe(DRAWN);
    expect(corrected).not.toContain("queued");
    // The chrome the drawing does not give goes with the head it rode on.
    expect(corrected).not.toContain(RUN.runId);
    expect(corrected).not.toContain("status:");
    expect(corrected).not.toContain(RUN.packageName);
  });

  it("corrects a sentence that was ALREADY corrected to the wait", () => {
    // The ordinary live order: the card was pending, the line was corrected to
    // the wait, and then the schedule fired under the reader.
    const waiting = correctRunStartSentenceForScheduleWait({
      text: describeStartedRun({ ...RUN, status: "queued" }),
      runId: RUN.runId,
    });
    expect(waiting).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    expect(
      correctRunStartSentenceForFiredSchedule({ text: waiting, runId: RUN.runId }),
    ).toBe(DRAWN);
  });

  it("corrects the sentence inside the prose a turn really carries", () => {
    const turn = [
      "I have started that for you.",
      "",
      describeStartedRun({ ...RUN, status: "queued" }),
      "",
      "I will report back when it is done.",
    ].join("\n");
    const corrected = correctRunStartSentenceForFiredSchedule({
      text: turn,
      runId: RUN.runId,
    });
    expect(corrected).toContain(DRAWN);
    expect(corrected).toContain("I have started that for you.");
    expect(corrected).toContain("I will report back when it is done.");
    expect(corrected).not.toContain(RUN_START_QUEUED_CLAUSE);
  });

  it("is IDEMPOTENT — a corrected turn re-read is unchanged", () => {
    const once = correctRunStartSentenceForFiredSchedule({
      text: describeStartedRun({ ...RUN, status: "queued" }),
      runId: RUN.runId,
    });
    expect(correctRunStartSentenceForFiredSchedule({ text: once, runId: RUN.runId })).toBe(once);
  });

  it("leaves the WAIT correction nothing to do once it has run", () => {
    // The two corrections cannot compose into one line: the replacement carries
    // no dispatch head, so the wait's own pattern no longer matches it.
    const fired = correctRunStartSentenceForFiredSchedule({
      text: describeStartedRun({ ...RUN, status: "queued" }),
      runId: RUN.runId,
    });
    expect(correctRunStartSentenceForScheduleWait({ text: fired, runId: RUN.runId })).toBe(fired);
  });

  it("touches NOTHING it was not given the run for", () => {
    const someoneElse = describeStartedRun({
      packageName: "@cinatra-ai/other-agent",
      runId: "0f4c9a71-3e58-46b2-8d0a-91c7b2e46f3d",
      status: "queued",
    });
    expect(
      correctRunStartSentenceForFiredSchedule({ text: someoneElse, runId: RUN.runId }),
    ).toBe(someoneElse);

    const prose = "The schedule fired earlier and the run is queued and will start on its own.";
    expect(correctRunStartSentenceForFiredSchedule({ text: prose, runId: RUN.runId })).toBe(prose);
  });

  it("also corrects the bare sentence a door minted with no status token", () => {
    const bare = `Dispatched \`${RUN.packageName}\` (runId: \`${RUN.runId}\`).`;
    expect(correctRunStartSentenceForFiredSchedule({ text: bare, runId: RUN.runId })).toBe(DRAWN);
  });

  it("leaves a clause-less sentence QUOTED inside prose alone", () => {
    const quoted =
      `I said "Dispatched \`${RUN.packageName}\` (runId: \`${RUN.runId}\`)." earlier.`;
    expect(correctRunStartSentenceForFiredSchedule({ text: quoted, runId: RUN.runId })).toBe(
      quoted,
    );
  });
});
