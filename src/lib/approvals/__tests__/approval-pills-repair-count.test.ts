// The attempt count a stuck repair puts on the row's meta line (specs/app.html
// V.1: "the row's meta line carries the attempt count"; cinatra#4296). The
// count is a worker-incremented counter, read from unchecked JSON: only a
// non-negative safe integer of type number is a count. Anything else (a
// fraction, a runtime string, NaN, an infinity, an unsafe integer, a negative)
// is malformed and draws no count; it is never rounded or coerced into a
// plausible one. Zero attempts is a valid count with nothing to draw.
import { describe, expect, it } from "vitest";

import { repairAttemptsText } from "../approval-pills";

describe("repairAttemptsText", () => {
  it.each([
    [3, "3 repair attempts"],
    [1, "1 repair attempt"],
    [2, "2 repair attempts"],
    [Number.MAX_SAFE_INTEGER, `${Number.MAX_SAFE_INTEGER} repair attempts`],
  ])("counts %s as %j", (attempts, text) => {
    expect(repairAttemptsText(attempts)).toBe(text);
  });

  it.each([0, -0, -1, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, -0.5])(
    "draws no count for %s",
    (attempts) => {
      expect(repairAttemptsText(attempts)).toBe("");
    },
  );

  it("draws no count for a fraction above one (2.7 is malformed, not 2)", () => {
    expect(repairAttemptsText(2.7)).toBe("");
    expect(repairAttemptsText(1.5)).toBe("");
  });

  it.each([
    ["a runtime string", "3"],
    ["an unsafe integer", 2 ** 53],
    ["a larger unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["an object", { valueOf: () => 3 }],
  ])("draws no count for %s", (_name, attempts) => {
    expect(repairAttemptsText(attempts as never)).toBe("");
  });
});
