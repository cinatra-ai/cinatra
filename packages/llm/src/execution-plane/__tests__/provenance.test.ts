// Unit tests for the render-side execution-provenance guard (cinatra#2175).
//
// The guard exists because of one live outcome: with the execution capability
// fully injected on a chat turn, the model answered an explicit "run this"
// request with prose shaped exactly like captured stdout (marker line, platform
// string, a digest that was WRONG) with no tool call and no `execution_sandbox`
// audit row. The first case below is that turn's reply, reproduced in shape,
// and it must come back `unverified`.
//
// The rest pin the two failure modes that would make the guard useless: staying
// silent on a real claim (a silent surface), and shouting at an offer or a
// refusal (a wrong accusation).

import { describe, expect, it } from "vitest";

import {
  EXECUTION_PROVENANCE_NO_EXECUTION_NOTICE,
  EXECUTION_PROVENANCE_REFUSED_NOTICE,
  EXECUTION_PROVENANCE_UNVERIFIED_NOTICE,
  assertsExecution,
  detectExecutionClaims,
  evaluateExecutionProvenance,
} from "../policy";

/** The shape of the live fabrication, digest included. */
const FABRICATED_TURN = [
  "I ran the one-liner in the sandbox with python3. Here is its literal stdout:",
  "",
  "MARKER-AC2-S8",
  "Linux",
  "e267b434c8c3cf8e4f5ac5f037d2512f43a1fa7982f695524a7cc356b6f813c2",
  "",
  "The platform line confirms the sandbox is Linux.",
].join("\n");

describe("the live fabrication is CAUGHT", () => {
  it("capability offered + zero completed dispatches is unverified, with the marker", () => {
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 0, executed: 0, refused: 0 },
      text: FABRICATED_TURN,
    });
    expect(verdict.status).toBe("unverified");
    expect(verdict.notice).toBe(EXECUTION_PROVENANCE_UNVERIFIED_NOTICE);
    expect(verdict.matchedClaims.length).toBeGreaterThan(0);
  });

  it("the SAME reply is left alone once a dispatch actually completed", () => {
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 1, executed: 1, refused: 0 },
      text: FABRICATED_TURN,
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.notice).toBe("");
  });

  it("the marker names the checkable facts, and asserts nothing about correctness", () => {
    expect(EXECUTION_PROVENANCE_UNVERIFIED_NOTICE).toContain("sandbox_execute");
    expect(EXECUTION_PROVENANCE_UNVERIFIED_NOTICE).toContain("audit entry");
    for (const notice of [
      EXECUTION_PROVENANCE_UNVERIFIED_NOTICE,
      EXECUTION_PROVENANCE_REFUSED_NOTICE,
      EXECUTION_PROVENANCE_NO_EXECUTION_NOTICE,
    ]) {
      expect(notice).toContain("Unverified execution claim");
      // It must not call the answer wrong - the guard cannot know that.
      expect(notice.toLowerCase()).not.toContain("incorrect");
    }
  });

  it("a REFUSED dispatch gets the marker that is TRUE for it (codex round 2)", () => {
    // The refusal DID produce a `sandbox_execute` result and IS audited, so the
    // no-tool-result / no-audit-entry wording would be the false statement here.
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 1, executed: 0, refused: 1 },
      text: FABRICATED_TURN,
    });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toBe("refused");
    expect(verdict.notice).toBe(EXECUTION_PROVENANCE_REFUSED_NOTICE);
    expect(verdict.notice).not.toContain("never called");
  });

  it("the refusal marker does not over-claim when only SOME calls were refused", () => {
    // { attempted: 2, executed: 0, refused: 1 }: one refusal, one that rejected
    // or carried nothing. "every call was refused" would be false here, so the
    // marker states the fact that holds for all of them — no command ran.
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 2, executed: 0, refused: 1 },
      text: FABRICATED_TURN,
    });
    expect(verdict.reason).toBe("refused");
    expect(verdict.notice).toContain("no command ran on this turn");
    expect(verdict.notice.toLowerCase()).not.toContain("every sandbox call");
  });

  it("a dispatch that neither ran nor was refused gets its OWN marker (codex round 3)", () => {
    // An empty batch, or a call that never completed: neither the never-called
    // wording nor the refusal wording is true for it.
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 1, executed: 0, refused: 0 },
      text: FABRICATED_TURN,
    });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toBe("no_execution");
    expect(verdict.notice).toBe(EXECUTION_PROVENANCE_NO_EXECUTION_NOTICE);
    expect(verdict.notice).not.toContain("the execution plane refused");
    expect(verdict.notice).not.toContain("never called on this turn");
  });

  it("no dispatch at all keeps the not-called reason", () => {
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: true,
      dispatches: { attempted: 0, executed: 0, refused: 0 },
      text: FABRICATED_TURN,
    });
    expect(verdict.reason).toBe("not_called");
    expect(verdict.notice).toBe(EXECUTION_PROVENANCE_UNVERIFIED_NOTICE);
  });
});

describe("claims that MUST be detected", () => {
  const claims: Array<[string, string]> = [
    ["ran.first_person", "I ran it and got 33574."],
    ["ran.first_person", "I just ran the script for you."],
    ["run.first_person_perfect", "I have run this on the first 7000 primes."],
    ["executed.first_person", "I executed a short python3 program."],
    ["ran.the_command", "Ran the command and captured what it printed."],
    ["ran.it", "Executed it against the fixed byte string."],
    ["computed.by_running", "I computed it by running a small script."],
    ["stdout.qualified", "Below is the literal stdout."],
    ["stdout.copula", "Its stdout was three lines."],
    ["output.here_is", "Here is the exact output:"],
    ["output.copula", "The command output was as follows:"],
    ["tool.named", "Used sandbox_execute for this."],
    ["sandbox.location", "Computed in the sandbox just now."],
    ["sandbox.noun", "Sandbox output follows."],
  ];

  for (const [id, text] of claims) {
    it("detects " + id + " in " + JSON.stringify(text), () => {
      expect(detectExecutionClaims(text)).toContain(id);
      expect(assertsExecution(text)).toBe(true);
    });
  }

  it("a modal clause elsewhere in the reply does not excuse the assertion", () => {
    const text =
      "I ran the script and pasted the result.\nIf you want, I can re-run it with a bigger bound.";
    expect(assertsExecution(text)).toBe(true);
  });
});

describe("things that MUST NOT be flagged", () => {
  const innocuous = [
    "Here is a script you can run, using python3 to print the digest.",
    "I can run this in the sandbox if you would like me to.",
    "Would you like me to execute it and report the digest?",
    "I did not run anything - this is an estimate from the prime number theorem.",
    "I cannot execute code here, so the value below is approximate.",
    "I have not run it; the figure is from the documentation.",
    "No command was executed for this answer.",
    "I ran into a problem parsing your file.",
    "Programs write results to stdout by default, which is a POSIX convention.",
    "The sandbox is an isolated environment with no credentials.",
    "This computes the digest without actually running anything on your machine.",
    // Codex round, false-positive class: an OFFER that names the tool.
    "I can use sandbox_execute for this if you would like me to.",
    "Would you like me to call sandbox_execute and paste the result?",
    // Codex round: a HYPOTHETICAL presentation of output.
    "Here is the output you would see if you ran it.",
    "The command output would be three lines: a marker, the platform, a digest.",
    // Codex round: the actor is the USER, not the assistant.
    "You ran it in the previous turn, so the digest is already known.",
    "You have already executed that command against the same input.",
    "",
    "   \n  ",
  ];

  for (const text of innocuous) {
    it("leaves alone: " + JSON.stringify(text.slice(0, 56)), () => {
      expect(detectExecutionClaims(text)).toEqual([]);
      expect(
        evaluateExecutionProvenance({
          capabilityOffered: true,
          dispatches: { attempted: 0, executed: 0, refused: 0 },
          text,
        }).status,
      ).toBe("not_applicable");
    });
  }
});

describe("segmenting and suppression regressions (codex round)", () => {
  it("a negation in one clause does not swallow an assertion in the next", () => {
    for (const text of [
      "I didn't guess \u2014 I ran it.",
      "Not an estimate -- I executed the script and read the digest.",
      "This is not a guess. I ran the command and pasted what it printed.",
    ]) {
      expect(assertsExecution(text)).toBe(true);
      expect(
        evaluateExecutionProvenance({
          capabilityOffered: true,
          dispatches: { attempted: 0, executed: 0, refused: 0 },
          text,
        }).status,
      ).toBe("unverified");
    }
  });

  it("presentational verbs count as a claim when nothing hedges them", () => {
    expect(detectExecutionClaims("It printed three lines.")).toContain(
      "printed.subject",
    );
    expect(
      detectExecutionClaims("A short python3 program, which printed the digest."),
    ).toContain("printed.relative");
  });

  it("a modal does NOT excuse a first-person past assertion", () => {
    expect(
      assertsExecution("I ran it, so you can verify the digest yourself."),
    ).toBe(true);
  });

  it("the dash split does NOT strip a negation off a WEAK pattern (codex round 2)", () => {
    // Dashes separate clauses for the first-person assertions only; a weak,
    // presentational pattern keeps the coarser granularity so the negation in
    // the same sentence still reaches it.
    for (const text of [
      "I did not run it \u2014 here is the output you supplied.",
      "I cannot execute anything \u2014 the command output would be three lines.",
    ]) {
      expect(detectExecutionClaims(text)).toEqual([]);
    }
  });

  it("`computed by running` is first-person anchored (codex round 2)", () => {
    expect(assertsExecution("I computed it by running a sieve.")).toBe(true);
    expect(
      detectExecutionClaims("You computed it by running the same sieve."),
    ).toEqual([]);
  });
});

describe("the guard is inert unless the capability was offered", () => {
  it("capability NOT offered is not_applicable even on the fabrication", () => {
    const verdict = evaluateExecutionProvenance({
      capabilityOffered: false,
      dispatches: { attempted: 0, executed: 0, refused: 0 },
      text: FABRICATED_TURN,
    });
    expect(verdict).toEqual({
      status: "not_applicable",
      matchedClaims: [],
      notice: "",
    });
  });
});

describe("verdicts are deterministic and total", () => {
  it("matched claim ids come back in a stable, deduped order", () => {
    const first = detectExecutionClaims(FABRICATED_TURN);
    const second = detectExecutionClaims(FABRICATED_TURN);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("never throws, whatever the text", () => {
    for (const text of ["", " ", "I ran", "a".repeat(20000)]) {
      expect(() =>
        evaluateExecutionProvenance({
          capabilityOffered: true,
          dispatches: { attempted: 0, executed: 0, refused: 0 },
          text,
        }),
      ).not.toThrow();
    }
  });
});
