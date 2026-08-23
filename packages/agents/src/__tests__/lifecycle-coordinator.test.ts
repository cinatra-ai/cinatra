/**
 * THE COORDINATOR'S OWN DECISIONS (cinatra#2928, epic #2926 W2a).
 *
 * The three things this module decides, and nothing else decides for it:
 *
 *   1. VERIFIED HUMAN PRESENCE. Both halves are required — a verified
 *      interactive surface AND a resolvable human owner. This is cinatra#2892:
 *      the chat pre-router stamped its surface as a CONSTANT, so a non-human
 *      principal reaching it produced a run marked human-present with nobody to
 *      show a card to.
 *   2. THE SCHEDULE DEFAULT. Run right after setup unless the person stated a
 *      schedule, and never for a run nobody is present for. It lives here
 *      because a schedule has no artifact type, destination or origin, so it is
 *      not a row in the policy table.
 *   3. WHICH MOMENTS PARK THE RUN. Four of five do; the audit is a reading.
 *
 * Pure decisions only — the entries that write are exercised against the real
 * store in the DB-backed tier, and the producer inventory is walked next door.
 */
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_MOMENTS,
  lifecycleMomentParksRun,
  type LifecycleMoment,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  cardKindForMoment,
  scheduleDefaultForLaunch,
  verifiedHumanPresence,
} from "../lifecycle-coordinator";

describe("verified human presence", () => {
  it("is TRUE for a delegated chat frame carrying its principal", () => {
    expect(
      verifiedHumanPresence({ frame: { delegatedRestricted: true, userId: "user-1" } }),
    ).toBe(true);
  });

  it("is TRUE for the in-process pre-router's stamp with a human principal", () => {
    expect(verifiedHumanPresence({ frame: { launchOrigin: "chat", userId: "user-1" } })).toBe(
      true,
    );
  });

  it("cinatra#2892: is FALSE for a chat-surface frame with NO resolvable owner", () => {
    // THE DEFECT, stated as a case. The surface is verified and the stamp is
    // real; what is missing is the person. A run marked human-present here can
    // reach the recommendation moment, and the only card that could release it
    // belongs to nobody.
    expect(verifiedHumanPresence({ frame: { launchOrigin: "chat" } })).toBe(false);
    expect(verifiedHumanPresence({ frame: { delegatedRestricted: true } })).toBe(false);
    expect(verifiedHumanPresence({ frame: { launchOrigin: "chat", userId: "" } })).toBe(false);
  });

  it("accepts an interactive producer's own claim, but still needs the owner", () => {
    expect(verifiedHumanPresence({ frame: null, interactive: true, runBy: "user-1" })).toBe(true);
    expect(verifiedHumanPresence({ frame: null, interactive: true })).toBe(false);
    expect(verifiedHumanPresence({ frame: null, interactive: true, runBy: null })).toBe(false);
  });

  it("is FALSE for every headless origin", () => {
    expect(verifiedHumanPresence({ frame: null })).toBe(false);
    expect(verifiedHumanPresence({ frame: undefined })).toBe(false);
    expect(verifiedHumanPresence({ frame: {}, runBy: "user-1" })).toBe(false);
    // A run created FOR a person by a scheduler is still nobody-present.
    expect(verifiedHumanPresence({ frame: { userId: "user-1" }, runBy: "user-1" })).toBe(false);
  });

  it("cannot be widened by a truthy-but-wrong value", () => {
    for (const wrong of ["true", 1, {}, [], "chatty"]) {
      expect(
        verifiedHumanPresence({ frame: { delegatedRestricted: wrong, userId: "user-1" } }),
        String(wrong),
      ).toBe(false);
      expect(
        verifiedHumanPresence({ frame: { launchOrigin: wrong, userId: "user-1" } }),
        String(wrong),
      ).toBe(false);
    }
  });
});

describe("the schedule default", () => {
  it("is run-right-after-setup for a person's run", () => {
    expect(scheduleDefaultForLaunch({ humanPresent: true })).toEqual({ kind: "run_after_setup" });
  });

  it("takes what the person stated when they stated one", () => {
    const schedule = { kind: "one_off", at: "2026-09-01T09:00:00" };
    expect(scheduleDefaultForLaunch({ humanPresent: true, statedSchedule: schedule })).toEqual({
      kind: "stated",
      schedule,
    });
  });

  it("offers NOTHING for a run nobody is present for, and says why", () => {
    const answer = scheduleDefaultForLaunch({ humanPresent: false });
    expect(answer.kind).toBe("none");
    if (answer.kind === "none") expect(answer.why.length).toBeGreaterThan(20);
  });

  it("does not read a stated schedule for a headless run — presence decides first", () => {
    expect(
      scheduleDefaultForLaunch({ humanPresent: false, statedSchedule: { kind: "one_off" } }).kind,
    ).toBe("none");
  });
});

describe("the five moments", () => {
  it("each names exactly one card", () => {
    const kinds = LIFECYCLE_MOMENTS.map((m) => cardKindForMoment(m));
    expect(new Set(kinds).size, "two moments share a card").toBe(kinds.length);
    for (const kind of kinds) expect(kind.length).toBeGreaterThan(0);
  });

  it("park the run — except the audit, which is a reading", () => {
    const parking = LIFECYCLE_MOMENTS.filter((m: LifecycleMoment) => lifecycleMomentParksRun(m));
    expect([...parking].sort()).toEqual(["hitl", "recommendation", "review", "schedule"]);
    expect(lifecycleMomentParksRun("audit")).toBe(false);
  });
});
