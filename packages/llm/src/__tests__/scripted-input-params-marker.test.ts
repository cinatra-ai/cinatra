// ---------------------------------------------------------------------------
// THE INPUT-PARAMS MARKER, AND WHY ITS WHITESPACE IS UNAMBIGUOUS.
// ---------------------------------------------------------------------------
// `scriptedTurnAgentInputParams` reads the inputs a person stated outright, and
// it reads them out of THE PERSON'S OWN SENTENCE — arbitrary text, of arbitrary
// length. Its marker used to be `\binput[\s_]?params?\b\s*[:=]?\s*(?=\{)`, in
// which two runs of `\s*` sit either side of an OPTIONAL character: a stretch
// of whitespace can be split between them in many ways, so a sentence carrying
// a long run of tabs and no `{` makes the engine try each split. Measured on
// this repo's own runtime, sixty thousand tabs took ~18 SECONDS to refuse.
//
// The marker now reads `\binput[\s_]?params?\b\s*(?:[:=]\s*)?(?=\{)`: the first
// run takes all the whitespace, and the optional group can only begin at a
// character that is not whitespace, so there is nothing left to split. The same
// input refuses in about a millisecond.
//
// BOTH HALVES ARE ASSERTED HERE, because either alone would be a weaker claim
// than the change makes: that the reading is UNCHANGED for every shape a person
// writes, and that the pathological input is answered promptly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { scriptedTurnAgentInputParams } from "../scripted-test-provider";

describe("the inputs a sentence states outright", () => {
  it("reads the same inputs out of every shape a person writes", () => {
    const written = '{"oasJson":"{}"}';
    for (const sentence of [
      'run cinatra_lint-policy-agent with inputParams: {"oasJson": "{}"}',
      'inputParams {"oasJson": "{}"}',
      'inputParams:{"oasJson": "{}"}',
      'inputParams = {"oasJson": "{}"}',
      'input params : {"oasJson": "{}"}',
      'input_param={"oasJson": "{}"}',
      'INPUTPARAMS  {"oasJson": "{}"}',
      'inputParams\t\t{"oasJson": "{}"}',
    ]) {
      expect(scriptedTurnAgentInputParams(sentence)).toBe(written);
    }
  });

  it("still invents nothing when the sentence states none", () => {
    expect(scriptedTurnAgentInputParams("run the agent")).toBe("{}");
    expect(scriptedTurnAgentInputParams("inputParams")).toBe("{}");
    expect(scriptedTurnAgentInputParams('a bare {"a":1} with no marker')).toBe("{}");
  });

  it("answers a sentence built to make the marker backtrack, promptly", () => {
    // The shape the scanner named: the marker, then a long run of whitespace,
    // then nothing it can match. The bound is two seconds — three orders of
    // magnitude above what the fixed marker needs and an order of magnitude
    // BELOW what the old one took, so it can only pass one of the two.
    const pathological = `inputParams${"\t".repeat(60_000)}x`;
    const started = Date.now();
    expect(scriptedTurnAgentInputParams(pathological)).toBe("{}");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
