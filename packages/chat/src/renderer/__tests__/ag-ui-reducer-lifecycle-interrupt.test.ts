/**
 * cinatra#2568 (epic #2564 S4) — the chat reducer must not turn a typed
 * lifecycle interrupt into a review-task approval gate.
 *
 * `state.interrupt` is the "a review task awaits your approval" slice: it drives
 * the approval chrome and the host's review-task renderer, and its
 * `reviewTaskId` is what a decision would be submitted with. A lifecycle
 * interaction has no review task and no approval floor, so folding it in would
 * draw an approval affordance for something that cannot be approved — and offer
 * the hold's synthetic gate identity to the approve path.
 *
 * PRESENCE GATES: a declaration this build cannot parse is still not a review
 * task.
 */
import { describe, expect, it } from "vitest";

import { agUiReduce, initialConversationState } from "../ag-ui-reducer";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

const HOLD_REF = "b3BhcXVlLXJlZg";

function holdInterrupt(interaction?: Record<string, unknown>): AgUiEvent {
  return {
    type: "INTERRUPT",
    threadId: "thread-1",
    runId: "run-1",
    schema: {},
    xRenderer: "@cinatra-ai/lifecycle:recommendation-hold",
    values: {},
    reviewTaskId: "recommendation:run-start:run-1",
    interaction: (interaction ?? {
      kind: "recommendation_hold",
      schemaVersion: 1,
      ref: HOLD_REF,
    }) as { kind: string; schemaVersion: number; ref: string },
  } as AgUiEvent;
}

function reviewInterrupt(): AgUiEvent {
  return {
    type: "INTERRUPT",
    threadId: "thread-1",
    runId: "run-1",
    schema: { type: "object" },
    xRenderer: "@vendor/agent:confirm",
    values: {},
    reviewTaskId: "rt-1",
  } as AgUiEvent;
}

describe("reduceInterrupt — lifecycle interactions are not review-task gates", () => {
  it("a typed hold interrupt opens NO approval slice", () => {
    const next = agUiReduce(initialConversationState(), holdInterrupt());
    expect(next.interrupt).toBeNull();
  });

  it("an UNPARSEABLE declaration is equally not a review task", () => {
    for (const interaction of [
      { kind: "totally_made_up", schemaVersion: 1, ref: HOLD_REF },
      { kind: "recommendation_hold", schemaVersion: 99, ref: HOLD_REF },
    ]) {
      const next = agUiReduce(initialConversationState(), holdInterrupt(interaction));
      expect(next.interrupt).toBeNull();
    }
  });

  it("an ORDINARY interrupt still opens the approval slice (regression)", () => {
    const next = agUiReduce(initialConversationState(), reviewInterrupt());
    expect(next.interrupt).toMatchObject({ reviewTaskId: "rt-1" });
  });

  it("a LIFECYCLE resume does not clear a live review-task gate", () => {
    const open = agUiReduce(initialConversationState(), reviewInterrupt());
    const next = agUiReduce(open, {
      type: "RESUME",
      threadId: "thread-1",
      runId: "run-1",
      interaction: { kind: "recommendation_hold", schemaVersion: 1, ref: HOLD_REF },
    } as AgUiEvent);
    expect(next.interrupt).toMatchObject({ reviewTaskId: "rt-1" });
  });

  it("an ORDINARY resume still clears it (regression)", () => {
    const open = agUiReduce(initialConversationState(), reviewInterrupt());
    const next = agUiReduce(open, {
      type: "RESUME",
      threadId: "thread-1",
      runId: "run-1",
    } as AgUiEvent);
    expect(next.interrupt).toBeNull();
  });
});
