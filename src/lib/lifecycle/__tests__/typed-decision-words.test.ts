// THE PERSON'S OWN WORDS NAME THE MENU (cinatra#2853) — acceptance item 4.
//
// Plan (A) §2.2: "The assistant interprets the words; it never originates the
// decision, and no card gains an action its controls do not already have."
//
// This module is the half of that sentence the SERVER owns. It reads the
// person's own message and answers which of the card's own controls that
// message NAMES. It can only ever NARROW the card's lent set — it never routes
// a message, never extracts a value and never acts — so a control the person
// did not name cannot reach the grant, whatever the model reads or is told.

import { describe, expect, it } from "vitest";

import {
  TYPED_DECISION_WORDS,
  controlsNamedByThePerson,
  wordsNameControl,
} from "../typed-decision-words";

describe("the words the person actually wrote", () => {
  it("names approve for the review card's own approving words", () => {
    expect(wordsNameControl("approve", "approve it")).toBe(true);
    expect(wordsNameControl("approve", "Approve this, it reads well")).toBe(true);
    expect(wordsNameControl("approve", "lgtm")).toBe(true);
    expect(wordsNameControl("approve", "looks good, sign off on it")).toBe(true);
  });

  it("names reject for the review card's own rejecting words", () => {
    expect(wordsNameControl("reject", "reject it")).toBe(true);
    expect(wordsNameControl("reject", "Decline this one")).toBe(true);
  });

  it("names neither for a sentence that asks for a change", () => {
    const words = "the second paragraph overstates the result";
    expect(wordsNameControl("approve", words)).toBe(false);
    expect(wordsNameControl("reject", words)).toBe(false);
  });

  it("is not fooled by a longer word that merely contains one", () => {
    // "approved" is the act; "unapproved" and "disapprove" are not it, and
    // "yesterday" is not "yes".
    expect(wordsNameControl("approve", "the unapproved draft is attached")).toBe(false);
    expect(wordsNameControl("confirm", "yesterday's run failed")).toBe(false);
  });

  it("reads the skills card's and the schedule card's own words", () => {
    expect(wordsNameControl("confirm", "drop the research skill and confirm")).toBe(true);
    expect(wordsNameControl("confirm", "make it 8 in the morning on weekdays and confirm")).toBe(
      true,
    );
    expect(wordsNameControl("skip", "skip the skills")).toBe(true);
  });

  it("keeps ordinary conversation OUT of the families — no 'yes', no 'looks good'", () => {
    // These were considered and dropped (convergence round 1, finding 1): they
    // are things people say, not the naming of an act.
    expect(wordsNameControl("confirm", "yes")).toBe(false);
    expect(wordsNameControl("approve", "looks good to me")).toBe(false);
    expect(wordsNameControl("confirm", "set it to 8am")).toBe(false);
  });

  it("names nothing at all for an empty or missing message", () => {
    expect(wordsNameControl("approve", "")).toBe(false);
    expect(wordsNameControl("approve", null)).toBe(false);
    expect(wordsNameControl("confirm", "   ")).toBe(false);
  });

  it("publishes its word families so the model-facing sentence and the gate agree", () => {
    expect(Object.keys(TYPED_DECISION_WORDS).sort()).toEqual([
      "approve",
      "confirm",
      "reject",
      "skip",
    ]);
    for (const family of Object.values(TYPED_DECISION_WORDS)) {
      expect(family.length).toBeGreaterThan(0);
    }
  });
});

// THE DISCLOSED RESIDUAL, PINNED AS A TEST so it cannot be mistaken for a
// property the module does not have (convergence round 1, finding 1). This rule
// reads WORD PRESENCE, not intent. A question, a negation or a quotation that
// names an act puts that act on the MENU — and the menu is not a decision: the
// assistant still has to read the sentence as an ask, and the plan's own line is
// that "a message that is not plainly a decision is ordinary conversation that
// decides nothing". These cases exist so the boundary is written down.
describe("the menu is a NECESSARY condition, never a sufficient one", () => {
  it("a question or a negation about the act still puts it on the menu", () => {
    expect(wordsNameControl("confirm", "what would confirming do?")).toBe(true);
    expect(wordsNameControl("approve", "do not approve this yet")).toBe(true);
    expect(wordsNameControl("reject", "why was this rejected?")).toBe(true);
  });

  it("but a message that never names the act cannot reach it at all", () => {
    const words = "can you summarise what changed since the last revision?";
    expect(controlsNamedByThePerson(["comment", "approve", "reject"], words)).toEqual(["comment"]);
    expect(controlsNamedByThePerson(["confirm", "skip"], words)).toEqual([]);
  });
});

describe("the menu, narrowed from the card's own lent set", () => {
  it("keeps the always-corroborated controls and drops the unnamed decisions", () => {
    expect(
      controlsNamedByThePerson(
        ["comment", "approve", "reject"],
        "the second paragraph overstates the result",
      ),
    ).toEqual(["comment"]);
  });

  it("adds the decision the person named, and only that one", () => {
    expect(controlsNamedByThePerson(["comment", "approve", "reject"], "approve it")).toEqual([
      "comment",
      "approve",
    ]);
    expect(controlsNamedByThePerson(["comment", "approve", "reject"], "reject it")).toEqual([
      "comment",
      "reject",
    ]);
  });

  it("can only ever NARROW: nothing outside the card's lent set is ever added", () => {
    // A review lends no confirm, so a message that names one gets no confirm.
    expect(controlsNamedByThePerson(["comment"], "confirm it, approve it, skip it")).toEqual([
      "comment",
    ]);
  });

  it("leaves a fill and a submit alone — neither is a decision the words gate", () => {
    // `fill` presses nothing; `submit` is already bound structurally by the
    // same-message fill W5c requires, so the words add no second gate to it.
    expect(controlsNamedByThePerson(["fill", "submit"], "make it say hello")).toEqual([
      "fill",
      "submit",
    ]);
  });

  it("gives a skills hold nothing at all when the person named no decision", () => {
    expect(controlsNamedByThePerson(["confirm", "skip"], "what does the research skill do?")).toEqual(
      [],
    );
  });

  it("gives a schedule card its adjust with no decision word, and its confirm with one", () => {
    expect(
      controlsNamedByThePerson(["adjust", "confirm"], "make it 8 in the morning on weekdays"),
    ).toEqual(["adjust"]);
    expect(
      controlsNamedByThePerson(
        ["adjust", "confirm"],
        "make it 8 in the morning on weekdays and confirm",
      ),
    ).toEqual(["adjust", "confirm"]);
  });
});

describe("a phrase that names no act is not on the menu (convergence round 2)", () => {
  // These three were IN the confirm family and were removed. None of them names
  // the button the card draws, so an ordinary sentence that happens to contain
  // one put a terminal control on the menu for nothing.
  it.each(["do it", "apply it", "arm it"])("%s does not name Confirm", (phrase) => {
    expect(wordsNameControl("confirm", `please ${phrase} when you get a chance`)).toBe(false);
  });

  it("a schedule card bound to a message that only says 'do it' lends no confirm", () => {
    expect(controlsNamedByThePerson(["adjust", "confirm"], "do it")).toEqual(["adjust"]);
  });

  it("the word the card actually draws still names it", () => {
    expect(controlsNamedByThePerson(["adjust", "confirm"], "confirm that")).toEqual([
      "adjust",
      "confirm",
    ]);
  });
});
