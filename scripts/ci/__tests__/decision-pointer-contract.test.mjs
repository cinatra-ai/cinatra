// Fixture tests for the DECISION-POINTER CONTRACT (cinatra#2821, epic #2784 S9h).
//
// The contract is only worth having if it holds from both sides, so every arm is
// tested with the sentence that must FAIL and the honest sentence that must PASS.
// The anti-patterns are the ones #2794's first round actually shipped; the honest
// texts are lifted from the shipped code, so a change that starts refusing real
// copy fails here rather than in someone's review.

import { describe, expect, it } from "vitest";

import {
  classifyDecisionPointer,
  evaluateHeldTurnRecord,
} from "../lib/decision-pointer-contract.mjs";

/** The exact sentence #2794's first round answered a parked dispatch with. */
const FIRST_ROUND_POINTER =
  "confirm or skip the recommended skills on the run card above";

describe("classifyDecisionPointer — the anti-patterns", () => {
  it("refuses the exact first-round sentence", () => {
    const { pointer, findings } = classifyDecisionPointer(FIRST_ROUND_POINTER);
    expect(pointer).toBe(true);
    expect(findings.map((f) => f.arm)).toContain("decide-elsewhere");
  });

  it("refuses a decision verb tied to another surface", () => {
    for (const text of [
      "Approve the change on the review page when you are ready.",
      "You can confirm the recommendation in the run details.",
      "Skip the suggested skills from the agents screen.",
      "Decide this in the side panel.",
    ]) {
      expect(classifyDecisionPointer(text).pointer, text).toBe(true);
    }
  });

  it("refuses a decision verb tied to a bare position", () => {
    for (const text of [
      "Confirm or skip the recommended skills above.",
      "Approve it there and the run continues.",
      "You can decide it below.",
    ]) {
      expect(classifyDecisionPointer(text).pointer, text).toBe(true);
    }
  });

  it("refuses the decision written as a noun that lives elsewhere", () => {
    const text = "The approval controls are available in run details.";
    const { pointer, findings } = classifyDecisionPointer(text);
    expect(pointer).toBe(true);
    expect(findings.map((f) => f.arm)).toContain("decision-as-noun-elsewhere");
  });

  it("refuses a surface named as the place you go to decide", () => {
    const { pointer, findings } = classifyDecisionPointer(
      "Use the review screen for approval.",
    );
    expect(pointer).toBe(true);
    expect(findings.map((f) => f.arm)).toContain("surface-for-decision");
  });

  it("refuses navigate-then-decide split across two sentences", () => {
    const { pointer, findings } = classifyDecisionPointer(
      "Go to the agent page. Approve it there.",
    );
    expect(pointer).toBe(true);
    expect(findings.map((f) => f.arm)).toEqual(
      expect.arrayContaining(["navigate-then-decide"]),
    );
  });
});

describe("classifyDecisionPointer — the honest texts that must pass", () => {
  it("leaves the shipped run-page link alone", () => {
    // packages/chat/src/inline-agent-run-card.tsx ships this label. The card is
    // still the decision path; the link beside it is a convenience.
    expect(classifyDecisionPointer("Open the run page").pointer).toBe(false);
  });

  it("leaves the shipped dispatch answer alone", () => {
    const text =
      "Dispatched `@cinatra-ai/example` (runId: `VALUE`, status: `queued`). The agent is running — I'll keep polling for its progress.";
    expect(classifyDecisionPointer(text).pointer).toBe(false);
  });

  it("leaves the shipped no-run-URL directive alone", () => {
    for (const text of [
      "**Never write a run URL yourself.** The run plays out on a live card in this",
      "conversation, so the user needs no link to act on it, and the card carries",
      "its own link to the run page. A path you compose from a run id does not",
      "- Do NOT ask for confirmation first.",
      "`agent_run_get` until the run reaches `completed | failed | pending_approval | stopped`",
    ]) {
      expect(classifyDecisionPointer(text).pointer, text).toBe(false);
    }
  });

  it("leaves a decision with no place attached alone", () => {
    for (const text of [
      "I'll ask you to confirm before this agent runs.",
      "Confirm the recommended skills to start the run.",
      "This run was skipped because the connector is not configured.",
    ]) {
      expect(classifyDecisionPointer(text).pointer, text).toBe(false);
    }
  });

  it("says nothing about empty or non-string input", () => {
    expect(classifyDecisionPointer("").pointer).toBe(false);
    expect(classifyDecisionPointer(undefined).pointer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The structural half
// ---------------------------------------------------------------------------

/** The ruled shape: the card mounts at the triggering position, on the origin. */
const RULED_CHAT_MOUNT = {
  status: "pending_input",
  originHost: "chat_thread",
  toolResults: [
    {
      id: "synthetic-agent-run-1",
      name: "agent_run",
      result: JSON.stringify({ runId: "8f1c2b70-1", status: "pending_input" }),
    },
  ],
  card: {
    mounted: true,
    actionable: true,
    host: "chat_thread",
    toolCallId: "synthetic-agent-run-1",
  },
  text: "Dispatched `@cinatra-ai/example`. It is waiting on you.",
};

describe("evaluateHeldTurnRecord", () => {
  it("passes the ruled chat mount", () => {
    expect(evaluateHeldTurnRecord(RULED_CHAT_MOUNT)).toEqual([]);
  });

  it("fails #2794's first round: pointer prose, no card", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      card: { mounted: false },
      text: `The run is waiting — ${FIRST_ROUND_POINTER}.`,
    }).map((v) => v.code);
    expect(codes).toContain("held-turn/no-card-in-turn");
    expect(codes).toContain("held-turn/decision-pointer");
  });

  it("fails a card mounted on a foreign host", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      card: { ...RULED_CHAT_MOUNT.card, host: "run_card" },
    }).map((v) => v.code);
    expect(codes).toEqual(["held-turn/card-foreign-host"]);
  });

  it("fails a card that is somewhere else in the same turn", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      card: { ...RULED_CHAT_MOUNT.card, toolCallId: "some-later-part" },
    }).map((v) => v.code);
    expect(codes).toEqual(["held-turn/card-outside-triggering-position"]);
  });

  it("fails a card with no decision control", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      card: { ...RULED_CHAT_MOUNT.card, actionable: false },
    }).map((v) => v.code);
    expect(codes).toEqual(["held-turn/card-not-actionable"]);
  });

  it("fails a parked turn with no durable result to reload from", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      toolResults: [],
    }).map((v) => v.code);
    expect(codes).toContain("held-turn/missing-durable-result");
  });

  it("fails a durable result carrying no runId", () => {
    const codes = evaluateHeldTurnRecord({
      ...RULED_CHAT_MOUNT,
      toolResults: [
        { id: "synthetic-agent-run-1", name: "agent_run", result: "{}" },
      ],
    }).map((v) => v.code);
    expect(codes).toContain("held-turn/durable-result-without-runid");
  });

  it("says nothing about a turn that did not park", () => {
    expect(
      evaluateHeldTurnRecord({ ...RULED_CHAT_MOUNT, status: "queued", card: undefined }),
    ).toEqual([]);
  });
});
