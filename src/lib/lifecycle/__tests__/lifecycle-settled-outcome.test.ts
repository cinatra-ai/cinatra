// The settled reading's attachment contract (cinatra#2855; plan §4.2).
//
// Every assertion here is about one of three things: what unlocks the read (the
// STATE, and nothing else), what a reader may LEARN from it (an outcome and a
// display name — never an identifier), and what a failure may COST (the
// reading, never the card).

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const readReviewGate = vi.fn();

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: (...args: unknown[]) => readReviewGate(...args),
}));

/** The two display columns the projection is allowed to ask for. */
let userRows: Array<{ name: string | null; username: string | null }> = [];
/** Every column set the projection actually asked the user table for. */
const selectedColumns: string[][] = [];

vi.mock("@/lib/better-auth-db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => userRows,
  };
  return {
    betterAuthDb: {
      select: (cols: Record<string, unknown>) => {
        selectedColumns.push(Object.keys(cols));
        return chain;
      },
    },
    betterAuthUsers: {
      id: "user.id",
      name: "user.name",
      username: "user.username",
      email: "user.email",
    },
  };
});

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { attachLifecycleSettledOutcome } from "../lifecycle-settled-outcome";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

const SETTLED: LifecycleCardState = { state: "settled" };

/** The decider's own row. Its id and address are here precisely so the negative
 *  control below can prove neither of them reaches the card. */
const DECIDER_USER_ID = "usr_4f3a9c21e8b7";
const DECIDER_EMAIL = "dana.okonkwo@example.test";

function resolvedGate(
  disposition: string | null,
  resolvedBy: string | null = DECIDER_USER_ID,
) {
  return {
    id: "gate-1",
    runId: "run-1",
    orgId: "org-1",
    reviewTaskId: "task-1",
    status: "resolved",
    pinnedTargets: [],
    disposition,
    fingerprint: "fp-1",
    resolvedBy,
    resolvedAt: new Date("2026-08-19T10:00:00Z"),
    createdAt: new Date("2026-08-19T09:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectedColumns.length = 0;
  userRows = [{ name: "Dana Okonkwo", username: "dokonkwo" }];
});

describe("the state is the authorization", () => {
  it("never reads the gate for a state that cannot carry an outcome", async () => {
    const states: LifecycleCardState[] = [
      { state: "loading" },
      { state: "pending", canDecide: true, canComment: true },
      {
        state: "restricted",
        canDecide: false,
        canComment: true,
        reason: "Approving or rejecting needs approve access on this run.",
      },
      { state: "advisory" },
      { state: "absent" },
    ];
    for (const state of states) {
      expect(
        await attachLifecycleSettledOutcome(state, "artifact_review_gate", REF),
      ).toEqual(state);
    }
    // `absent` is the ladder's collapse of EVERY denial — no run access, no
    // gate, a ref that does not decode. None of them reaches a store.
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("never reads the gate for another card kind", async () => {
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "verification_summary", REF),
    ).toEqual(SETTLED);
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "trigger_schedule_proposal", REF),
    ).toEqual(SETTLED);
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("never reads the gate for a ref that does not decode", async () => {
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", "not-a-ref"),
    ).toEqual(SETTLED);
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("reads the gate the REF addresses, and only that one", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF);
    expect(readReviewGate).toHaveBeenCalledTimes(1);
    expect(readReviewGate).toHaveBeenCalledWith("run-1", "task-1");
  });
});

describe("the recorded outcome", () => {
  it("names each of the three dispositions a resolved gate can hold", async () => {
    const cases: Array<[string, string]> = [
      ["approve", "approved"],
      ["reject", "rejected"],
      ["changes_requested", "changes_requested"],
    ];
    for (const [disposition, outcome] of cases) {
      readReviewGate.mockResolvedValue(resolvedGate(disposition));
      expect(
        await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
      ).toEqual({ state: "settled", outcome, decidedByName: "Dana Okonkwo" });
    }
  });

  it("keeps the recorded suggestion partition the chips already attached", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    const withChips: LifecycleCardState = {
      state: "settled",
      suggestions: [
        { id: "s1", label: "content.body", op: "replace", message: "m", mark: "accepted" },
      ],
    };
    const out = await attachLifecycleSettledOutcome(
      withChips,
      "artifact_review_gate",
      REF,
    );
    expect(out).toEqual({ ...withChips, outcome: "approved", decidedByName: "Dana Okonkwo" });
  });

  it("attaches NOTHING for a disposition outside the closed set", async () => {
    // A `comment` never resolves a gate; the other two are a build this one does
    // not know. All degrade to the generic reading rather than to a guess.
    for (const disposition of ["comment", "withdrawn", "APPROVE", ""]) {
      readReviewGate.mockResolvedValue(resolvedGate(disposition));
      expect(
        await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
      ).toEqual(SETTLED);
    }
  });

  it("attaches NOTHING for a gate row with no disposition at all", async () => {
    // The record that predates the outcome. Absence is legal and is not an
    // error: the card draws exactly what it drew before.
    readReviewGate.mockResolvedValue(resolvedGate(null));
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual(SETTLED);
  });

  it("attaches NOTHING for a gate that is missing or no longer resolved", async () => {
    readReviewGate.mockResolvedValue(null);
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual(SETTLED);
    readReviewGate.mockResolvedValue({ ...resolvedGate("approve"), status: "pending" });
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual(SETTLED);
  });

  it("costs the READING, never the card, when a store throws", async () => {
    readReviewGate.mockRejectedValue(new Error("connection reset"));
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual(SETTLED);
  });
});

describe("the decider is a display name, never an identifier", () => {
  it("NEGATIVE CONTROL: neither the user id nor the email reaches the state", async () => {
    // The name is what travels. The id the gate stores and the address the user
    // row carries are both in play here — the row is the decider's own — and
    // neither may appear anywhere in the answer.
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    userRows = [{ name: "Dana Okonkwo", username: "dokonkwo" }];
    const out = await attachLifecycleSettledOutcome(
      SETTLED,
      "artifact_review_gate",
      REF,
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(DECIDER_USER_ID);
    expect(serialized).not.toContain(DECIDER_EMAIL);
    expect(serialized).not.toContain("example.test");
    expect(out).toEqual({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
    });
  });

  it("never even ASKS the user table for the address", async () => {
    // A column that is never selected cannot be printed by a later edit
    // reaching for "whatever we have".
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF);
    expect(selectedColumns).toEqual([["name", "username"]]);
  });

  it("falls back to the handle, then to no name at all", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("reject"));
    userRows = [{ name: null, username: "dokonkwo" }];
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual({ state: "settled", outcome: "rejected", decidedByName: "dokonkwo" });

    // No displayable name → the OUTCOME ALONE. "Rejected" is true; a stand-in
    // built from an identifier would be a leak wearing a label.
    userRows = [{ name: "   ", username: null }];
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual({ state: "settled", outcome: "rejected" });

    userRows = [];
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual({ state: "settled", outcome: "rejected" });
  });

  it("never looks a decider up when the gate recorded none", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("approve", null));
    expect(
      await attachLifecycleSettledOutcome(SETTLED, "artifact_review_gate", REF),
    ).toEqual({ state: "settled", outcome: "approved" });
    expect(selectedColumns).toEqual([]);
  });

  it("strips control characters and collapses whitespace before printing", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    userRows = [{ name: "Dana‮\tOkonkwo​\n", username: null }];
    const out = await attachLifecycleSettledOutcome(
      SETTLED,
      "artifact_review_gate",
      REF,
    );
    expect(out).toEqual({
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
    });
  });

  it("clamps a pathological name to the wire ceiling", async () => {
    readReviewGate.mockResolvedValue(resolvedGate("approve"));
    userRows = [{ name: "n".repeat(500), username: null }];
    const out = (await attachLifecycleSettledOutcome(
      SETTLED,
      "artifact_review_gate",
      REF,
    )) as { decidedByName: string };
    expect(out.decidedByName).toHaveLength(80);
  });
});
