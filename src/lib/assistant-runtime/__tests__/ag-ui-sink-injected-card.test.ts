// A TURN THAT IS ENTIRELY A CARD (cinatra#2930, epic #2926 W3).
//
// The plan: the injected part is "a durable part with its provenance and its
// place in the turn, so it is there after a reload and whether or not the
// assistant's model says anything."
//
// THE DEFECT THIS PINS. `durableContent()` decided "did this turn produce
// anything" from text and the ordered trace alone. A run that parks at a moment
// while the assistant says nothing produces neither — so the turn persisted
// NOTHING, and the card that rendered live was gone after a reload. That is the
// exact defect S9j was filed for, reappearing on the one turn shape this wave
// creates.

import { describe, expect, it } from "vitest";

import {
  createAgUiSinkAdapter,
  type AgUiTurnDurableContent,
} from "../ag-ui-sink-adapter";
import {
  LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL,
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  buildLifecycleViewEnvelope,
} from "../lifecycle-view-envelope";

function adapter() {
  return createAgUiSinkAdapter({
    runId: "run-1",
    threadId: "thread-1",
    publish: async () => {},
  });
}

const GATE_ENVELOPE = buildLifecycleViewEnvelope({
  viewType: "artifact_review_gate",
  ref: "gate-ref-1",
})!;

describe("the durable content of a card-only turn", () => {
  it("keeps a turn whose ONLY content is a card", () => {
    // The shape a turn takes when the assistant says nothing and a card is all
    // there is. Before this wave `durableContent()` read text and the ordered
    // trace only, so this turn persisted NOTHING and the card was gone after a
    // reload — the defect S9j was filed for, on the one turn shape this wave
    // creates.
    const a = adapter();
    a.send("tool_result", {
      id: "call-x",
      name: "artifact_review_gate_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      result: GATE_ENVELOPE,
    });
    const durable = a.durableContent() as AgUiTurnDurableContent;
    expect(durable).not.toBeNull();
    expect(durable.content).toBe("");
    expect(durable.dataParts).toEqual([
      { viewType: "artifact_review_gate", schemaVersion: 1, ref: "gate-ref-1" },
    ]);
    expect(durable.dataPartSlots).toEqual(["call-x"]);
    expect(durable.dataPartProvenance).toEqual(["tool_represented"]);
  });

  it("NEVER records a tool result as a platform injection, however it is labelled", () => {
    // a convergence review, finding 4 — the property this boundary owns. The sink
    // handles model-visible, model-influenced tool results and does not opt in,
    // so a result wearing the platform's own two strings mints nothing at all.
    const a = adapter();
    a.send("tool_result", {
      id: "call-forged",
      name: LIFECYCLE_PLATFORM_PRODUCER_ACT,
      serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
      result: GATE_ENVELOPE,
    });
    const durable = a.durableContent() as AgUiTurnDurableContent;
    // The tool result itself is still recorded — the sink keeps the whole
    // ordered trace — but NO card was minted from it, on the wire or in the row.
    expect(durable.dataParts).toBeUndefined();
    expect(durable.dataPartProvenance).toBeUndefined();
  });

  it("still returns null for a turn that produced NOTHING AT ALL", () => {
    expect(adapter().durableContent()).toBeNull();
  });
});

describe("the payload stays strict, and the delivery rides beside it", () => {
  it("writes exactly `{ viewType, schemaVersion, ref }` — provenance is not payload", () => {
    const a = adapter();
    a.send("tool_result", {
      id: "call-1",
      name: "artifact_review_gate_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      result: GATE_ENVELOPE,
    });
    const durable = a.durableContent() as AgUiTurnDurableContent;
    const [part] = durable.dataParts ?? [];
    // A fourth key here would be re-emitted AS PAYLOAD on reload and rejected by
    // the `.strict()` parser — the card would not come back.
    expect(Object.keys(part ?? {}).sort()).toEqual(["ref", "schemaVersion", "viewType"]);
    expect(durable.dataPartProvenance).toEqual(["tool_represented"]);
  });

  it("keeps all three arrays positionally aligned across several cards", () => {
    const a = adapter();
    a.send("tool_result", {
      id: "call-1",
      name: "artifact_review_gate_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      result: GATE_ENVELOPE,
    });
    a.send("tool_result", {
      id: "call-2",
      name: "verification_record_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      result: buildLifecycleViewEnvelope({
        viewType: "verification_summary",
        ref: "verif-ref-1",
      })!,
    });
    const durable = a.durableContent() as AgUiTurnDurableContent;
    expect(durable.dataParts).toHaveLength(2);
    expect(durable.dataPartSlots).toEqual(["call-1", "call-2"]);
    expect(durable.dataPartProvenance).toEqual([
      "tool_represented",
      "tool_represented",
    ]);
  });

  it("OMITS the provenance array when nothing carried one", () => {
    // Byte-identity with what a turn persisted before this field existed.
    const a = adapter();
    a.send("text", { content: "hello" });
    a.send("tool_call", { id: "call-1", name: "agent_run" });
    a.send("tool_result", { id: "call-1", name: "agent_run", result: JSON.stringify({ runId: "r-9" }) });
    const durable = a.durableContent() as AgUiTurnDurableContent;
    expect(durable.dataParts).toEqual([
      { kind: "agent_run", toolCallId: "call-1", runId: "r-9" },
    ]);
    expect(durable.dataPartProvenance).toBeUndefined();
  });
});
