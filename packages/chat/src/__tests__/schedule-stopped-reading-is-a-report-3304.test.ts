/**
 * A SETTLED READING'S LINE IS ITS OWN REPORT, NEVER A CONTROL'S DESCRIPTION
 * (cinatra#3304).
 *
 * WHAT THE SEVENTH GRADED ROUND OF cinatra#3193 MEASURED. A reader pressed
 * Cancel schedule, confirmed it, and the settled turn that followed drew the
 * card read-only with one sentence above it — and that sentence was section
 * VI's description of the CONTROL, written as if the press were still to come.
 * After the stop it reads wrong: it describes an action already taken.
 *
 * WHAT THE DRAWING SAYS. Section VI's own note, at the design revision the app
 * pins (design@a9f9ad01a0b80fa6400396e91605270730f47802,
 * specs/app-lifecycle-cards.html): "Once it is stopped, the turn says so in the
 * past tense. Above a stopped recurring card the one line the rule above fixes
 * for every reading is The recurring schedule was stopped; its rows are no
 * longer editable. — it reports the press that was already taken, and it is
 * never the description of the control itself, which speaks of a press still to
 * come."
 *
 * SO THE DEFECT'S CLASS IS WIDER THAN ONE READING: the settled turn draws the
 * reading's own report, for EVERY settled reading. This file measures that
 * class rather than the one string, in two arms.
 *
 * THE FIRST ARM — THE WORDS. For each of the three settled readings the turn
 * has a sentence for, the exported sentence is the drawing's own words for that
 * reading, and not one of the three is a description of a control still to be
 * pressed. SECTION VI IS QUOTED HERE RATHER THAN IMPORTED, on purpose, exactly
 * as its two sibling suites quote it: the words are the drawing's, so this file
 * measures the drawing rather than measuring whatever constant the source
 * happens to hold.
 *
 * THE SECOND ARM — THE CENSUS. A settled reading given a sentence later must
 * not reach a picture round unmeasured, so this file reads the selection's own
 * module as TEXT and requires the set of readings it answers a sentence for to
 * be exactly these three, each through the constant this file has just checked.
 * A fourth settled reading given a line fails HERE rather than in a round. It
 * measures that twice over: once through the pairing of a reading with the
 * constant answered for it, which reads the one-line branch the selection is
 * written in, and once shape-independently over every reading name the body
 * compares against and every sentence identifier it returns - so a fourth
 * reading added in a braced branch, a switch arm or any other shape the pairing
 * would skip in silence still fails here.
 *
 * IT READS ONLY. Nothing is mounted, no DOM is touched and no module of the
 * product is mocked, so this file mocks nothing to restore: it runs in the
 * node environment the package's configuration gives a `.test.ts` file.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/schedule-stopped-reading-is-a-report-3304.test.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE,
  RUN_START_SCHEDULE_FIRED_SENTENCE,
  RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE,
} from "@cinatra-ai/agents/run-status";

/**
 * SECTION VI'S OWN WORDS FOR THE THREE SETTLED READINGS, quoted from the
 * drawing at the revision above and never imported from the source under test.
 */
const DRAWN_SENTENCE = {
  "stopped-recurring": "The recurring schedule was stopped; its rows are no longer editable.",
  "fired-recurring":
    "It is still recurring, so the rows below still take a change — it applies to the runs still to come.",
  "spent-one-off":
    "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.",
} as const;

/** The constant each settled reading's sentence is exported as. */
const EXPORTED_SENTENCE: Readonly<Record<keyof typeof DRAWN_SENTENCE, string>> = {
  "stopped-recurring": RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE,
  "fired-recurring": RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE,
  "spent-one-off": RUN_START_SCHEDULE_FIRED_SENTENCE,
};

/** The name the selection returns for each settled reading. */
const EXPORTED_NAME: Readonly<Record<keyof typeof DRAWN_SENTENCE, string>> = {
  "stopped-recurring": "RUN_START_SCHEDULE_STOPPED_RECURRING_SENTENCE",
  "fired-recurring": "RUN_START_SCHEDULE_FIRED_RECURRING_SENTENCE",
  "spent-one-off": "RUN_START_SCHEDULE_FIRED_SENTENCE",
};

/** The settled readings the turn has a sentence for, in one sorted list. */
const SETTLED_READINGS = Object.keys(DRAWN_SENTENCE).sort();

/**
 * THE OPENER A CONTROL'S DESCRIPTION USES. Section VI's fired-recurring note
 * introduces Cancel schedule with it — "Cancel schedule stands beside it.
 * Pressing it stops the recurring schedule, and the rows are not editable after
 * that." — and a settled reading's line reports a press that was already taken,
 * so no settled sentence may open a description of one still to come.
 */
const CONTROL_DESCRIPTION_OPENER = "Pressing it";

/** The module that answers a settled reading's sentence, read as text. */
const SELECTION_PATH = "packages/chat/src/chat-messages-view.tsx";
const SELECTION_SOURCE = readFileSync(
  new URL("../chat-messages-view.tsx", import.meta.url),
  "utf8",
);

/** The selection's own body, from its signature to its closing brace. */
function selectionBody(source: string): string {
  const signature = "function standingScheduleLineFor(";
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`${SELECTION_PATH} no longer declares ${signature}`);
  }
  const end = source.indexOf("\n}", start);
  if (end === -1) {
    throw new Error(`${signature} in ${SELECTION_PATH} has no closing brace at column 0`);
  }
  return source.slice(start, end + 2);
}

/**
 * EVERY READING THE SELECTION ANSWERS A SENTENCE FOR, with the constant it
 * answers, read off the body itself rather than listed by hand.
 */
function readingsGivenASentence(body: string): Map<string, string> {
  const answered = new Map<string, string>();
  const answer = /reading\s*===\s*"([a-z-]+)"\s*\)\s*return\s+([A-Za-z0-9_]+)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = answer.exec(body)) !== null) {
    if (match[2] === "null") continue;
    answered.set(match[1]!, match[2]!);
  }
  return answered;
}

/**
 * EVERY READING THE SELECTION NAMES AT ALL, whatever statement shape the branch
 * naming it uses. The pairing above reads the one-line `if (...) return CONST;`
 * form the selection is written in, so a branch written another way - a braced
 * body, a switch arm, a returned literal - would be skipped by it in silence
 * and the census would still read three. This reads the reading names and the
 * returned sentences on their own, so a fourth reading given a line fails here
 * whichever way its branch is written.
 */
function readingsNamed(body: string): string[] {
  const named: string[] = [];
  const naming = /reading\s*===\s*"([a-z-]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = naming.exec(body)) !== null) named.push(match[1]!);
  return named.sort();
}

/** EVERY SENTENCE THE SELECTION RETURNS, by the identifier it returns. */
function sentencesReturned(body: string): string[] {
  const returned: string[] = [];
  const returning = /return\s+([A-Za-z0-9_]+)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = returning.exec(body)) !== null) {
    if (match[1] === "null") continue;
    returned.push(match[1]!);
  }
  return returned.sort();
}

describe("cinatra#3304 — a settled reading's line is the drawing's own report", () => {
  it.each(SETTLED_READINGS)("draws section VI's own words for the %s reading", (reading) => {
    const key = reading as keyof typeof DRAWN_SENTENCE;
    expect(EXPORTED_SENTENCE[key]).toBe(DRAWN_SENTENCE[key]);
  });

  it("never describes a control still to be pressed, in any settled reading", () => {
    for (const reading of SETTLED_READINGS) {
      const key = reading as keyof typeof DRAWN_SENTENCE;
      expect(
        EXPORTED_SENTENCE[key].includes(CONTROL_DESCRIPTION_OPENER),
        `the ${reading} reading's sentence opens a control's description: ` +
          JSON.stringify(EXPORTED_SENTENCE[key]),
      ).toBe(false);
    }
  });

  it("gives the three settled readings three different sentences", () => {
    const sentences = SETTLED_READINGS.map(
      (reading) => EXPORTED_SENTENCE[reading as keyof typeof DRAWN_SENTENCE],
    );
    expect(new Set(sentences).size).toBe(SETTLED_READINGS.length);
  });
});

describe("cinatra#3304 — the census over the settled-turn prose selection", () => {
  it("answers a sentence for exactly the three settled readings and no fourth", () => {
    const answered = readingsGivenASentence(selectionBody(SELECTION_SOURCE));
    expect([...answered.keys()].sort()).toEqual(SETTLED_READINGS);
  });

  it("answers each settled reading through the constant this file measured", () => {
    const answered = readingsGivenASentence(selectionBody(SELECTION_SOURCE));
    for (const reading of SETTLED_READINGS) {
      const key = reading as keyof typeof DRAWN_SENTENCE;
      expect(answered.get(reading)).toBe(EXPORTED_NAME[key]);
    }
  });

  it("names no reading beyond the three settled ones, in any branch shape", () => {
    expect(readingsNamed(selectionBody(SELECTION_SOURCE))).toEqual(SETTLED_READINGS);
  });

  it("returns no sentence beyond the three constants this file measured", () => {
    const expected = SETTLED_READINGS.map(
      (reading) => EXPORTED_NAME[reading as keyof typeof DRAWN_SENTENCE],
    ).sort();
    expect(sentencesReturned(selectionBody(SELECTION_SOURCE))).toEqual(expected);
  });
});
