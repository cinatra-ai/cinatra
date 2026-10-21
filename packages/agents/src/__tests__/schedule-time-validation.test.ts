/**
 * THE SCHEDULE'S TIME IS CHECKED BY ONE CLIENT-SAFE RULE (cinatra#3189, P10).
 *
 * Design `specs/app-components.html`, "Standard scheduling step": "a
 * validation failure — a past instant, or a recurring schedule with no time
 * chosen — surfaces inline on the field (the error state)". Both hosts — the
 * conversational card and the in-flow scheduling step — read the answer from
 * `validateScheduleTime` in the tier-neutral `trigger-recurrence` leaf, and the rule is the server's own: an instant that
 * does not resolve refuses, and an instant at or before now refuses.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run src/__tests__/schedule-time-validation.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCHEDULE_TIME_MESSAGES,
  naiveDatetimeToUtcMs,
  validateScheduleTime,
  type ScheduleTimeInput,
} from "../trigger-recurrence";
import { naiveDatetimeToUtcMs as reExported } from "../trigger-schedule-propose";

vi.mock("server-only", () => ({}));
// The propose leaf's own imports reach the store and the token module; only
// the re-export is read here, so they are stubbed rather than booted.
vi.mock("@/lib/trigger-schedule-proposal-token", () => ({
  mintTriggerScheduleProposalToken: vi.fn(),
  verifyTriggerScheduleProposalToken: vi.fn(),
  verifyTriggerScheduleProposalTokenDetailed: vi.fn(),
}));
vi.mock("../store", () => ({
  readAgentTemplateById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
}));

// 2026-07-14 07:00 UTC = 09:00 in Berlin (CEST, +2) = 00:00 in Los Angeles (PDT, -7).
const NOW = Date.parse("2026-07-14T07:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const scheduled = (runAt: string, timezone = "Europe/Berlin"): ScheduleTimeInput => ({
  kind: "scheduled",
  runAt,
  timezone,
});

const recurring = (selection: Record<string, unknown>, timezone = "Europe/Berlin") =>
  ({ kind: "recurring", selection, timezone }) as unknown as ScheduleTimeInput;

const NO_TIME_RUN_AT = { ok: false, reason: "no_time", field: "run-at" } as const;
const PAST_RUN_AT = { ok: false, reason: "past_time", field: "run-at" } as const;
const NO_TIME_RECURRING = { ok: false, reason: "no_time", field: "recurring-time" } as const;

describe("a one-off's Run at", () => {
  it("refuses an empty Run at as no time chosen", () => {
    expect(validateScheduleTime(scheduled(""))).toEqual(NO_TIME_RUN_AT);
  });

  it("refuses a Run at that is not the wire's naive wall clock as no time chosen", () => {
    for (const runAt of [
      "tomorrow",
      "2026-07-14 09:00",
      "2026-07-14T09",
      "2026-07-14T09:00Z",
      "2026-07-14T09:00:00.000",
      "2026-7-14T09:00",
      " 2026-07-14T09:00",
    ]) {
      expect(validateScheduleTime(scheduled(runAt)), runAt).toEqual(NO_TIME_RUN_AT);
    }
  });

  it("refuses a Run at that is not a string as no time chosen", () => {
    const bad = { kind: "scheduled", runAt: undefined, timezone: "Europe/Berlin" };
    expect(validateScheduleTime(bad as unknown as ScheduleTimeInput)).toEqual(NO_TIME_RUN_AT);
  });

  it("reads both the 16-character and the 19-character wall clock", () => {
    // 09:01 Berlin is one minute after now.
    expect(validateScheduleTime(scheduled("2026-07-14T09:01"))).toEqual({ ok: true });
    expect(validateScheduleTime(scheduled("2026-07-14T09:01:00"))).toEqual({ ok: true });
    expect(validateScheduleTime(scheduled("2026-07-14T08:59"))).toEqual(PAST_RUN_AT);
    expect(validateScheduleTime(scheduled("2026-07-14T08:59:59"))).toEqual(PAST_RUN_AT);
  });

  it("refuses a zone the platform does not know, an empty one and a missing one: it cannot be armed", () => {
    expect(validateScheduleTime(scheduled("2027-01-01T09:00", "Mars/Olympus_Mons"))).toEqual(
      PAST_RUN_AT,
    );
    expect(validateScheduleTime(scheduled("2027-01-01T09:00", ""))).toEqual(PAST_RUN_AT);
    const noZone = { kind: "scheduled", runAt: "2027-01-01T09:00" };
    expect(validateScheduleTime(noZone as unknown as ScheduleTimeInput)).toEqual(PAST_RUN_AT);
  });

  it("refuses an impossible clock of the right shape: it cannot be armed", () => {
    expect(validateScheduleTime(scheduled("2027-01-01T25:00"))).toEqual(PAST_RUN_AT);
    expect(validateScheduleTime(scheduled("2027-13-01T09:00"))).toEqual(PAST_RUN_AT);
  });

  it("refuses one minute ago", () => {
    expect(validateScheduleTime(scheduled("2026-07-14T08:59"))).toEqual(PAST_RUN_AT);
  });

  it("refuses an instant exactly equal to now, and passes now + 1 ms", () => {
    // 09:00:00 Berlin IS now.
    expect(validateScheduleTime(scheduled("2026-07-14T09:00"))).toEqual(PAST_RUN_AT);
    expect(validateScheduleTime(scheduled("2026-07-14T09:00:00"))).toEqual(PAST_RUN_AT);
    const at = naiveDatetimeToUtcMs("2026-07-14T09:00", "Europe/Berlin");
    expect(at).toBe(NOW);
    expect(validateScheduleTime(scheduled("2026-07-14T09:00"), at - 1)).toEqual({ ok: true });
    // The same boundary read the other way: the clock moved 1 ms past the instant.
    vi.setSystemTime(NOW - 1);
    expect(validateScheduleTime(scheduled("2026-07-14T09:00"))).toEqual({ ok: true });
  });

  it("passes one minute ahead", () => {
    expect(validateScheduleTime(scheduled("2026-07-14T09:01"))).toEqual({ ok: true });
  });

  it("judges the wall clock in the SELECTED zone, never the browser's", () => {
    // 05:00 on the 14th: past in Berlin (it is 09:00 there), future in Los
    // Angeles (it is 00:00 there).
    expect(validateScheduleTime(scheduled("2026-07-14T05:00", "Europe/Berlin"))).toEqual(
      PAST_RUN_AT,
    );
    expect(
      validateScheduleTime(scheduled("2026-07-14T05:00", "America/Los_Angeles")),
    ).toEqual({ ok: true });
  });

  it("reads the clock at the call, so a later press of the same rows can refuse", () => {
    const rows = scheduled("2026-07-14T09:30");
    expect(validateScheduleTime(rows)).toEqual({ ok: true });
    vi.setSystemTime(NOW + 31 * 60_000);
    expect(validateScheduleTime(rows)).toEqual(PAST_RUN_AT);
  });
});

describe("a recurring schedule's At", () => {
  const AT_9 = { hour: 9, minute: 0 };

  it("passes a whole hour and minute", () => {
    expect(validateScheduleTime(recurring(AT_9))).toEqual({ ok: true });
    expect(validateScheduleTime(recurring({ hour: 0, minute: 0 }))).toEqual({ ok: true });
    expect(validateScheduleTime(recurring({ hour: 23, minute: 59 }))).toEqual({ ok: true });
  });

  it("refuses an hour that is NaN, -1, 24, 9.5, missing or not a number as no time chosen", () => {
    for (const hour of [Number.NaN, -1, 24, 9.5, undefined, "9", Number.POSITIVE_INFINITY]) {
      expect(validateScheduleTime(recurring({ hour, minute: 0 })), String(hour)).toEqual(
        NO_TIME_RECURRING,
      );
    }
  });

  it("refuses a minute that is 60, -1, NaN, fractional or missing as no time chosen", () => {
    for (const minute of [60, -1, Number.NaN, 0.5, undefined]) {
      expect(validateScheduleTime(recurring({ hour: 9, minute })), String(minute)).toEqual(
        NO_TIME_RECURRING,
      );
    }
  });

  it("refuses a recurring schedule with no selection at all", () => {
    const bare = { kind: "recurring", timezone: "Europe/Berlin" };
    expect(validateScheduleTime(bare as unknown as ScheduleTimeInput)).toEqual(NO_TIME_RECURRING);
  });
});

describe("Run right after setup, and what the rule does not recognise", () => {
  it("always passes Run right after setup", () => {
    expect(validateScheduleTime({ kind: "immediate" })).toEqual({ ok: true });
  });

  it("refuses a kind it does not know, and a missing schedule", () => {
    const webhook = { kind: "webhook" } as unknown as ScheduleTimeInput;
    expect(validateScheduleTime(webhook)).toEqual(NO_TIME_RUN_AT);
    expect(validateScheduleTime(null as unknown as ScheduleTimeInput)).toEqual(NO_TIME_RUN_AT);
  });
});

describe("the messages and the module", () => {
  it("names the two sentences the hosts draw", () => {
    expect(SCHEDULE_TIME_MESSAGES.past_time).toBe("Choose a time in the future.");
    expect(SCHEDULE_TIME_MESSAGES.no_time).toBe("Choose a time.");
  });

  it("is the function the server's propose leaf re-exports", () => {
    expect(reExported).toBe(naiveDatetimeToUtcMs);
  });

  it("lives in the tier-neutral leaf: no server-only or client directive, no import", () => {
    const source = readFileSync(resolve(__dirname, "../trigger-recurrence.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(import\s+)?["']server-only["']/m);
    expect(source).not.toMatch(/^\s*["']use client["']/m);
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
