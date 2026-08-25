// THE CARD LANDS IN THE RUN'S OWN TURN, AND COMES BACK AFTER A RELOAD
// (cinatra#2930, epic #2926 W3).
//
// The plan, in as many words: "In a conversation the platform itself writes the
// card into the run's own turn, from an outbox the coordinator feeds when a
// moment opens — a durable part with its provenance and its place in the turn,
// so it is there after a reload and whether or not the assistant's model says
// anything."
//
// THE RELOAD PROOF AT THIS LEG is the transcript store round-trip: the injected
// content is put through `projectDurableAssistantTurn`, the same pure projection
// the transcript is rebuilt with when there is no Redis and no client memory. A
// card that survives that is a card that survives a reload.
//
// NO ASSISTANT TOOL CALL. Every fixture below drives a turn whose ordered trace
// contains the run's own `agent_run` dispatch and nothing else — no lifecycle
// tool call, no "show me" — because the point of the wave is that the card is
// there without one.

import { describe, expect, it } from "vitest";

import type { LifecycleCardKind } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { projectDurableAssistantTurn } from "@/lib/assistant-thread-store";
import {
  buildInjectedLifecyclePart,
  contentWithInjectedPart,
  injectionForTurn,
  restoredTurnSlotForRun,
  turnAlreadyCarriesCard,
} from "../lifecycle-run-outbox";

const RUN_ID = "run-77";
const DISPATCH_CALL = "call-agent-run-1";

/** A turn that dispatched the run and said nothing else. */
function runTurn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "",
    parts: [{ type: "tool_call", id: DISPATCH_CALL, name: "agent_run" }],
    dataParts: [{ kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID }],
    dataPartSlots: [DISPATCH_CALL],
    ...over,
  };
}

const KINDS: Array<{
  moment: string;
  cardKind: LifecycleCardKind;
  cardRef: string;
}> = [
  // The run parked for its review.
  { moment: "review", cardKind: "artifact_review_gate", cardRef: "gate-ref-1" },
  // The schedule, once Confirm created the run that carries it.
  { moment: "schedule", cardKind: "trigger_schedule_proposal", cardRef: "sched-ref-1" },
  // The audit — the one moment that does not park the run, and still a card.
  { moment: "audit", cardKind: "verification_summary", cardRef: "verif-ref-1" },
];

describe("the restored-turn slot", () => {
  it("is the `agent_run` call this run was dispatched at", () => {
    expect(restoredTurnSlotForRun(runTurn(), RUN_ID)).toBe(DISPATCH_CALL);
  });

  it("is null for a turn that dispatched a DIFFERENT run", () => {
    expect(restoredTurnSlotForRun(runTurn(), "some-other-run")).toBeNull();
  });

  it("is null for a turn with no dispatch pointer at all", () => {
    expect(restoredTurnSlotForRun({ format: "assistant-turn-v1" }, RUN_ID)).toBeNull();
  });
});

describe("the injected part", () => {
  it("is built through the ONE recognizer, under the platform tuple", () => {
    expect(buildInjectedLifecyclePart({ cardKind: "artifact_review_gate", cardRef: "r" })).toEqual({
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref: "r",
    });
  });

  it("is refused for a kind the run wire mints no envelope for", () => {
    // `recommendation_hold` and `agent_hitl_screen` are INTERRUPT-represented:
    // there is no ref to write and no registry entry to draw them from. They are
    // mounted from the run's own state at the dispatch part instead.
    expect(buildInjectedLifecyclePart({ cardKind: "recommendation_hold", cardRef: "r" })).toBeNull();
    expect(buildInjectedLifecyclePart({ cardKind: "agent_hitl_screen", cardRef: "r" })).toBeNull();
  });

  it("is refused without a server-checked reference, and for an oversized one", () => {
    expect(buildInjectedLifecyclePart({ cardKind: "artifact_review_gate", cardRef: null })).toBeNull();
    expect(buildInjectedLifecyclePart({ cardKind: "artifact_review_gate", cardRef: "" })).toBeNull();
    expect(
      buildInjectedLifecyclePart({ cardKind: "artifact_review_gate", cardRef: "x".repeat(513) }),
    ).toBeNull();
  });
});

describe("one fixture per run-carried card kind", () => {
  for (const { moment, cardKind, cardRef } of KINDS) {
    it(`lands the ${moment} moment's card in the run's own turn, with its slot and its provenance`, () => {
      const turn = { id: "turn-1", content: runTurn() };
      const injection = injectionForTurn({ runId: RUN_ID, cardKind, cardRef }, turn);
      expect(injection).not.toBeNull();
      const content = injection!.content;
      expect(content.dataParts).toEqual([
        { kind: "agent_run", toolCallId: DISPATCH_CALL, runId: RUN_ID },
        { viewType: cardKind, schemaVersion: 1, ref: cardRef },
      ]);
      expect(content.dataPartSlots).toEqual([DISPATCH_CALL, DISPATCH_CALL]);
      expect(content.dataPartProvenance).toEqual([null, "platform_injected"]);
    });

    it(`brings the ${moment} moment's card back after a reload, at its producing step`, () => {
      const turn = { id: "turn-1", content: runTurn() };
      const injection = injectionForTurn({ runId: RUN_ID, cardKind, cardRef }, turn)!;
      // THE ROUND TRIP: durable content → the transcript's message shape.
      const projected = projectDurableAssistantTurn("turn-1", injection.content);
      expect(projected).not.toBeNull();
      const call = (projected!.parts ?? []).find(
        (p) => p.kind === "tool_call" && p.id === DISPATCH_CALL,
      );
      expect(call).toBeDefined();
      // Folded onto the dispatch it belongs to — the same place the live render
      // draws it, not appended after the turn.
      expect(call!.views).toEqual([{ viewType: cardKind, schemaVersion: 1, ref: cardRef }]);
      // …and NOT ALSO at turn level. The two mounts partition the turn's views,
      // so the person sees one card and never two.
      expect(projected!.dataParts ?? []).toEqual([]);
    });

    it(`carries the ${moment} moment's card with NO assistant tool call in the transcript`, () => {
      const turn = { id: "turn-1", content: runTurn() };
      const injection = injectionForTurn({ runId: RUN_ID, cardKind, cardRef }, turn)!;
      const projected = projectDurableAssistantTurn("turn-1", injection.content)!;
      const toolNames = (projected.parts ?? [])
        .filter((p) => p.kind === "tool_call")
        .map((p) => p.name);
      // The run's own dispatch, and nothing the model asked for.
      expect(toolNames).toEqual(["agent_run"]);
      expect(projected.content).toBe("");
    });
  }
});

describe("a run a person starts from a conversation reaches the schedule moment THERE", () => {
  it("puts the schedule card in that conversation, never a silent wait", () => {
    // Plan §6: "a run a person starts from a conversation reaches the schedule
    // moment with its card in that conversation, never a silent wait".
    const turn = { id: "turn-1", content: runTurn() };
    const injection = injectionForTurn(
      { runId: RUN_ID, cardKind: "trigger_schedule_proposal", cardRef: "sched-ref-1" },
      turn,
    );
    expect(injection).not.toBeNull();
    const projected = projectDurableAssistantTurn("turn-1", injection!.content)!;
    const call = (projected.parts ?? []).find((p) => p.id === DISPATCH_CALL)!;
    expect(call.views).toEqual([
      { viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: "sched-ref-1" },
    ]);
  });
});

describe("writing the same card twice", () => {
  it("is refused — a moment stated again does not give the person a second card", () => {
    const first = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "gate-ref-1" },
      { id: "turn-1", content: runTurn() },
    )!;
    expect(
      injectionForTurn(
        { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "gate-ref-1" },
        { id: "turn-1", content: first.content },
      ),
    ).toBeNull();
    expect(turnAlreadyCarriesCard(first.content, "artifact_review_gate", "gate-ref-1")).toBe(true);
  });

  it("still writes the SAME KIND at a different moment", () => {
    const first = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "gate-ref-1" },
      { id: "turn-1", content: runTurn() },
    )!;
    const second = injectionForTurn(
      { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "gate-ref-2" },
      { id: "turn-1", content: first.content },
    );
    expect(second).not.toBeNull();
    expect(second!.content.dataParts).toHaveLength(3);
  });
});

describe("alignment with what is already in the turn", () => {
  it("BACKFILLS a turn written before the sibling arrays existed", () => {
    // The projection IGNORES a slot array whose length disagrees and reads every
    // card at turn level. Appending without backfilling would silently unplace
    // every card already there.
    const legacy = runTurn({ dataPartSlots: undefined, dataPartProvenance: undefined });
    delete (legacy as Record<string, unknown>).dataPartSlots;
    const next = contentWithInjectedPart(
      legacy,
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "g" },
      DISPATCH_CALL,
    )!;
    expect((next.dataParts as unknown[]).length).toBe(2);
    expect(next.dataPartSlots).toEqual([null, DISPATCH_CALL]);
    expect(next.dataPartProvenance).toEqual([null, "platform_injected"]);
  });

  it("TRUNCATES sibling arrays that are too LONG, not only backfills short ones", () => {
    // a convergence review, finding 3. Too-long and too-short do the same damage: the
    // projection ignores a mismatched slot array and reads EVERY card at turn
    // level, so appending to a mismatch unplaces the cards already there.
    const skewed = runTurn({
      dataPartSlots: [DISPATCH_CALL, "stray-a", "stray-b"],
      dataPartProvenance: [null, "tool_represented", "tool_represented"],
    });
    const next = contentWithInjectedPart(
      skewed,
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "g" },
      DISPATCH_CALL,
    )!;
    expect((next.dataParts as unknown[]).length).toBe(2);
    expect(next.dataPartSlots).toEqual([DISPATCH_CALL, DISPATCH_CALL]);
    expect(next.dataPartProvenance).toEqual([null, "platform_injected"]);
    // …and the projection really places both, which is the point of the repair.
    const projected = projectDurableAssistantTurn("turn-1", next)!;
    const call = (projected.parts ?? []).find((p) => p.id === DISPATCH_CALL)!;
    expect((call.views as unknown[]).length).toBe(1);
  });

  it("REFUSES a turn that does not carry this run's own dispatch pointer", () => {
    // a convergence review, finding 5. The lookup matches on content, so "which turn is
    // this" and "is this really the turn that started the run" have to be two
    // checks: a transcript that merely mentions a run id must never attract
    // another conversation's card.
    expect(
      injectionForTurn(
        { runId: "a-different-run", cardKind: "artifact_review_gate", cardRef: "g" },
        { id: "turn-1", content: runTurn() },
      ),
    ).toBeNull();
  });

  it("REFUSES the client transcript's mirror row", () => {
    // The mirror is a COPY of the conversation written from the browser. A card
    // belongs in the record the server wrote.
    expect(
      injectionForTurn(
        { runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "g" },
        { id: "legacy:turn-1", content: runTurn() },
      ),
    ).toBeNull();
  });

  it("writes nothing into a turn whose content is not the durable object", () => {
    expect(injectionForTurn({ runId: RUN_ID, cardKind: "artifact_review_gate", cardRef: "g" }, {
      id: "turn-1",
      content: null,
    })).toBeNull();
  });
});
