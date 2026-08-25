/**
 * THE TRIGGER TAB FOR A FINISHED "RUN RIGHT AFTER SETUP" RUN (cinatra#2980).
 *
 * Plan (A) §7.2 item 4 (amended 2026-08-25), verbatim: "You can change the
 * schedule this way for as long as it has not fired; once a one-off has fired it
 * cannot be changed, and a change to a recurring schedule applies to its future
 * runs."
 *
 * "Run right after setup" is a one-off. Its row is `immediate`, and the
 * immediate path stamps `releasedAt` when it opens the gate exactly as a
 * `scheduled` fire does — so a fired immediate row is a fired one-off, and the
 * screen may no longer offer to change its schedule. Before this slice the
 * standalone form on `/trigger` did offer it, above a notice that promised the
 * route in words ("You can still give it a recurring schedule below").
 *
 * Two halves, both readable without a DB, a session or a Next render:
 *
 *   - THE PREDICATE that decides whether this run's own schedule is frozen, and
 *     the NOTICE COPY that says so — exported for exactly this reason;
 *   - THE SOURCE PIN that the screen actually composes through them: the retired
 *     promise is gone, and the form is mounted read-only when the schedule is
 *     frozen.
 *
 * The rendered half — what the read-only form draws — is `trigger-form.test.tsx`
 * ("the read-only reading"). The server half is
 * `schedule-moment-server-refusals.test.ts`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/trigger-tab-finished-immediate-2980.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  finishedRunNoticeCopy,
  shouldFreezeFiredOneOffSchedule,
  shouldShowFinishedRunNotice,
  shouldShowPersistentTab,
} from "../instance-screens";

const SCREEN_SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

const FIRED = new Date("2026-08-25T09:00:00Z");

describe("shouldFreezeFiredOneOffSchedule", () => {
  it("is false with no trigger row — nothing has been scheduled to freeze", () => {
    expect(shouldFreezeFiredOneOffSchedule(null)).toBe(false);
  });

  it("is false for an immediate row that has NOT fired", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "immediate", releasedAt: null }),
    ).toBe(false);
  });

  // THE ISSUE, in one line.
  it("is TRUE for a fired immediate row — the plan's fired one-off", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "immediate", releasedAt: FIRED }),
    ).toBe(true);
  });

  it("is TRUE for a fired scheduled row — the same rule, the other one-off", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "scheduled", releasedAt: FIRED }),
    ).toBe(true);
  });

  // Plan (A) §7.2: "a run set to Recurring that has fired keeps its scheduler
  // editable … a change applies to its future runs".
  it("is false for a recurring row that has fired — it stays changeable", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "recurring", releasedAt: FIRED }),
    ).toBe(false);
  });

  // Written as "everything that is not recurring", the same shape the server's
  // save guard reads, so a future one-off kind is frozen by default rather than
  // let through by omission — which is the exact way `immediate` was let through.
  // It is a DEFAULT, not a classification: a future REPEATING kind would have to
  // be named alongside recurring, the way this rule names it today.
  it("is TRUE for an unknown fired kind — the rule fails closed", () => {
    expect(
      shouldFreezeFiredOneOffSchedule({ triggerType: "webhook", releasedAt: FIRED }),
    ).toBe(true);
  });
});

describe("finishedRunNoticeCopy", () => {
  it("says nothing when the run is live and its schedule has not fired", () => {
    expect(finishedRunNoticeCopy({ finished: false, frozen: false })).toBeNull();
  });

  // THE REPRO's screen: a completed run whose immediate schedule has fired.
  it("tells a finished run with a fired schedule that the schedule cannot be changed", () => {
    const copy = finishedRunNoticeCopy({ finished: true, frozen: true });
    expect(copy?.heading).toBe("This run has already finished");
    expect(copy?.body).toMatch(/can't be changed/i);
    expect(copy?.body).toMatch(/start a new run/i);
  });

  // The retired promise, in the copy this time.
  it("never offers a recurring schedule below on a frozen schedule", () => {
    const copy = finishedRunNoticeCopy({ finished: true, frozen: true });
    expect(copy?.body).not.toMatch(/you can still/i);
    expect(copy?.body).not.toMatch(/below/i);
  });

  it("names the schedule, not the run, when the run is still live", () => {
    const copy = finishedRunNoticeCopy({ finished: false, frozen: true });
    expect(copy?.heading).toMatch(/schedule/i);
    expect(copy?.body).toMatch(/can't be changed/i);
  });

  // The degenerate state the notice already had to survive: a terminal run whose
  // row exists but never released. Its schedule is NOT frozen, so the notice
  // states the run's own outcome and promises nothing about the form.
  it("states only the outcome for a finished run whose schedule never fired", () => {
    const copy = finishedRunNoticeCopy({ finished: true, frozen: false });
    expect(copy?.body).toBe("It can't be run again.");
  });
});

describe("the screen composes through them (source pin)", () => {
  it("no longer promises a recurring schedule below the notice", () => {
    expect(SCREEN_SRC).not.toContain("You can still give it a recurring");
  });

  // Pinned to the EXPRESSION, not merely to the prop's presence: `readOnly` set
  // from anything other than the freeze predicate would satisfy a looser pin
  // while leaving the two disconnected.
  it("mounts the standalone form read-only when the schedule is frozen", () => {
    expect(SCREEN_SRC).toMatch(
      /<TriggerScreenClient[\s\S]{0,600}?readOnly=\{scheduleFrozen\}/,
    );
  });

  it("reads the freeze off the trigger row through the exported predicate", () => {
    expect(SCREEN_SRC).toContain("shouldFreezeFiredOneOffSchedule(trigger)");
  });
});

describe("the route is unchanged — only the affordance is", () => {
  // A fired immediate row still lands on the standalone branch: the persistent
  // tab is for scheduled/recurring rows and this slice does not move it. What
  // changed is what that branch offers once the one-off has fired.
  it("keeps a finished immediate run off the persistent tab, now frozen", () => {
    const trigger = { triggerType: "immediate", releasedAt: FIRED };
    expect(shouldShowPersistentTab(trigger)).toBe(false);
    expect(shouldShowFinishedRunNotice(trigger, "completed")).toBe(true);
    expect(shouldFreezeFiredOneOffSchedule(trigger)).toBe(true);
  });
});
