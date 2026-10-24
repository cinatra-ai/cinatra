// The attempt count a stuck repair puts on the row's meta line (specs/app.html
// V.1: "the row's meta line carries the attempt count"; cinatra#4296). A count
// that is not a usable number fails safe to no count, so the meta line never
// shows "NaN repair attempts" or a negative count.
import { describe, expect, it } from "vitest";

import { repairAttemptsText } from "../approval-pills";

describe("repairAttemptsText", () => {
  it.each([
    [3, "3 repair attempts"],
    [1, "1 repair attempt"],
    [2, "2 repair attempts"],
  ])("counts %s as %j", (attempts, text) => {
    expect(repairAttemptsText(attempts)).toBe(text);
  });

  it.each([0, -1, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, -0.5])(
    "draws no count for %s",
    (attempts) => {
      expect(repairAttemptsText(attempts)).toBe("");
    },
  );

  it("counts the whole attempts of a fractional count above one (2.7 is 2)", () => {
    expect(repairAttemptsText(2.7)).toBe("2 repair attempts");
    expect(repairAttemptsText(1.5)).toBe("1 repair attempt");
  });
});
