// The relative time of a marketplace approval row is read from unchecked JSON
// (cinatra#4296): date-fns throws a RangeError on an invalid date, so a stamp
// Date.parse does not read gives no text instead of reaching it.
import { describe, expect, it } from "vitest";

import { relativeTimeText } from "../relative-time";

describe("relativeTimeText", () => {
  it("draws the distance for a stamp Date.parse reads", () => {
    const stamp = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTimeText(stamp)).toBe("3 days ago");
  });

  it.each([
    ["text", "garbage"],
    ["an empty string", ""],
    ["a month 13", "2026-13-45T00:00:00.000Z"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1747292400000],
    ["a number Date.parse would read as a year", 2026],
    ["an array holding a stamp", ["2026-05-15T07:00:00.000Z"]],
    ["an object", {}],
    ["an invalid Date object", new Date(Number.NaN)],
  ])("gives no text and does not throw for %s", (_name, value) => {
    expect(() => relativeTimeText(value)).not.toThrow();
    expect(relativeTimeText(value)).toBeNull();
  });
});
