// ---------------------------------------------------------------------------
// THE TURN MAY NOT CONTRADICT THE CARD BENEATH IT (cinatra#3044).
// ---------------------------------------------------------------------------
// The defect this file pins, in the words the graded capture recorded it in:
// the assistant's sentence read "Dispatched `…` (runId: `…`, status: `queued`).
// The run started." while the card directly beneath it was still asking "When
// should this run?" and offering Confirm, and the run's row read
// `pending_trigger`. One turn, two readings, and the one a person reads first
// is the false one.
//
// Two properties are asserted, and they are the two halves of one wording:
//
//   1. A START THAT ALREADY KNOWS THE RUN IS WAITING says so — and says
//      neither "started" nor "queued", because neither is true of a run
//      standing at a schedule it has not been given yet.
//   2. A SENTENCE ALREADY MINTED IS CORRECTED AT THE CARD, because the ordinary
//      dispatch cannot know: the schedule moment opens in the executor, after
//      the setup card's own Continue, long after this sentence was frozen into
//      the turn. The correction produces the SAME bytes the start would have
//      minted had it known — one wording, reached by two roads.
//
// A run that truly starts keeps the sentence it always had; that is asserted
// here too, because a fix that made every start read "waiting" would satisfy
// the grade and lie in the other direction.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/run-start-schedule-wait-3044.test.ts
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  PRE_EXECUTION_RUN_STATUSES,
  RUN_START_PARKED_CLAUSE,
  RUN_START_SCHEDULE_WAIT_CLAUSE,
  RUN_START_STARTED_CLAUSE,
  correctRunStartSentenceForScheduleWait,
  describeStartedRun,
  runIsWaitingForItsSchedule,
} from "../run-status";

const RUN = {
  packageName: "@cinatra-ai/blog-idea-generator-agent",
  runId: "2315b02a-cda3-488c-ad1f-a634dce702b6",
};

/** The exact sentence the graded capture read above a pending schedule card. */
const THE_SENTENCE_IN_THE_PICTURES = describeStartedRun({ ...RUN, status: "queued" });

describe("the start's own sentence for a run that parks at its schedule", () => {
  it("says the run WAITS, and says neither `started` nor `queued`", () => {
    const parked = describeStartedRun({
      ...RUN,
      status: "pending_trigger",
      moment: "schedule",
    });

    expect(parked).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    expect(parked).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(parked).not.toContain(RUN_START_PARKED_CLAUSE);
    // The status token itself is the other half of the contradiction the
    // pictures caught, so it is not printed at all over a pending card.
    expect(parked).not.toContain("status:");
    expect(parked).not.toContain("queued");
    // It is still the line that names the run beside the card.
    expect(parked).toContain(RUN.packageName);
    expect(parked).toContain(RUN.runId);
  });

  it("a run that TRULY starts still says so — the fix does not lie the other way", () => {
    for (const status of ["queued", "running", "completed", "failed", "stopped"]) {
      const report = describeStartedRun({ ...RUN, status });
      expect(report).toContain(RUN_START_STARTED_CLAUSE);
      expect(report).toContain(`status: \`${status}\``);
      expect(report).not.toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    }
    // And the recommendation hold keeps its own clause.
    expect(describeStartedRun({ ...RUN, status: "pending_input" })).toContain(
      RUN_START_PARKED_CLAUSE,
    );
  });

  it("holds for the WHOLE wait — a confirmed schedule is armed, not started", () => {
    for (const status of PRE_EXECUTION_RUN_STATUSES) {
      expect(
        describeStartedRun({ ...RUN, status, moment: "schedule" }),
      ).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    }
  });

  it("is NOT claimed for a `pending_trigger` reached for another reason", () => {
    // The immediate-trigger release road leaves a run `pending_trigger` with no
    // lifecycle moment at all; there is no card beneath that turn, and the
    // sentence it already had is the true one.
    expect(runIsWaitingForItsSchedule({ status: "pending_trigger", moment: null })).toBe(false);
    expect(describeStartedRun({ ...RUN, status: "pending_trigger" })).toContain(
      RUN_START_STARTED_CLAUSE,
    );
    // A run that has moved PAST its schedule is not waiting at one either.
    expect(runIsWaitingForItsSchedule({ status: "running", moment: "schedule" })).toBe(false);
    expect(runIsWaitingForItsSchedule({ status: null, moment: "schedule" })).toBe(false);
  });
});

describe("the frozen sentence, corrected at the card", () => {
  it("replaces the contradiction the pictures caught with the wait", () => {
    const corrected = correctRunStartSentenceForScheduleWait({
      text: THE_SENTENCE_IN_THE_PICTURES,
      runId: RUN.runId,
    });

    expect(THE_SENTENCE_IN_THE_PICTURES).toContain("status: `queued`");
    expect(THE_SENTENCE_IN_THE_PICTURES).toContain(RUN_START_STARTED_CLAUSE);
    expect(corrected).not.toContain("The run started.");
    expect(corrected).not.toContain("queued");
    expect(corrected).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
  });

  it("reaches the SAME bytes the start would have minted had it known", () => {
    expect(
      correctRunStartSentenceForScheduleWait({
        text: THE_SENTENCE_IN_THE_PICTURES,
        runId: RUN.runId,
      }),
    ).toBe(describeStartedRun({ ...RUN, status: "pending_trigger", moment: "schedule" }));
  });

  it("corrects the sentence inside the prose a turn really carries", () => {
    const turn =
      `Starting that for you now.\n\n${THE_SENTENCE_IN_THE_PICTURES}\n\nAnything else?`;
    const corrected = correctRunStartSentenceForScheduleWait({ text: turn, runId: RUN.runId });

    expect(corrected.startsWith("Starting that for you now.")).toBe(true);
    expect(corrected.endsWith("Anything else?")).toBe(true);
    expect(corrected).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    expect(corrected).not.toContain(RUN_START_STARTED_CLAUSE);
  });

  it("is IDEMPOTENT — a corrected turn re-read is unchanged", () => {
    const once = correctRunStartSentenceForScheduleWait({
      text: THE_SENTENCE_IN_THE_PICTURES,
      runId: RUN.runId,
    });
    const twice = correctRunStartSentenceForScheduleWait({ text: once, runId: RUN.runId });
    expect(twice).toBe(once);
  });

  it("touches NOTHING it was not given the run for", () => {
    const otherRun = "9f6a1c60-4b0e-4a2f-9a6d-2b7f2d1c5e88";
    const someoneElse = describeStartedRun({ ...RUN, runId: otherRun, status: "queued" });
    expect(
      correctRunStartSentenceForScheduleWait({ text: someoneElse, runId: RUN.runId }),
    ).toBe(someoneElse);

    // Prose about the run is not the platform's sentence and is left alone.
    const prose = `I checked ${RUN.runId} and the run started fine.`;
    expect(correctRunStartSentenceForScheduleWait({ text: prose, runId: RUN.runId })).toBe(prose);
  });

  it("also corrects the bare sentence a door minted with no status token", () => {
    const bare = `Dispatched \`${RUN.packageName}\` (runId: \`${RUN.runId}\`).`;
    expect(
      correctRunStartSentenceForScheduleWait({ text: bare, runId: RUN.runId }),
    ).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
    // …and still when that line stands inside a turn beside other prose.
    const inATurn = `Starting it now.\n\n${bare}\n\nI will report back.`;
    expect(
      correctRunStartSentenceForScheduleWait({ text: inATurn, runId: RUN.runId }),
    ).toContain(RUN_START_SCHEDULE_WAIT_CLAUSE);
  });

  it("leaves a clause-less sentence QUOTED inside prose alone (convergence)", () => {
    // The head with no clause after it is the platform's line only when it owns
    // its line. The same characters mid-sentence are the model quoting it, and
    // a corrector that rewrote a quotation would be a second author of the turn.
    const quoted =
      `The log said "Dispatched \`${RUN.packageName}\` (runId: \`${RUN.runId}\`)." and then stopped.`;
    expect(correctRunStartSentenceForScheduleWait({ text: quoted, runId: RUN.runId })).toBe(quoted);
  });

  it("is not confused by a runId carrying regex metacharacters (convergence)", () => {
    const runId = "run.id+(2)*[x]";
    const sentence = describeStartedRun({
      packageName: RUN.packageName,
      runId,
      status: "queued",
    });
    expect(correctRunStartSentenceForScheduleWait({ text: sentence, runId })).toContain(
      RUN_START_SCHEDULE_WAIT_CLAUSE,
    );
    // …and a DIFFERENT run whose id merely matches that pattern literally is untouched.
    const other = describeStartedRun({
      packageName: RUN.packageName,
      runId: "runXidY(2)Z[x]",
      status: "queued",
    });
    expect(correctRunStartSentenceForScheduleWait({ text: other, runId })).toBe(other);
  });
});
