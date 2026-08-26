/**
 * THE COORDINATOR FEEDS THE OUTBOX WHEN A MOMENT OPENS (cinatra#2930, W3).
 *
 * The plan: "In a conversation the platform itself writes the card into the
 * run's own turn, from an outbox the coordinator feeds when a moment opens".
 *
 * The producer seam and the writer are proved on their own next door. What is
 * proved HERE is the join: the coordinator's own moment write is what opens the
 * outbox entry, it carries the moment's card kind and reference, it happens
 * AFTER the record rather than before it, and a cleared moment feeds nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
const recordRunLifecycleMoment = vi.fn(async () => {
  order.push("record");
});
const readAgentRunById = vi.fn(async () => null);

vi.mock("../store", () => ({
  createAgentRun: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...(a as [])),
  recordRunLifecycleMoment: (...a: unknown[]) =>
    recordRunLifecycleMoment(...(a as [])),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code = "stale_from_status";
  },
}));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn(async () => undefined) }));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));

import { clearRunLifecycleMoment, onAgentHitl } from "../lifecycle-coordinator";
import {
  setLifecyclePartOutbox,
  type LifecycleMomentOpened,
} from "../lifecycle-part-outbox";

const RUN = {
  id: "run-1",
  orgId: "org-1",
  status: "pending_approval",
} as never;

let opened: LifecycleMomentOpened[] = [];

beforeEach(() => {
  order.length = 0;
  opened = [];
  recordRunLifecycleMoment.mockClear();
  setLifecyclePartOutbox({
    async onMomentOpened(entry) {
      order.push("outbox");
      opened.push(entry);
    },
  });
});

describe("a moment opening", () => {
  it("feeds the outbox with the moment's own card kind and reference", async () => {
    await onAgentHitl({ run: RUN, screenRef: "hitl-ref-1", authority: undefined });
    expect(opened).toEqual([
      {
        runId: "run-1",
        orgId: "org-1",
        moment: "hitl",
        cardKind: "agent_hitl_screen",
        cardRef: "hitl-ref-1",
      },
    ]);
  });

  it("feeds it AFTER the record, never before", async () => {
    // The injected part points AT the run's stated moment, so a part written
    // first would name a moment the row does not state yet.
    await onAgentHitl({ run: RUN, screenRef: "hitl-ref-1", authority: undefined });
    expect(order).toEqual(["record", "outbox"]);
  });

  it("carries the screen's OWN reference, never a re-derived one", async () => {
    // The card reference is the moment's one server-checked route back to the
    // screen; an outbox entry that invented one would point a person at a card
    // the server never sealed.
    await onAgentHitl({ run: RUN, screenRef: "screen-ref-9", authority: undefined });
    expect(opened[0]?.cardRef).toBe("screen-ref-9");
  });
});

describe("a moment being CLEARED", () => {
  it("feeds nothing — there is no card to put anywhere", async () => {
    await clearRunLifecycleMoment("run-1", undefined);
    expect(opened).toEqual([]);
  });
});

describe("with no host wired", () => {
  it("states the moment anyway", async () => {
    setLifecyclePartOutbox(null);
    await onAgentHitl({ run: RUN, screenRef: "r", authority: undefined });
    expect(recordRunLifecycleMoment).toHaveBeenCalled();
  });
});
