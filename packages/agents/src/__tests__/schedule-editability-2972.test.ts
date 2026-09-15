/**
 * WHEN A SCHEDULE STAYS CHANGEABLE — the server's own reading (cinatra#2972).
 *
 * `canSaveInstalled` is the ONE predicate the card and the endpoint both read,
 * so this table is where plan (A) §7.2 as amended 2026-08-25 is enforced rather
 * than merely drawn:
 *
 *   "once a run set to **Run right after setup** or **Schedule for later** has
 *    fired, its schedule cannot be changed any more; a run set to **Recurring**
 *    that has fired keeps its scheduler editable — the same rows and **Save
 *    changes**, and a change applies to its future runs"
 *
 * and, for the stopped state:
 *
 *   "**Cancel schedule** … stops the recurring schedule and then makes the
 *    scheduler non-editable."
 *
 * Pure — no DB, no session, no render.
 */
import { describe, expect, it } from "vitest";

import { canSaveInstalled } from "../trigger-schedule-proposal-service";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

describe("a RECURRING schedule stays changeable after it has fired", () => {
  it("is changeable before its first tick", () => {
    expect(
      canSaveInstalled({
        triggerType: "recurring",
        scheduledAt: null,
        released: false,
        arming: false,
        stopped: false,
      }),
    ).toBe(true);
  });

  it("is STILL changeable with the gate stamp set — a change applies to future runs", () => {
    // `released` is the one-off's firing and is meaningless for a recurring
    // schedule; even set, it must not take the floor away. This is the exact
    // reading that was false before this issue.
    expect(
      canSaveInstalled({
        triggerType: "recurring",
        scheduledAt: null,
        released: true,
        arming: false,
        stopped: false,
      }),
    ).toBe(true);
  });

  it("is NOT changeable once it has been STOPPED", () => {
    expect(
      canSaveInstalled({
        triggerType: "recurring",
        scheduledAt: null,
        released: false,
        arming: false,
        stopped: true,
      }),
    ).toBe(false);
  });

  it("is NOT changeable while the install is still draining", () => {
    expect(
      canSaveInstalled({
        triggerType: "recurring",
        scheduledAt: null,
        released: false,
        arming: true,
        stopped: false,
      }),
    ).toBe(false);
  });
});

describe("a ONE-OFF and an IMMEDIATE run freeze once they have fired", () => {
  it("Schedule for later, still ahead of its moment: changeable", () => {
    expect(
      canSaveInstalled({
        triggerType: "scheduled",
        scheduledAt: FUTURE,
        released: false,
        arming: false,
        stopped: false,
      }),
    ).toBe(true);
  });

  it("Schedule for later, once it has FIRED: frozen", () => {
    expect(
      canSaveInstalled({
        triggerType: "scheduled",
        scheduledAt: PAST,
        released: true,
        arming: false,
        stopped: false,
      }),
    ).toBe(false);
  });

  it("Schedule for later, past its moment but not yet released: still frozen by the instant", () => {
    expect(
      canSaveInstalled({
        triggerType: "scheduled",
        scheduledAt: PAST,
        released: false,
        arming: false,
        stopped: false,
      }),
    ).toBe(false);
  });

  it("Run right after setup, once it has FIRED: frozen", () => {
    expect(
      canSaveInstalled({
        triggerType: "immediate",
        scheduledAt: null,
        released: true,
        arming: false,
        stopped: false,
      }),
    ).toBe(false);
  });

  it("Run right after setup, before it fires: changeable", () => {
    expect(
      canSaveInstalled({
        triggerType: "immediate",
        scheduledAt: null,
        released: false,
        arming: false,
        stopped: false,
      }),
    ).toBe(true);
  });
});
