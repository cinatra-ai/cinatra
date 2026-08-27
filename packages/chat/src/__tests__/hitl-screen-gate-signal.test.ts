// THE HITL SCREEN'S CHANGE SIGNAL (cinatra#2930, lifecycle-b W3).
//
// The §V card is live the moment its turn renders — a hold parks the run BEFORE
// dispatch — so one read on mount is its whole story. The HITL screen is not
// like that: the agent parks MID-RUN, long after the turn was drawn, so a card
// that read once would answer "no screen" and never ask again while the person
// sat in front of a run that was waiting on them.
//
// The signal is the run panel's OWN publication, which the conversation slot
// listens to and hands the card as a change signal. What is pinned here is that
// the signal carries EVERY part of the gate's identity the panel publishes —
// the review task, the renderer, the FIELD NAME and the field SHAPE. Sequential
// per-field setup gates share one review-task id and one renderer and differ
// only in the field they ask for, so a signal built from the first two would go
// quiet exactly where the question changes: the card would keep the previous
// field on screen and could answer the new gate with it.
//
// THE LIMIT, stated rather than left to be discovered: this is a LEXICAL read of
// the shipped source, not a driven render. It cannot be the proof on its own —
// the transcript suites drive the column, and the card's own suite drives the
// read effect against a changing `wireRef`. What it adds is that the SIGNAL
// cannot quietly narrow back to a subset while both of those stay green,
// because neither of them varies a gate's field shape.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "chat-messages-view.tsx"),
  "utf8",
);

/** The slot's signal builder — the block between `setGateSignal(` and the call
 *  that closes it, with comments stripped so a sentence cannot satisfy this. */
function signalBuilder(): string {
  const at = source.indexOf("setGateSignal(");
  expect(at, "the conversation slot publishes no gate signal at all").toBeGreaterThan(-1);
  const block = source.slice(at, source.indexOf("        );", at));
  return block.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the conversation slot's gate signal", () => {
  it("is built from every part of the gate identity the panel publishes", () => {
    const built = signalBuilder();
    for (const part of ["reviewTaskId", "xRenderer", "fieldName", "fields"]) {
      expect(built, `the signal drops ${part} — a gate change it cannot see`).toContain(part);
    }
  });

  it("reads the field SHAPE, not just the field list's presence", () => {
    // The panel's own signature is `${name}:${type}:${required ? 1 : 0}` per
    // field. A signal that named `fields` without reading them would not move
    // when a gate swapped one required field for another.
    const built = signalBuilder();
    expect(built).toContain("f.name");
    expect(built).toContain("f.type");
    expect(built).toContain("f.required");
  });

  it("hands the signal to the card and forwards the callback it intercepted", () => {
    // The slot is a LISTENER, never a consumer: whatever the chat page passed
    // still gets its call, or the composer stops being able to drive the gate.
    expect(source).toContain("<AgentHitlScreenCard runId={runId} wireRef={gateSignal} />");
    expect(source).toContain("onActiveGateChange?.(changedRunId, gate, instanceId);");
    expect(source).toContain("onActiveGateChange={onGateChange}");
  });
});
