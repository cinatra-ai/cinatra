/**
 * THE ARMED SCHEDULE'S WINDOW READS THE FORM'S OWN PREDICATE (cinatra#2934,
 * lifecycle-b W5c — the armed-trigger tab).
 *
 * The maintainer's reading: "the window must use THE SAME predicate, never a
 * parallel one". The form's **Save changes** is gated by `body.canSave`, which
 * is `canSaveInstalled(...)` computed once on the server so "the card and the
 * endpoint cannot disagree about which schedules are still changeable"; the
 * WRITE is guarded by `saveScheduleGuardRefusal`, asked twice inside
 * `updateRunTriggerScheduleForActor`.
 *
 * This table is what stops a THIRD reading from ever appearing: for every armed
 * trigger row, `canSaveInstalled` saying no and the write guard refusing are the
 * same answer, and the window's own refusal is the guard's own sentence.
 *
 * Pure — no DB, no session, no render.
 */
import { describe, expect, it } from "vitest";

import { canSaveInstalled } from "../trigger-schedule-proposal-service";
import { SAVE_SCHEDULE_REFUSALS, saveScheduleRefusalFor } from "../trigger-service";
import type { TriggerRecord } from "../trigger-store";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function row(over: Partial<TriggerRecord>): TriggerRecord {
  return {
    triggerType: "recurring",
    scheduledAt: null,
    cronExpression: "0 9 * * 1",
    timezone: "Europe/Berlin",
    releasedAt: null,
    stoppedAt: null,
    lastFiredAt: null,
    ...over,
  } as unknown as TriggerRecord;
}

/** Every armed state the two readings are both defined on. */
const MATRIX: ReadonlyArray<{ name: string; trigger: TriggerRecord; arming: boolean }> = [
  { name: "recurring, never fired", trigger: row({}), arming: false },
  { name: "recurring, fired once", trigger: row({ lastFiredAt: PAST }), arming: false },
  { name: "recurring, released", trigger: row({ releasedAt: PAST }), arming: false },
  { name: "recurring, stopped", trigger: row({ stoppedAt: PAST }), arming: false },
  {
    name: "one-off in the future",
    trigger: row({ triggerType: "scheduled", cronExpression: null, scheduledAt: FUTURE }),
    arming: false,
  },
  {
    name: "one-off whose moment has passed",
    trigger: row({ triggerType: "scheduled", cronExpression: null, scheduledAt: PAST }),
    arming: false,
  },
  {
    name: "one-off already released",
    trigger: row({
      triggerType: "scheduled",
      cronExpression: null,
      scheduledAt: FUTURE,
      releasedAt: PAST,
    }),
    arming: false,
  },
  { name: "still arming", trigger: row({}), arming: true },
];

describe("the window and Save changes read ONE predicate", () => {
  for (const c of MATRIX) {
    it(`agrees on ${c.name}`, () => {
      const canSave = canSaveInstalled({
        triggerType: c.trigger.triggerType as "immediate" | "scheduled" | "recurring",
        scheduledAt: c.trigger.scheduledAt ?? null,
        released: !!c.trigger.releasedAt,
        arming: c.arming,
        stopped: c.trigger.stoppedAt != null,
      });
      const refusal = saveScheduleRefusalFor({ trigger: c.trigger, arming: c.arming });
      // The two readings are the SAME answer: a schedule Save changes is
      // withheld on is exactly a schedule the write guard refuses, and the other
      // way round.
      expect(canSave, c.name).toBe(refusal === null);
    });
  }
});

describe("a refusal the window can say out loud", () => {
  it("names the state, from the table the card already refuses from", () => {
    expect(saveScheduleRefusalFor({ trigger: row({ stoppedAt: PAST }), arming: false })).toBe(
      SAVE_SCHEDULE_REFUSALS.stopped,
    );
    expect(
      saveScheduleRefusalFor({
        trigger: row({ triggerType: "scheduled", cronExpression: null, scheduledAt: PAST }),
        arming: false,
      }),
    ).toBe(SAVE_SCHEDULE_REFUSALS.firedOneOff);
    expect(
      saveScheduleRefusalFor({
        trigger: row({ triggerType: "scheduled", cronExpression: null, scheduledAt: FUTURE, releasedAt: PAST }),
        arming: false,
      }),
    ).toBe(SAVE_SCHEDULE_REFUSALS.released);
  });

  it("covers the one state the write guard leaves to the card — arming", () => {
    expect(saveScheduleRefusalFor({ trigger: row({}), arming: true })).toBe(
      SAVE_SCHEDULE_REFUSALS.arming,
    );
  });

  it("says nothing at all about a schedule that CAN still be changed", () => {
    expect(saveScheduleRefusalFor({ trigger: row({}), arming: false })).toBeNull();
  });
});
