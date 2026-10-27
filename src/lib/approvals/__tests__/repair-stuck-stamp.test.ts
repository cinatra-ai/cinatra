// The stuck stamp of a vendor application is a timestamp that round-trips
// (cinatra#4296). Date.parse rolls a day that does not exist over to the next
// month (2026-02-30 reads as 2026-03-02) and an hour 24 over to the next day,
// and reads a year 0000-0099 written before a space as a year of 1950-2049. So a
// finite Date.parse alone does not make a timestamp: the instant it reads, moved
// by the written offset, must give back the written year, month, day, hour and
// minute. A time must carry its offset, and nothing may follow it.
import { describe, expect, it } from "vitest";

import { isRepairStuckStamp, toRepairStuck } from "../repair-stuck";

describe("isRepairStuckStamp: a timestamp that round-trips is a stamp", () => {
  it.each([
    ["an ISO timestamp", "2026-05-15T07:00:00.000Z"],
    ["a date without a time", "2026-05-15"],
    ["a leap day", "2024-02-29T00:00:00.000Z"],
    ["the last day of a 31-day month", "2026-01-31T12:00:00Z"],
    ["the last millisecond of the year", "2026-12-31T23:59:59.999Z"],
    ["a space-separated time with an offset", "2026-05-15 07:00:00+00:00"],
    ["a time without seconds", "2026-05-15T07:00Z"],
    ["a positive offset with minutes", "2026-05-15T07:00:00+05:30"],
    ["a negative offset after a space", "2026-05-15 07:00:00-05:00"],
    ["an offset without a colon", "2026-05-15T07:00:00+0530"],
    ["an offset that crosses the day", "2026-05-15T07:00:00.000+14:00"],
    ["a two-digit offset after a space, with microseconds", "2026-05-15 07:00:00.123456+00"],
    ["a year 0001 in the T form with Z", "0001-01-01T00:00:00Z"],
    ["a year 0001 in the T form with +00:00", "0001-01-01T00:00:00+00:00"],
    ["a year 0099 in the T form with +0000", "0099-12-31T23:00:00+0000"],
    ["a year 0001 without a time", "0001-01-01"],
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

describe("isRepairStuckStamp: a year 0000-0099 before a space is not a stamp", () => {
  it.each([
    ["a year 0001 with +00:00", "0001-01-01 00:00:00+00:00"],
    ["a year 0000 with Z", "0000-01-01 00:00:00Z"],
    ["a year 0099 with +00:00", "0099-12-31 23:00:00+00:00"],
    ["a year 0001 with +00", "0001-01-01 00:00:00+00"],
    ["a year 0050 with -05:00", "0050-06-15 12:00:00-05:00"],
  ])("%s is not a stamp, and is not stuck", (_name, value) => {
    // The premise: Date.parse reads it as a finite time of another year.
    const read = Date.parse(value);
    expect(Number.isFinite(read)).toBe(true);
    expect(new Date(read).getUTCFullYear()).not.toBe(Number(value.slice(0, 4)));
    expect(isRepairStuckStamp(value)).toBe(false);
    expect(toRepairStuck(value, 3)).toBeUndefined();
  });
});

describe("isRepairStuckStamp: a time without an offset, or with text after it, is not a stamp", () => {
  it.each([
    ["a T-form time without an offset", "2026-05-15T07:00:00"],
    ["a space-form time without an offset", "2026-05-15 07:00:00"],
    ["a year 0001 time without an offset", "0001-01-01 00:00"],
    ["a zone name after the time", "2026-05-15 07:00:00 GMT"],
  ])("%s is not a stamp, and is not stuck", (_name, value) => {
    // The premise: Date.parse reads it (as local time, or by its zone name).
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
