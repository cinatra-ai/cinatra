// WHERE A WAIT'S NOTIFICATION LANDS (cinatra#2930, epic #2926 W3).
//
// The plan: "When a run waits at a moment, the notification links to the
// conversation the run was started from — for the review as for a question —
// and to the run page otherwise."
//
// The point of a separate reader is that this is a SECOND question. A review is
// still an approval for COPY — `classifyRunWaitInterrupt` goes on saying so, so
// the badge and the notification wording are untouched — and only the
// destination moves.

import { describe, expect, it } from "vitest";

import {
  classifyRunWaitInterrupt,
  waitNotificationLandsInConversation,
} from "../run-surface-status";

describe("the review wait now lands in the conversation", () => {
  it("sends a run at its REVIEW moment to the conversation", () => {
    expect(waitNotificationLandsInConversation({ lifecycleMoment: "review" })).toBe(true);
  });

  it("keeps the review's APPROVAL copy — only the link moved", () => {
    expect(classifyRunWaitInterrupt({ lifecycleMoment: "review" })).toBe("approval");
  });

  it("sends a run at its HITL moment there too, exactly as before", () => {
    expect(waitNotificationLandsInConversation({ lifecycleMoment: "hitl" })).toBe(true);
    expect(classifyRunWaitInterrupt({ lifecycleMoment: "hitl" })).toBe("input");
  });

  it("keeps the pre-existing setup-field route through the heuristics beneath", () => {
    expect(waitNotificationLandsInConversation({ fieldName: "recipient" })).toBe(true);
    expect(waitNotificationLandsInConversation({ reviewTaskId: "setup-run-1" })).toBe(true);
  });
});

describe("everything else keeps the run page", () => {
  it("fails closed with nothing readable", () => {
    expect(waitNotificationLandsInConversation(null)).toBe(false);
    expect(waitNotificationLandsInConversation(undefined)).toBe(false);
    expect(waitNotificationLandsInConversation({})).toBe(false);
  });

  it("keeps a plain approval gate on the run page", () => {
    expect(waitNotificationLandsInConversation({ reviewTaskId: "task-9" })).toBe(false);
  });

  it("says nothing about the two moments that are not interrupts at all", () => {
    // A run parked for its skills question or its schedule is not waiting at an
    // interrupt; the classifier keeps its fail-closed answer and so does this.
    expect(waitNotificationLandsInConversation({ lifecycleMoment: "recommendation" })).toBe(false);
    expect(waitNotificationLandsInConversation({ lifecycleMoment: "schedule" })).toBe(false);
  });
});
