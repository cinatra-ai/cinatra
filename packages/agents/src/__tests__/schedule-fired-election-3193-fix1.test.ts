/**
 * WHAT MAKES A SCHEDULE "FIRED" — the durable record, never the gate stamp
 * (cinatra#3174, fix leg 1 after the first graded proof round).
 *
 * THE ROW THE FIRST ROUND GRADED. Trigger type `immediate`, `released_at`
 * stamped at 15:00:01Z, `last_fired_at` NULL, and the run it gated FAILED
 * without ever starting. The card elected "fired, one-off" from that row and
 * the turn above it therefore said "It ran at the time you set." — of a run
 * that never ran. Section VI gives that reading its words on one condition:
 * "Once it has fired, the card is a reading… A one-time schedule is spent once
 * it fires." A gate that opened over a run that then failed is not a firing.
 *
 * SUPERSEDED IN ITS ONE-OFF HALF BY THE SECOND GRADED ROUND (fix leg 3). Fix
 * leg 1 read the gate stamp AND the run's own row together, so that a released
 * one-off whose run failed before starting kept its form. The second round
 * measured what that costs on the ordinary road: two REAL one-off firings whose
 * run rows were still `pending_approval` with `started_at` NULL — their next
 * gate unanswered — drew the CONFIGURED reading, live pickers over a schedule
 * that was spent. The election now reads the trigger's own record alone, which
 * is what `saveScheduleGuardRefusal` in `trigger-service` already reads ("FIRED
 * is read off the trigger's OWN record — `releasedAt` … never off the run's
 * status") and what the trigger store already documents ("a one-off's firing is
 * `releasedAt`"). The cases below are rewritten to that reading; the recurring
 * family keeps its own tick stamp (`lastFiredAt`), untouched by either leg.
 *
 * Pure — no DB, no session, no render.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schedule-fired-election-3193-fix1.test.ts
 */
import { describe, expect, it } from "vitest";

import { scheduleFiredOnce } from "../trigger-schedule-proposal-service";

const NOW = new Date();
const RAN = { status: "completed", startedAt: NOW };
/** The graded run, exactly: it failed, and it never started. */
const NEVER_RAN = { status: "failed", startedAt: null };

describe("a ONE-OFF schedule is spent when its own trigger record says it fired", () => {
  it("IS fired for both halves of the family once the gate stamp is written", () => {
    for (const triggerType of ["immediate", "scheduled"] as const) {
      expect(
        scheduleFiredOnce({
          triggerType,
          releasedAt: NOW,
          lastFiredAt: null,
          run: RAN,
        }),
        triggerType,
      ).toBe(true);
    }
  });

  // NAMED, not hidden (fix leg 3): fix leg 1 answered this row `false`. Section
  // VI has no reading for "the gate opened and nothing ran", the server
  // authorises no save on it either, and what the RUN did is drawn by the run's
  // own surfaces — so the card reads the trigger's record, which is the thing it
  // is drawing.
  it("IS fired even where the run it gated never reached an executed status", () => {
    for (const run of [
      NEVER_RAN,
      { status: "pending_approval", startedAt: null },
    ] as const) {
      expect(
        scheduleFiredOnce({
          triggerType: "scheduled",
          releasedAt: NOW,
          lastFiredAt: null,
          run,
        }),
        String(run.status),
      ).toBe(true);
    }
  });

  it("is NOT fired before the gate has opened at all", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "scheduled",
        releasedAt: null,
        lastFiredAt: null,
        run: { status: "armed", startedAt: null },
      }),
    ).toBe(false);
  });

  it("is unchanged by an unreadable run row — the trigger's record answers alone", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: NOW,
        lastFiredAt: null,
        run: null,
      }),
    ).toBe(true);
    expect(
      scheduleFiredOnce({
        triggerType: "immediate",
        releasedAt: null,
        lastFiredAt: null,
        run: null,
      }),
    ).toBe(false);
  });
});

describe("a RECURRING schedule keeps its own tick stamp, untouched by this change", () => {
  it("is fired on its tick stamp, whatever the defining run did", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: null,
        lastFiredAt: NOW,
        run: NEVER_RAN,
      }),
    ).toBe(true);
  });

  it("is NOT fired before its first tick, even with the gate stamp set", () => {
    expect(
      scheduleFiredOnce({
        triggerType: "recurring",
        releasedAt: NOW,
        lastFiredAt: null,
        run: RAN,
      }),
    ).toBe(false);
  });
});

describe("the shape the SERVER now calls it with — no run row at all (converge round)", () => {
  // Both production call sites in `trigger-schedule-proposal-service` stopped
  // passing `run` once the election read the trigger's own record, and the
  // token road stopped READING the run row for it. These pin that the call
  // shape the server actually uses elects both families correctly, so a caller
  // that has no run row in hand is never quietly answered `false`.
  it("elects a spent one-off from the gate stamp alone", () => {
    expect(
      scheduleFiredOnce({ triggerType: "scheduled", releasedAt: NOW, lastFiredAt: null }),
    ).toBe(true);
  });

  it("elects a fired recurring schedule from the tick stamp alone", () => {
    expect(
      scheduleFiredOnce({ triggerType: "recurring", releasedAt: null, lastFiredAt: NOW }),
    ).toBe(true);
  });

  it("still refuses an unfired schedule with no run row in hand", () => {
    expect(
      scheduleFiredOnce({ triggerType: "scheduled", releasedAt: null, lastFiredAt: null }),
    ).toBe(false);
    expect(
      scheduleFiredOnce({ triggerType: "recurring", releasedAt: NOW, lastFiredAt: null }),
    ).toBe(false);
  });
});
