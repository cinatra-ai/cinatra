// WHAT THE READER'S WORDS ASK FOR (cinatra#2853; plan §2.2).
//
// The rule these pin is the one a RESOLVED GATE hangs on: a message becomes a
// terminal decision only when the whole message IS the decision. The test that
// matters most is not "approve it approves" — it is the block below it, where
// every sentence that merely CONTAINS the verb stays a comment. Misreading a
// decision as a comment leaves the gate open and the button pressable;
// misreading a comment as a decision resolves a gate nobody chose to resolve.

import { describe, expect, it } from "vitest";

import { interpretComposerMessage } from "../composer-card-intent";

describe("interpretComposerMessage — the words state a decision", () => {
  it("the bare verb, with or without an object or sentence punctuation", () => {
    for (const message of [
      "approve",
      "Approve",
      "approve it",
      "Approve it.",
      "approve this",
      "approve this one",
      "approve the review",
      "approve the card",
      "APPROVE IT!",
      "  approve it  ",
    ]) {
      expect(interpretComposerMessage(message)).toEqual({
        kind: "decision",
        decision: "approve",
        note: null,
      });
    }
  });

  it("reject reads the same way — one closed set of verbs, both directions", () => {
    expect(interpretComposerMessage("reject it")).toEqual({
      kind: "decision",
      decision: "reject",
      note: null,
    });
    expect(interpretComposerMessage("Reject.")).toEqual({
      kind: "decision",
      decision: "reject",
      note: null,
    });
  });

  it("a rationale after the colon rides the decision, as the card's field does", () => {
    expect(interpretComposerMessage("reject it: the second paragraph overstates the result")).toEqual({
      kind: "decision",
      decision: "reject",
      note: "the second paragraph overstates the result",
    });
    expect(interpretComposerMessage("approve: looks right to me")).toEqual({
      kind: "decision",
      decision: "approve",
      note: "looks right to me",
    });
  });
});

describe("interpretComposerMessage — the words are a comment", () => {
  it("plan §2.2's own comment example, with the directive stripped", () => {
    expect(
      interpretComposerMessage("add a comment: the second paragraph overstates the result"),
    ).toEqual({
      kind: "comment",
      text: "the second paragraph overstates the result",
    });
    expect(interpretComposerMessage("comment: shorten the intro")).toEqual({
      kind: "comment",
      text: "shorten the intro",
    });
    expect(interpretComposerMessage("leave a comment: shorten the intro")).toEqual({
      kind: "comment",
      text: "shorten the intro",
    });
  });

  it("THE DIRECTIVE WINS: a comment that quotes the verb is still a comment", () => {
    // The directive is read first precisely so this cannot resolve a gate.
    expect(interpretComposerMessage("comment: approve it")).toEqual({
      kind: "comment",
      text: "approve it",
    });
  });

  it("a sentence that merely CONTAINS the verb is never a decision", () => {
    for (const message of [
      "should I approve it?",
      "can you approve it",
      "I would approve it if the intro were shorter",
      "do not approve this yet",
      "don't approve it",
      "approve it and also schedule the next run",
      "approved",
      "why did you reject it",
      "reject it because the numbers are stale",
      "not approve",
      "please approve",
    ]) {
      const intent = interpretComposerMessage(message);
      expect(intent.kind).toBe("comment");
      // And the text is what the reader wrote, byte for byte — the pre-#2853
      // behaviour, untouched for every message that is not a stated decision.
      expect(intent).toEqual({ kind: "comment", text: message.trim() });
    }
  });

  it("an ordinary message is carried through verbatim", () => {
    expect(interpretComposerMessage("  the heading is wrong  ")).toEqual({
      kind: "comment",
      text: "the heading is wrong",
    });
  });
});

describe("interpretComposerMessage — the assistant cannot originate a decision", () => {
  it("is PURE and deterministic: the same words always read the same way", () => {
    // There is no model, no clock and no network in this path — a decision is
    // read out of the person's own message or it is not read at all. Repeating
    // the call is the observable half of that property; the other half is that
    // the module imports nothing but a type.
    const message = "approve it: ship it";
    const first = interpretComposerMessage(message);
    for (let i = 0; i < 25; i += 1) {
      expect(interpretComposerMessage(message)).toEqual(first);
    }
  });

  it("an empty or whitespace message decides NOTHING", () => {
    expect(interpretComposerMessage("   ")).toEqual({ kind: "comment", text: "" });
    expect(interpretComposerMessage("")).toEqual({ kind: "comment", text: "" });
  });
});
