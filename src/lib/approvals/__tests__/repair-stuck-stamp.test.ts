// The stuck stamp of a vendor application is a calendar-valid timestamp only
// (cinatra#4296). Date.parse rolls a day that does not exist over to the next
// month (2026-02-30 reads as 2026-03-02) and an hour 24 over to the next day, so
// a finite Date.parse alone does not make a timestamp: the written year, month,
// day and time fields must come back unchanged.
import { describe, expect, it } from "vitest";

import { isRepairStuckStamp, toRepairStuck } from "../repair-stuck";

describe("isRepairStuckStamp: a calendar-valid timestamp is a stamp", () => {
  it.each([
    ["an ISO timestamp", "2026-05-15T07:00:00.000Z"],
    ["a date without a time", "2026-05-15"],
    ["a leap day", "2024-02-29T00:00:00.000Z"],
    ["the last day of a 31-day month", "2026-01-31T12:00:00Z"],
    ["the last millisecond of the year", "2026-12-31T23:59:59.999Z"],
    ["a space-separated time with an offset", "2026-05-15 07:00:00+00:00"],
    ["a time without seconds", "2026-05-15T07:00Z"],
  ])("%s is a stamp, and is stuck", (_name, value) => {
    expect(isRepairStuckStamp(value)).toBe(true);
    expect(toRepairStuck(value)).toEqual({});
  });
});

describe("isRepairStuckStamp: a day or time Date.parse rolls over is not a stamp", () => {
  it.each([
    ["a February 29 of a common year", "2025-02-29T00:00:00.000Z"],
    ["a February 30", "2026-02-30T00:00:00.000Z"],
    ["an April 31", "2026-04-31T00:00:00.000Z"],
    ["an April 31 without a time", "2026-04-31"],
    ["a June 31", "2026-06-31T12:00:00Z"],
    ["an hour 24", "2026-05-15T24:00:00.000Z"],
    ["an hour 24 after a space", "2026-05-15 24:00:00+00:00"],
  ])("%s is not a stamp, and is not stuck", (_name, value) => {
    // The premise: Date.parse reads it as a finite time of another day.
    expect(Number.isFinite(Date.parse(value))).toBe(true);
    expect(isRepairStuckStamp(value)).toBe(false);
    expect(toRepairStuck(value, 3)).toBeUndefined();
  });
});

describe("isRepairStuckStamp: other malformed values stay rejected", () => {
  it.each([
    ["a month 13", "2026-13-01T00:00:00.000Z"],
    ["a day 00", "2026-05-00T00:00:00.000Z"],
    ["a minute 60", "2026-05-15T23:60:00Z"],
    ["a second 60", "2026-05-15T23:59:60Z"],
    ["an hour without minutes", "2026-05-15T07"],
    ["text", "not a date"],
    ["an empty string", ""],
    ["a number", 1747292400000],
    ["null", null],
    ["an array holding a stamp", ["2026-05-15T07:00:00.000Z"]],
  ])("%s is not a stamp", (_name, value) => {
    expect(isRepairStuckStamp(value)).toBe(false);
    expect(toRepairStuck(value)).toBeUndefined();
  });
});
