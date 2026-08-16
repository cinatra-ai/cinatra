/**
 * Fixture suite for the HELD-TURN CARD CONTRACT.
 *
 * The gate's whole purpose is to fail on a shape a review round had to catch by
 * hand, so the fixtures ARE the specification:
 *
 *   1. The round-1 reproduction — a held dispatch answered by deterministic
 *      prose that names another surface as the decision path, with no card in
 *      the transcript. It must fail, and it must fail on the ALWAYS-ON arm (no
 *      `requireMount` needed): a text pointer is a violation on its own.
 *   2. Mislabeled host — the card anchors present, but satisfied from inside the
 *      inline run card's subtree. A run-card render is not a chat mount, and the
 *      evidence that calls it one is the second anti-pattern this slice is
 *      about.
 *   3. Off position — the card renders somewhere other than its triggering
 *      part's transcript slot.
 *   4. The ruled mount — the card at the triggering slot, outside every foreign
 *      host, with its own decision controls. Clean, including under
 *      `requireMount`.
 *
 * Plus the two structural checks that keep the table honest: it covers the
 * protocol package's closed set of kinds, and every row names an enforcer that
 * really executes it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CARRIAGE_ENFORCERS,
  CHAT_THREAD_CARRIAGE_CONTRACT,
  HELD_RUN_STATUSES,
  HELD_TURN_ROW,
  RULED_KINDS,
  evaluateHeldTurnProjection,
  findDecisionPathPointers,
  isHeldDispatch,
  projectsOwnerCard,
  type ProjectedNode,
  type TurnProjection,
} from "../held-turn-card-contract";

const HELD_RESULT = JSON.stringify({ runId: "run-1", status: "pending_input" });

/** The turn's parts, with the durable agent_run result at slot 0. */
function heldParts(text: string): TurnProjection["parts"] {
  return [
    { kind: "tool_result", slot: 0, name: "agent_run", result: HELD_RESULT },
    { kind: "text", slot: 1, text },
  ];
}

/** A node carrying the full owner anchor set. */
function cardNode(over: Partial<ProjectedNode> = {}): ProjectedNode {
  return {
    anchors: [...HELD_TURN_ROW.ownerAnchors],
    slot: 0,
    insideSubtrees: [],
    ...over,
  };
}

/** The deterministic dispatch text main emits today. */
const CLEAN_DISPATCH_TEXT =
  "Dispatched `@cinatra-ai/planner-agent` (runId: `run-1`, status: `pending_input`).";

describe("held-turn card contract — the decision-path text ban", () => {
  it("flags prose that sends the human to another screen to decide", () => {
    const hits = findDecisionPathPointers(
      "The run is paused. Open the run page to confirm the recommendation.",
    );
    expect(hits.map((h) => h.patternId)).toContain("go-elsewhere-to-decide");
  });

  it("flags prose that locates the decision somewhere other than this conversation", () => {
    const hits = findDecisionPathPointers("You can approve it there when you are ready.");
    expect(hits.map((h) => h.patternId)).toContain("decide-there");
  });

  it("flags a run URL handed over in prose", () => {
    const hits = findDecisionPathPointers(
      "The run is at /agents/proof/tmpl-x/run-1 if you want to look.",
    );
    expect(hits.map((h) => h.patternId)).toContain("run-url-in-prose");
  });

  it("flags a hold described as living on another surface", () => {
    const hits = findDecisionPathPointers(
      "This run needs your approval on the run page before it continues.",
    );
    expect(hits.map((h) => h.patternId)).toContain("waiting-for-you-elsewhere");
  });

  it("does NOT ban the run card's own link label — the ban targets the decision path, not the noun", () => {
    // `InlineAgentRunCard` legitimately offers "Open the run page". A link
    // inside a ruled card is not a text pointer standing in for the card.
    expect(findDecisionPathPointers("Open the run page")).toEqual([]);
    expect(findDecisionPathPointers("The run page shows every step it took.")).toEqual([]);
  });

  it("does NOT flag the deterministic dispatch text main emits today", () => {
    expect(findDecisionPathPointers(CLEAN_DISPATCH_TEXT)).toEqual([]);
    expect(
      findDecisionPathPointers(
        "Dispatched `@cinatra-ai/planner-agent` (runId: `run-1`, status: `queued`). " +
          "The agent is running, and I will keep polling for its progress.",
      ),
    ).toEqual([]);
  });
});

describe("held-turn card contract — held-status recognition", () => {
  it("treats pending_input as a held dispatch", () => {
    expect(HELD_RUN_STATUSES).toContain("pending_input");
    expect(isHeldDispatch({ status: "pending_input" })).toBe(true);
  });

  it("treats a queued or finished dispatch as not held", () => {
    expect(isHeldDispatch({ status: "queued" })).toBe(false);
    expect(isHeldDispatch(null)).toBe(false);
  });
});

describe("held-turn card contract — the four fixtures", () => {
  it("FAILS the round-1 reproduction: a text pointer and no card in the transcript", () => {
    const projection: TurnProjection = {
      parts: heldParts(
        "The agent paused and needs your decision. Open the run page to confirm or skip the recommendation.",
      ),
      nodes: [],
    };
    // The ALWAYS-ON arm alone catches it — a text pointer is a violation
    // whether or not the positive mount arm is switched on.
    const always = evaluateHeldTurnProjection(projection, HELD_TURN_ROW);
    expect(always.map((v) => v.code)).toContain("decision_path_pointer");

    const strict = evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true });
    expect(strict.map((v) => v.code)).toContain("card_not_mounted");
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it("FAILS mislabeled evidence: the anchors satisfied from inside the run card subtree", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode({ insideSubtrees: ["[data-run-card]"] })],
    };
    const violations = evaluateHeldTurnProjection(projection, HELD_TURN_ROW);
    expect(violations.map((v) => v.code)).toContain("anchors_in_foreign_host");
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it('FAILS a card labeled data-lifecycle-card-host="run_card" inside the chat transcript', () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode({ insideSubtrees: ['[data-lifecycle-card-host="run_card"]'] })],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_in_foreign_host",
    );
  });

  it("FAILS a card rendered away from its triggering part's transcript slot", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode({ slot: 4 })],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_off_position",
    );
  });

  it("PASSES a card in its own slot below the trigger when it is keyed by that run", () => {
    // The epic's ruling: the card is keyed by the agent_run tool-result runId.
    // A node that declares that run and follows it is AT the position.
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode({ slot: 2, runBinding: "run-1" })],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true })).toEqual(
      [],
    );
  });

  it("FAILS a card keyed by a DIFFERENT run", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode({ slot: 2, runBinding: "run-other" })],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_off_position",
    );
  });

  it("FAILS a card that precedes its own triggering part", () => {
    const projection: TurnProjection = {
      parts: [
        { kind: "text", slot: 0, text: CLEAN_DISPATCH_TEXT },
        { kind: "tool_result", slot: 1, name: "agent_run", result: HELD_RESULT },
      ],
      nodes: [cardNode({ slot: 0, runBinding: "run-1" })],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_off_position",
    );
  });

  it("FAILS a turn whose triggering tool result carries no durable payload", () => {
    const projection: TurnProjection = {
      parts: [
        { kind: "tool_result", slot: 0, name: "agent_run", result: null },
        { kind: "text", slot: 1, text: CLEAN_DISPATCH_TEXT },
      ],
      nodes: [cardNode()],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "no_durable_result",
    );
  });

  it("PASSES the ruled chat mount, including under the positive arm", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [cardNode()],
    };
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW)).toEqual([]);
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true })).toEqual(
      [],
    );
    expect(projectsOwnerCard(projection)).toBe(true);
  });

  it("PASSES a reload projection rebuilt from the durable result alone", () => {
    // Transcript reload: no live stream, only the persisted tool result and the
    // card the transcript rebuilds from it.
    const reloaded: TurnProjection = {
      parts: [{ kind: "tool_result", slot: 0, name: "agent_run", result: HELD_RESULT }],
      nodes: [cardNode()],
    };
    expect(evaluateHeldTurnProjection(reloaded, HELD_TURN_ROW, { requireMount: true })).toEqual([]);
  });

  it("FAILS a partial mount — the root is there but the decision controls are not", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [
        cardNode({
          anchors: [
            '[data-lifecycle-card="recommendation_hold"]',
            '[data-lifecycle-card-host="chat_thread"]',
          ],
        }),
      ],
    };
    expect(
      evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true }).map(
        (v) => v.code,
      ),
    ).toContain("card_not_mounted");
  });
});

describe("held-turn card contract — the per-kind table", () => {
  it("covers the protocol package's closed set of kinds, once each", () => {
    const kinds = CHAT_THREAD_CARRIAGE_CONTRACT.map((r) => r.kind);
    expect([...kinds].sort()).toEqual([...RULED_KINDS].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("binds only recommendation_hold to the agent_run result and the held dispatch turn", () => {
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (row.kind === "recommendation_hold") {
        expect(row.carriage).toBe("interrupt");
        expect(row.triggerToolName).toBe("agent_run");
      } else {
        expect(row.carriage).toBe("data_part");
        expect(row.triggerToolName).toBeNull();
      }
    }
  });

  it("names a live enforcer on every row — a row with no enforcer is a claim", () => {
    const gate = readFileSync(
      join(process.cwd(), "scripts/audit/chat-hitl-one-card-gate.mjs"),
      "utf8",
    );
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      expect(CARRIAGE_ENFORCERS).toContain(row.enforcer);
      if (row.enforcer === "chat-hitl-one-card-gate") {
        // The sibling gate really carries this kind, so the row is executed
        // there rather than duplicated here.
        expect(gate).toContain(row.kind);
      }
    }
  });

  it("keeps every row's owner anchors disjoint from its foreign-host subtrees", () => {
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      for (const anchor of row.ownerAnchors) {
        expect(row.foreignHostSubtrees).not.toContain(anchor);
      }
    }
  });
});
