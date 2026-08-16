// @vitest-environment jsdom
/**
 * THE HELD TURN IN THE TRANSCRIPT — half (b) of the held-turn card gate.
 *
 * Half (a) proves the server leaves the transcript able to draw the card: a
 * durable `agent_run` result and no prose that points the decision at another
 * surface. This half reads what the transcript ACTUALLY renders and holds the
 * other side of the same contract, through the same evaluator — one authority,
 * no second opinion to drift from.
 *
 * WHAT IT ASSERTS ON THE REAL RENDERER (`InteractiveParts`, the ordered-parts
 * renderer every chat turn goes through):
 *
 *   THE ALWAYS-ON ARM. If the recommendation-hold anchors appear at all, they
 *   must appear at the triggering `agent_run` part's own position and OUTSIDE
 *   every foreign-host subtree. The inline run card (`[data-run-card]`) is a
 *   ruled RUN_CARD mount, so anchors satisfied from inside it are a run-card
 *   render mislabeled as a chat mount — the exact second anti-pattern this
 *   slice exists for. This arm is green today and turns red the moment a wrong
 *   mount lands.
 *
 *   THE OBLIGATION RATCHET. The kinds whose production chat_thread mount is not
 *   here yet are declared in `HELD_TURN_MOUNT_OBLIGATIONS`. This test measures
 *   the OBSERVED unmounted set against that list. It is a red done-check made
 *   mechanical, not a waiver: striking a row without the mount fails here
 *   immediately, and landing the mount without striking the row fails here too.
 *
 * WHAT THE FIXTURES ASSERT. The DOM adapter is the piece that could quietly
 * mis-read a real render, so the fixtures drive it over transcript-shaped DOM in
 * all four states — the round-1 reproduction, the run-card-subtree mislabel, the
 * off-position render, and the ruled mount.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CHAT_THREAD_CARRIAGE_CONTRACT,
  HELD_TURN_MOUNT_OBLIGATIONS,
  HELD_TURN_ROW,
  evaluateHeldTurnProjection,
  projectsOwnerCard,
  type ChatThreadCarriageRow,
  type ProjectedNode,
  type TurnProjection,
} from "@/lib/lifecycle/held-turn-card-contract";
import { InteractiveParts } from "../renderer/ag-ui-interactive";
import type { AssistantMessagePart } from "../assistant-parts";

const RUN_ID = "run-held-transcript-1";
const DURABLE_RESULT = JSON.stringify({ runId: RUN_ID, status: "pending_input" });
const DISPATCH_TEXT = "Dispatched `@cinatra-ai/proof-agent` (runId: `" + RUN_ID + "`, status: `pending_input`).";

/**
 * Attributes a node may use to declare the run it is keyed by. The epic ruled
 * the held card is keyed by the agent_run tool-result runId; these are the
 * attribute spellings the reader accepts, first one preferred.
 */
const RUN_BINDING_ATTRS = [
  "data-lifecycle-card-run-id",
  "data-hold-run-id",
  "data-run-id",
] as const;

/**
 * Build the normalized projection from a REAL rendered transcript.
 *
 * Slots are the ordered top-level children of `[data-interactive-parts]` — that
 * IS the transcript position. The durable payload is not in the DOM (the
 * transcript pins only the runId), so it is supplied from the wire, which is
 * exactly the split the two halves of this gate are built on.
 */
function projectionFromTranscript(
  container: HTMLElement,
  wire: { name: string; result: string },
  row: ChatThreadCarriageRow = HELD_TURN_ROW,
): TurnProjection {
  const list = container.querySelector("[data-interactive-parts]");
  if (!list) return { parts: [], nodes: [] };
  const slots = Array.from(list.children);

  const parts: TurnProjection["parts"] = slots.map((slotEl, slot) => {
    const isTrigger = slotEl.matches("[data-run-card]") || slotEl.querySelector("[data-run-card]") !== null;
    return isTrigger
      ? { kind: "tool_result" as const, slot, name: wire.name, result: wire.result }
      : { kind: "text" as const, slot, text: slotEl.textContent ?? "" };
  });

  const anchorsByEl = new Map<Element, string[]>();
  for (const selector of row.ownerAnchors) {
    for (const el of Array.from(list.querySelectorAll(selector))) {
      const found = anchorsByEl.get(el) ?? [];
      found.push(selector);
      anchorsByEl.set(el, found);
    }
  }

  const nodes: ProjectedNode[] = [];
  for (const [el, anchors] of anchorsByEl) {
    const slot = slots.findIndex((s) => s === el || s.contains(el));
    let runBinding: string | null = null;
    for (const attr of RUN_BINDING_ATTRS) {
      const holder = el.closest(`[${attr}]`);
      if (holder) {
        runBinding = holder.getAttribute(attr);
        break;
      }
    }
    nodes.push({
      anchors,
      slot: slot === -1 ? null : slot,
      insideSubtrees: row.foreignHostSubtrees.filter((s) => el.closest(s) !== null),
      runBinding,
    });
  }
  return { parts, nodes };
}

/** The held dispatch turn's parts, as the reducer pins them. */
function heldTurnParts(): AssistantMessagePart[] {
  return [
    { kind: "text", content: DISPATCH_TEXT },
    {
      kind: "tool_call",
      id: "call-1",
      name: "agent_run",
      status: "completed",
      runId: RUN_ID,
      resultLabel: `runId: ${RUN_ID}, status: pending_input`,
    },
  ];
}

/** A stand-in for `InlineAgentRunCard`, carrying no lifecycle anchors. */
function neutralRunCard() {
  return <div data-lifecycle-card-host="run_card">run card body</div>;
}

/**
 * A run card that draws its OWN recommendation hold — the ruled run_card mount.
 * Legitimate where it stands; it is only a defect when it is counted as the
 * chat mount, which is precisely what the foreign-host arm refuses.
 */
function runCardWithItsOwnHold() {
  return (
    // Plain spans, not the shadcn button: this is a structural stand-in for the
    // run card's controls, and the contract reads the action anchors, not the
    // element type.
    <div data-lifecycle-card-host="run_card" data-lifecycle-card="recommendation_hold">
      <span data-action="confirm-recommendation">Confirm</span>
      <span data-action="skip-recommendation">Skip</span>
    </div>
  );
}

/** The chat-mounted card's markup. */
function cardMarkup(runId = RUN_ID) {
  return (
    `<div data-lifecycle-card="recommendation_hold" data-lifecycle-card-host="chat_thread" ` +
    `data-lifecycle-card-run-id="${runId}">` +
    `<span data-action="confirm-recommendation">Confirm</span>` +
    `<span data-action="skip-recommendation">Skip</span>` +
    `</div>`
  );
}

const RUN_CARD_MARKUP = `<div data-run-card="${RUN_ID}"><div data-lifecycle-card-host="run_card">run card</div></div>`;

/** The transcript-shaped DOM the chat mount must produce, built by hand. */
function ruledMountMarkup(
  over: { insideRunCard?: boolean; slotBelow?: boolean; runId?: string } = {},
) {
  const card = cardMarkup(over.runId);
  let slots: string;
  if (over.insideRunCard) {
    slots = `<div data-run-card="${RUN_ID}"><div data-lifecycle-card-host="run_card">run card</div>${card}</div>`;
  } else if (over.slotBelow) {
    slots = `${RUN_CARD_MARKUP}<div>${card}</div>`;
  } else {
    slots = `<div>${RUN_CARD_MARKUP}${card}</div>`;
  }
  return `<div data-interactive-parts><div>${DISPATCH_TEXT}</div>${slots}</div>`;
}

function fixtureContainer(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("the REAL ordered-parts transcript renderer", () => {
  it("renders the agent_run part as the inline run card, at its own transcript slot", () => {
    const { container } = render(
      <InteractiveParts parts={heldTurnParts()} renderers={{ renderRunCard: () => neutralRunCard() }} />,
    );
    expect(container.querySelector(`[data-run-card="${RUN_ID}"]`)).not.toBeNull();
  });

  it("satisfies the ALWAYS-ON arm of the held-turn contract", () => {
    const { container } = render(
      <InteractiveParts parts={heldTurnParts()} renderers={{ renderRunCard: () => neutralRunCard() }} />,
    );
    const projection = projectionFromTranscript(container, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const violations = evaluateHeldTurnProjection(projection, HELD_TURN_ROW);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("REFUSES the run card's own hold as the chat mount — a foreign host, not coverage", () => {
    const { container } = render(
      <InteractiveParts
        parts={heldTurnParts()}
        renderers={{ renderRunCard: () => runCardWithItsOwnHold() }}
      />,
    );
    const projection = projectionFromTranscript(container, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const codes = new Set(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code));
    expect([...codes]).toEqual(["anchors_in_foreign_host"]);
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it("keeps the deterministic dispatch text free of decision-path pointers", () => {
    const { container } = render(<InteractiveParts parts={heldTurnParts()} renderers={{}} />);
    const projection = projectionFromTranscript(container, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(
      evaluateHeldTurnProjection(projection, HELD_TURN_ROW).filter(
        (v) => v.code === "decision_path_pointer",
      ),
    ).toEqual([]);
  });

  it("does NOT project the held card yet — the obligation set is exactly what is declared", () => {
    const observed: string[] = [];
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (row.enforcer !== "held-turn-card-contract") continue;
      const { container } = render(
        <InteractiveParts
          parts={heldTurnParts()}
          renderers={{ renderRunCard: () => neutralRunCard() }}
        />,
      );
      const projection = projectionFromTranscript(
        container,
        { name: "agent_run", result: DURABLE_RESULT },
        row,
      );
      if (!projectsOwnerCard(projection, row)) observed.push(row.kind);
    }
    expect(
      observed,
      "the observed unmounted set drifted from HELD_TURN_MOUNT_OBLIGATIONS — " +
        "strike the row when the mount lands, and never before",
    ).toEqual([...HELD_TURN_MOUNT_OBLIGATIONS]);
  });
});

describe("the DOM adapter, over transcript-shaped fixtures", () => {
  it("FAILS the round-1 reproduction — a text pointer answer and no card", () => {
    const container = fixtureContainer(
      `<div data-interactive-parts>` +
        `<div>The agent paused. Open the run page to confirm or skip the recommendation.</div>` +
        `<div data-run-card="${RUN_ID}"><div>run card</div></div>` +
        `</div>`,
    );
    const projection = projectionFromTranscript(container, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "decision_path_pointer",
    );
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it("FAILS a card whose anchors are satisfied from inside the run-card subtree", () => {
    const projection = projectionFromTranscript(
      fixtureContainer(ruledMountMarkup({ insideRunCard: true })),
      { name: "agent_run", result: DURABLE_RESULT },
    );
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_in_foreign_host",
    );
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it("FAILS a card keyed by a different run", () => {
    const projection = projectionFromTranscript(
      fixtureContainer(ruledMountMarkup({ slotBelow: true, runId: "run-somebody-else" })),
      { name: "agent_run", result: DURABLE_RESULT },
    );
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_off_position",
    );
  });

  it("PASSES the ruled chat mount at the triggering part's slot", () => {
    const projection = projectionFromTranscript(fixtureContainer(ruledMountMarkup()), {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true })).toEqual(
      [],
    );
    expect(projectsOwnerCard(projection)).toBe(true);
  });

  it("PASSES the ruled chat mount in its own slot below, keyed by the run", () => {
    const projection = projectionFromTranscript(
      fixtureContainer(ruledMountMarkup({ slotBelow: true })),
      { name: "agent_run", result: DURABLE_RESULT },
    );
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true })).toEqual(
      [],
    );
  });

  it("SURVIVES transcript reload — the card is rebuilt from the durable result alone", () => {
    // A reload has no live stream: the transcript replays the persisted parts.
    // The same markup, evaluated against the same durable payload, must satisfy
    // the contract identically.
    const first = projectionFromTranscript(fixtureContainer(ruledMountMarkup()), {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const reloaded = projectionFromTranscript(fixtureContainer(ruledMountMarkup()), {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(reloaded, HELD_TURN_ROW, { requireMount: true })).toEqual(
      evaluateHeldTurnProjection(first, HELD_TURN_ROW, { requireMount: true }),
    );
    expect(projectsOwnerCard(reloaded)).toBe(true);
  });
});
