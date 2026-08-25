/**
 * Fixture suite for the HELD-TURN CARD CONTRACT evaluator.
 *
 * The transcript suite drives this same evaluator over the PRODUCTION chat view
 * and the REAL card; this file drives it over normalized projections, so the
 * evaluator's own decisions are pinned where they can be read at a glance:
 *
 *   1. The round-1 reproduction — a held dispatch answered by prose that names
 *      another surface as the decision path, with no card in the transcript. It
 *      must fail, and it must fail on the ALWAYS-ON arm.
 *   2. Mislabeled host — the anchors present, but satisfied from inside the
 *      inline run card's subtree. A run-card render is not a chat mount.
 *   3. Off position — the card outside the triggering part's OWN container.
 *      Same turn is not the same place.
 *   4. The ruled mount — the card in the triggering container, outside every
 *      foreign host, with its own decision controls. Clean under `requireMount`.
 *
 * Plus the text ban's own cases, including the EXACT sentence from the round
 * this gate was built after, and the two structural checks that keep the table
 * honest: it covers the protocol package's closed set of kinds, and every row
 * names an enforcer that really executes it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CARRIAGE_ENFORCERS,
  CHAT_THREAD_CARRIAGE_CONTRACT,
  HELD_RUN_STATUSES,
  HELD_TURN_ROW,
  ROOT_DECLARATION_OBLIGATIONS,
  RULED_KINDS,
  HELD_TURN_MOUNT_OBLIGATIONS,
  CHAT_OWNER_MOUNT_OBLIGATIONS,
  LIFECYCLE_CARD_STATE_ANCHOR,
  SHELL_OWNED_CHAT_KINDS,
  carriageRowFor,
  carriesChatOwner,
  chatCarriageRootAnchorsFor,
  chatOwnerMountIsOwed,
  evaluateChatCarriage,
  evaluateHeldTurnProjection,
  findDecisionPathPointers,
  findUnmountedSurfacePointers,
  heldTurnMountIsOwed,
  isHeldDispatch,
  projectsOwnerCard,
  runIdOf,
  type ChatCarriageObservation,
  type ProjectedNode,
  type TurnProjection,
} from "../held-turn-card-contract";

const HELD_RESULT = JSON.stringify({ runId: "run-1", status: "pending_input" });

/**
 * The EXACT sentence the first round shipped in place of the card. Pinned as a
 * literal, because a paraphrase would not prove the ban covers the real one.
 */
const ROUND_ONE_POINTER =
  "confirm or skip the recommended skills on the run card above";

/** The turn's parts, with the durable agent_run result in container 0. */
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
  "Dispatched `@cinatra-ai/proof-agent` (runId: `run-1`, status: `pending_input`).";

describe("the decision-path text ban (defence in depth)", () => {
  it("FAILS the exact first-round sentence — no leading verb, and the surface is a CARD", () => {
    const hits = findDecisionPathPointers(ROUND_ONE_POINTER);
    expect(
      hits,
      "the sentence this gate was built after must not escape the ban",
    ).not.toEqual([]);
    expect(hits.map((h) => h.patternId)).toContain("decide-on-another-surface");
  });

  it("FAILS the same sentence inside a full dispatch answer", () => {
    const hits = findDecisionPathPointers(
      `The agent is waiting on you. You can ${ROUND_ONE_POINTER}.`,
    );
    expect(hits).not.toEqual([]);
  });

  it("flags prose that sends the human to another screen to decide", () => {
    const hits = findDecisionPathPointers(
      "The run is paused. Open the run page to confirm the recommendation.",
    );
    expect(hits.map((h) => h.patternId)).toContain("go-elsewhere-to-decide");
  });

  it("flags a positional locator with no surface noun at all", () => {
    expect(findDecisionPathPointers("You can approve it above.").map((h) => h.patternId)).toContain(
      "decide-elsewhere",
    );
    expect(findDecisionPathPointers("Skip it there if you prefer.").map((h) => h.patternId)).toContain(
      "decide-elsewhere",
    );
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

  it("does NOT ban the run card's own link label — the ban targets the decision path", () => {
    expect(findDecisionPathPointers("Open the run page")).toEqual([]);
    expect(findDecisionPathPointers("The run page shows every step it took.")).toEqual([]);
  });

  it("flags the decision written as a NOUN on another surface", () => {
    // No verb at all, same instruction. An adversarial round found these.
    expect(
      findDecisionPathPointers("Use the review screen for approval.").map((h) => h.patternId),
    ).toContain("another-surface-holds-the-decision");
    expect(
      findDecisionPathPointers("The approval controls are available in run details.").map(
        (h) => h.patternId,
      ),
    ).toContain("decision-lives-on-another-surface");
  });

  it("flags a relocation split across two sentences", () => {
    expect(
      findDecisionPathPointers("Go to the agent page. Approve it there."),
    ).not.toEqual([]);
  });

  it("does NOT flag the deterministic dispatch text main emits today", () => {
    expect(findDecisionPathPointers(CLEAN_DISPATCH_TEXT)).toEqual([]);
    expect(
      findDecisionPathPointers(
        "Dispatched `@cinatra-ai/proof-agent` (runId: `run-1`, status: `queued`). " +
          "The agent is running, and I will keep polling for its progress.",
      ),
    ).toEqual([]);
  });
});

describe("held-status recognition", () => {
  it("treats pending_input as a held dispatch", () => {
    expect(HELD_RUN_STATUSES).toContain("pending_input");
    expect(isHeldDispatch({ status: "pending_input" })).toBe(true);
  });

  it("treats a queued or finished dispatch as not held", () => {
    expect(isHeldDispatch({ status: "queued" })).toBe(false);
    expect(isHeldDispatch(null)).toBe(false);
  });

  it("reads the runId out of the durable payload", () => {
    expect(runIdOf(HELD_RESULT)).toBe("run-1");
    expect(runIdOf("not json")).toBeNull();
    expect(runIdOf(null)).toBeNull();
  });
});

describe("the evaluator's four fixtures", () => {
  it("FAILS the round-1 reproduction: a text pointer and no card in the transcript", () => {
    const projection: TurnProjection = {
      parts: heldParts(`The agent paused. You can ${ROUND_ONE_POINTER}.`),
      nodes: [],
    };
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
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_in_foreign_host",
    );
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

  it("FAILS a card outside the triggering part's OWN container, even later in the same turn", () => {
    for (const slot of [1, 2, 4]) {
      const projection: TurnProjection = {
        parts: heldParts(CLEAN_DISPATCH_TEXT),
        nodes: [cardNode({ slot })],
      };
      expect(
        evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code),
        `container ${slot} is not the triggering container`,
      ).toContain("anchors_off_position");
    }
  });

  it("FAILS a card that precedes its own triggering part", () => {
    const projection: TurnProjection = {
      parts: [
        { kind: "text", slot: 0, text: CLEAN_DISPATCH_TEXT },
        { kind: "tool_result", slot: 1, name: "agent_run", result: HELD_RESULT },
      ],
      nodes: [cardNode({ slot: 0 })],
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

  it("FAILS a partial mount — the row is there but a decision control is not", () => {
    const projection: TurnProjection = {
      parts: heldParts(CLEAN_DISPATCH_TEXT),
      nodes: [
        cardNode({
          anchors: [
            '[data-conformance-id="run-chip-row"]',
            '[data-skill-action="confirm"]',
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

describe("the per-kind table", () => {
  it("covers the protocol package's closed set of kinds, once each", () => {
    const kinds = CHAT_THREAD_CARRIAGE_CONTRACT.map((r) => r.kind);
    expect([...kinds].sort()).toEqual([...RULED_KINDS].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("binds the two INTERRUPT kinds to the agent_run result, and nothing else", () => {
    // The rule is about WHY a kind is an interrupt, not about how many are:
    // the run is genuinely BLOCKED on the answer, so the slot is the dispatch's
    // own tool result. `recommendation_hold` parks before the run starts;
    // `agent_hitl_screen` (cinatra#2928) parks it mid-flight while the agent
    // asks. Every other kind is a fire-and-forget DATA_PART with no tool of its
    // own to bind to.
    const INTERRUPT_KINDS = ["recommendation_hold", "agent_hitl_screen"];
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (INTERRUPT_KINDS.includes(row.kind)) {
        expect(row.carriage).toBe("interrupt");
        expect(row.triggerToolName).toBe("agent_run");
      } else {
        expect(row.carriage).toBe("data_part");
        expect(row.triggerToolName).toBeNull();
      }
    }
  });

  it("names the SHIPPED selectors on the held row, so the ruled mount is accepted", () => {
    // Read straight off the component that draws the card. A contract that
    // asserted a name the component never used would reject the real mount.
    const source = readFileSync(
      join(process.cwd(), "packages/agents/src/run-recommendation-chip-row.tsx"),
      "utf8",
    );
    for (const anchor of HELD_TURN_ROW.ownerAnchors) {
      const attribute = anchor.slice(1, -1); // strip the [ ]
      expect(source, `${anchor} is not emitted by the shipped component`).toContain(attribute);
    }
  });

  it("keeps the ruled root declaration OUT of the enforced anchors while it is owed", () => {
    for (const kind of ROOT_DECLARATION_OBLIGATIONS) {
      const row = CHAT_THREAD_CARRIAGE_CONTRACT.find((r) => r.kind === kind)!;
      for (const ruled of row.ruledRootAnchors) {
        expect(row.ownerAnchors).not.toContain(ruled);
      }
    }
  });

  it("requires the ruled root declaration of every kind that is NOT owed it", () => {
    // `ReviewGateCard` ships `data-lifecycle-card` + `data-lifecycle-card-host`
    // today, so its row carries no obligation and the declaration is expected.
    const source = readFileSync(
      join(process.cwd(), "packages/agents/src/review-gate-card.tsx"),
      "utf8",
    );
    expect(ROOT_DECLARATION_OBLIGATIONS).not.toContain("artifact_review_gate");
    expect(source).toContain('data-lifecycle-card="artifact_review_gate"');
    expect(source).toContain("data-lifecycle-card-host={host}");
  });

  it("names a live enforcer on every row — a row with no enforcer is a claim", () => {
    const gate = readFileSync(
      join(process.cwd(), "scripts/audit/chat-hitl-one-card-gate.mjs"),
      "utf8",
    );
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      expect(CARRIAGE_ENFORCERS).toContain(row.enforcer);
      if (row.enforcer === "chat-hitl-one-card-gate") {
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

describe("the five-kind carriage matrix (cinatra#2827, cinatra#2928)", () => {
  /** One element carrying every root anchor, at the producing slot, with the
   *  row's controls inside it — the shape a real owner produces. */
  function drawnAt(
    kind: (typeof RULED_KINDS)[number],
    slot: number,
    producingSlot = slot,
  ): ChatCarriageObservation {
    const row = carriageRowFor(kind);
    return {
      rootCandidates: [
        {
          anchors: [...chatCarriageRootAnchorsFor(row)],
          slot,
          controls: [...row.decisionControls],
        },
      ],
      producingSlot,
    };
  }

  it("names the kind, the chat host and a state as the ONE root declaration", () => {
    for (const kind of RULED_KINDS) {
      const anchors = chatCarriageRootAnchorsFor(carriageRowFor(kind));
      expect(anchors).toContain(`[data-lifecycle-card="${kind}"]`);
      expect(anchors).toContain('[data-lifecycle-card-host="chat_thread"]');
      expect(anchors).toContain(LIFECYCLE_CARD_STATE_ANCHOR);
    }
  });

  it("gives every kind a decision-control set, and only §VII the empty one", () => {
    // §VII "asks nothing, so it draws nothing to press". Every other kind has a
    // floor, and an empty list anywhere else would be a row a shell could pass.
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (row.kind === "verification_summary") {
        expect(row.decisionControls).toEqual([]);
      } else {
        expect(row.decisionControls.length, row.kind).toBeGreaterThan(0);
      }
    }
  });

  it("names the SHIPPED controls of every kind whose owner is already drawn", () => {
    // Read straight off the components. A contract that named a control the
    // component never emitted would reject the real mount — the same discipline
    // the held row's owner anchors are held to above.
    const sources: Record<string, string> = {
      artifact_review_gate: readFileSync(
        join(process.cwd(), "packages/agents/src/review-decision-bar.tsx"),
        "utf8",
      ),
      recommendation_hold: readFileSync(
        join(process.cwd(), "packages/agents/src/run-recommendation-chip-row.tsx"),
        "utf8",
      ),
      // Added by S9d (cinatra#2788): §VI's owner is drawn, so its two controls
      // stop being a named obligation and become a claim about a shipped
      // component — read off that component, like the two above.
      trigger_schedule_proposal: readFileSync(
        join(process.cwd(), "packages/agents/src/schedule-proposal-card.tsx"),
        "utf8",
      ),
    };
    for (const [kind, source] of Object.entries(sources)) {
      for (const control of carriageRowFor(kind as never).decisionControls) {
        expect(source, `${control} is not emitted by the shipped ${kind} owner`).toContain(
          control.slice(1, -1),
        );
      }
    }
  });

  it("carries the hold's obligation by READING S9h's list, never by repeating it", () => {
    // Two lists naming the same kind is how a struck ratchet goes stale
    // elsewhere. `SHELL_OWNED_CHAT_KINDS` may not name it; the union must.
    expect(SHELL_OWNED_CHAT_KINDS).not.toContain("recommendation_hold");
    for (const kind of HELD_TURN_MOUNT_OBLIGATIONS) {
      expect(CHAT_OWNER_MOUNT_OBLIGATIONS).toContain(kind);
      expect(chatOwnerMountIsOwed(kind)).toBe(true);
    }
    expect([...CHAT_OWNER_MOUNT_OBLIGATIONS].sort()).toEqual(
      [...HELD_TURN_MOUNT_OBLIGATIONS, ...SHELL_OWNED_CHAT_KINDS].sort(),
    );
    // Every owed kind is a ruled kind — an obligation for a kind that does not
    // exist is a row nothing can ever strike.
    for (const kind of CHAT_OWNER_MOUNT_OBLIGATIONS) {
      expect(RULED_KINDS).toContain(kind);
    }
  });

  it("accepts a real owner: root, controls and position together", () => {
    for (const kind of RULED_KINDS) {
      const row = carriageRowFor(kind);
      expect(evaluateChatCarriage(drawnAt(kind, 2), row), kind).toEqual([]);
      expect(carriesChatOwner(drawnAt(kind, 2), row)).toBe(true);
    }
  });

  it("refuses the SHELL's shape — the kind and a state, with no host declared", () => {
    const row = carriageRowFor("verification_summary");
    const shell: ChatCarriageObservation = {
      rootCandidates: [
        {
          anchors: ['[data-lifecycle-card="verification_summary"]', LIFECYCLE_CARD_STATE_ANCHOR],
          slot: 1,
          controls: [],
        },
      ],
      producingSlot: 1,
    };
    expect(evaluateChatCarriage(shell, row).map((v) => v.code)).toEqual([
      "root_declaration_incomplete",
    ]);
  });

  it("refuses a declaration SPLIT across two elements", () => {
    const row = carriageRowFor("artifact_review_gate");
    const split: ChatCarriageObservation = {
      rootCandidates: [
        { anchors: ['[data-lifecycle-card="artifact_review_gate"]'], slot: 1, controls: [] },
        {
          anchors: ['[data-lifecycle-card-host="chat_thread"]', LIFECYCLE_CARD_STATE_ANCHOR],
          slot: 1,
          controls: [...row.decisionControls],
        },
      ],
      producingSlot: 1,
    };
    expect(evaluateChatCarriage(split, row).map((v) => v.code)).toEqual([
      "root_declaration_incomplete",
    ]);
  });

  it("refuses a declared root with no operable floor", () => {
    const row = carriageRowFor("artifact_review_gate");
    const floorless = drawnAt("artifact_review_gate", 1);
    floorless.rootCandidates[0].controls = [];
    expect(evaluateChatCarriage(floorless, row).map((v) => v.code)).toEqual(["controls_absent"]);
  });

  it("refuses a card drawn away from the step that produced it", () => {
    const row = carriageRowFor("artifact_review_gate");
    expect(
      evaluateChatCarriage(drawnAt("artifact_review_gate", 3, 1), row).map((v) => v.code),
    ).toEqual(["root_off_producing_slot"]);
  });

  it("refuses a turn with no producing step at all — that IS the defect", () => {
    const row = carriageRowFor("artifact_review_gate");
    const noSlot = drawnAt("artifact_review_gate", 1);
    expect(
      evaluateChatCarriage({ ...noSlot, producingSlot: null }, row).map((v) => v.code),
    ).toEqual(["no_producing_slot"]);
  });

  it("reports an empty transcript as ABSENT, never as incomplete", () => {
    const row = carriageRowFor("artifact_review_gate");
    expect(
      evaluateChatCarriage({ rootCandidates: [], producingSlot: 1 }, row).map((v) => v.code),
    ).toEqual(["owner_root_absent"]);
  });
});

describe("a cardless held turn: the exemption, and what it costs", () => {
  /**
   * THE SENTENCE NO DECISION-VERB PATTERN MATCHES. It names the surface as a
   * bare noun and never conjugates confirm/approve/decide, so every entry in
   * `DECISION_PATH_POINTER_PATTERNS` reads it as clean — which is the finding
   * this block answers. Pinned as a literal for the same reason the first-round
   * sentence is.
   */
  const VERBLESS_POINTER = "The controls you need are in run details.";

  const cardless = (text: string): TurnProjection => ({ parts: heldParts(text), nodes: [] });

  it("the verb-anchored ban does NOT catch it — stated so the gap is not re-argued", () => {
    expect(findDecisionPathPointers(VERBLESS_POINTER)).toEqual([]);
  });

  it("the cardless arm DOES catch it, with no verb to anchor on", () => {
    expect(findUnmountedSurfacePointers(VERBLESS_POINTER).map((h) => h.patternId)).toEqual([
      "surface-named-with-no-card",
    ]);
  });

  it("FAILS a held turn that mounts no card and points at another surface", () => {
    const codes = evaluateHeldTurnProjection(cardless(VERBLESS_POINTER), HELD_TURN_ROW).map(
      (v) => v.code,
    );
    // The always-on arm, with no `requireMount` asked for. Since S9b landed the
    // mount the row is struck, so the missing card is refused too — but the
    // point of this case is that the POINTER is refused on its own terms, with
    // no verb to anchor on, which is why the assertion stays a `toContain`.
    expect(codes).toContain("surface_pointer_without_card");
  });

  it("no longer passes the cardless turn — the exemption expired with the row", () => {
    // This case used to record the exemption: main shipped a held turn with no
    // card, its dispatch text named no surface, and the standing obligation row
    // made that clean. S9b (cinatra#2786) landed the chat mount and the row was
    // struck, so the SAME projection is now refused — and refused for the card
    // alone, since the text still names no surface. That single code is the
    // proof the strike moved this, rather than some prose regression.
    expect(
      evaluateHeldTurnProjection(cardless(CLEAN_DISPATCH_TEXT), HELD_TURN_ROW).map((v) => v.code),
    ).toEqual(["card_not_mounted"]);
    // And the turn with the card is clean, which is what the mount buys.
    expect(
      evaluateHeldTurnProjection(
        { parts: heldParts(CLEAN_DISPATCH_TEXT), nodes: [cardNode()] },
        HELD_TURN_ROW,
      ),
    ).toEqual([]);
  });

  it("stops applying the cardless arm once the card IS mounted", () => {
    // The trade-off, stated as a case: prose about another surface is honest
    // beside a working card, and only the relocated DECISION is banned there.
    const mounted: TurnProjection = {
      parts: heldParts("The run page shows every step."),
      nodes: [cardNode()],
    };
    expect(evaluateHeldTurnProjection(mounted, HELD_TURN_ROW)).toEqual([]);
    expect(
      evaluateHeldTurnProjection(cardless("The run page shows every step."), HELD_TURN_ROW).map(
        (v) => v.code,
      ),
    ).toContain("surface_pointer_without_card");
  });

  it("refuses a bare run URL in a cardless turn", () => {
    expect(
      evaluateHeldTurnProjection(
        cardless("Everything is at /agents/proof/pkg/run-1 now."),
        HELD_TURN_ROW,
      ).map((v) => v.code),
    ).toContain("surface_pointer_without_card");
  });
});

describe("the positive arm is the DEFAULT, and the obligation list is its only exemption", () => {
  it("exempts exactly the kinds whose mount is still owed", () => {
    for (const kind of RULED_KINDS) {
      expect(heldTurnMountIsOwed(kind)).toBe(HELD_TURN_MOUNT_OBLIGATIONS.includes(kind));
    }
  });

  it("DEMANDS the card for the held kind now that its row is struck", () => {
    // `recommendation_hold` was the one row on the list. S9b (cinatra#2786)
    // landed the production chat_thread mount, the row was struck, and the arm
    // turned itself on — nobody passed a flag. A cardless held turn is a
    // failure for this kind now, which is the state this whole module was built
    // to reach.
    expect(heldTurnMountIsOwed(HELD_TURN_ROW.kind)).toBe(false);
    expect(
      evaluateHeldTurnProjection(
        { parts: heldParts(CLEAN_DISPATCH_TEXT), nodes: [] },
        HELD_TURN_ROW,
      ).map((v) => v.code),
    ).toContain("card_not_mounted");
  });

  it("exempts exactly the kind that declared its own row, and no other", () => {
    // The list is the ONLY ruled reason a held turn may show no card, and it
    // was emptied by S9b. A future kind arriving unmounted therefore has to add
    // its OWN row deliberately rather than inherit an exemption — which is
    // exactly what cinatra#2928 did when it registered `agent_hitl_screen`
    // without drawing it. W3 (cinatra#2930) lands the mount and strikes the
    // row; this assertion turns red the day either half moves alone.
    expect([...HELD_TURN_MOUNT_OBLIGATIONS]).toEqual(["agent_hitl_screen"]);
    for (const kind of RULED_KINDS) {
      expect(heldTurnMountIsOwed(kind)).toBe(kind === "agent_hitl_screen");
    }
  });

  it("DEMANDS the card for a kind whose row is struck, without anyone passing a flag", () => {
    // The point of the default. A row struck from the obligation list turns the
    // assertion on by itself; it used to also need a caller to opt in, and every
    // caller that did not read as exempt.
    const landed = { ...HELD_TURN_ROW, kind: "artifact_review_gate" as const };
    expect(heldTurnMountIsOwed(landed.kind)).toBe(false);
    expect(
      evaluateHeldTurnProjection({ parts: heldParts(CLEAN_DISPATCH_TEXT), nodes: [] }, landed).map(
        (v) => v.code,
      ),
    ).toContain("card_not_mounted");
  });

  it("still lets a caller ask for the arm explicitly", () => {
    expect(
      evaluateHeldTurnProjection({ parts: heldParts(CLEAN_DISPATCH_TEXT), nodes: [] }, HELD_TURN_ROW, {
        requireMount: true,
      }).map((v) => v.code),
    ).toContain("card_not_mounted");
  });
});
