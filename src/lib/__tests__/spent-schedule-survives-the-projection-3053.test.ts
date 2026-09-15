/**
 * THE SPENT SCHEDULE SURVIVES THE PROJECTION, AND THE LATER RUN TAKES ITS OWN
 * SLOT (cinatra#3053, issue #3044).
 *
 * THE READING THIS FILE IS MEASURED AGAINST is the ratified drawing's section
 * VI, fifth reading, quoted verbatim:
 *
 *   "Once it has fired, the card is a reading. A one-off that has fired cannot
 *    be changed, so the rows go read-only -- the values still legible, the
 *    pickers gone -- and the card carries no floor at all: no hairline, no
 *    button, nothing to press. A spent schedule is still worth reading, so
 *    nothing is hidden; it simply asks nothing."
 *
 * The ninth graded set split that defect in half and this file pins the half it
 * cleared: the STORE carries the settled part. Five assistant turns held a
 * `trigger_schedule_proposal` part in their durable content while the rendered
 * document held none, so the question this file answers is whether the fold and
 * the projection are what lose it. They are not, and a guard that says so is
 * worth keeping: the next reader of this defect should not have to re-derive
 * which road is clean.
 *
 * DRIVEN, NEVER HAND-WRITTEN. Nothing here writes a card into a turn by hand.
 * Every part in every fixture arrives the way a real one does -- through
 * `injectionForTurn`, the whole of the outbox's decision, fed the moment entries
 * the executor opens -- and is read back through the same pure projection the
 * transcript is rebuilt with. A fixture that hand-wrote its own parts could pass
 * while every real conversation stayed empty.
 *
 *   nice -n 19 pnpm exec vitest run \
 *     src/lib/__tests__/spent-schedule-survives-the-projection-3053.test.ts
 */
import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

import { projectDurableAssistantTurn } from "@/lib/assistant-thread-store";
import { encodeScheduleRunRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { injectionForTurn } from "@/lib/lifecycle/lifecycle-run-outbox";

const FIRED_RUN = "run-one-off-fired";
const LATER_RUN = "run-started-from-the-trigger";
const FIRED_CALL = "call-agent-run-fired";
const LATER_CALL = "call-agent-run-later";
const SCHEDULE_REF = encodeScheduleRunRef({ runId: FIRED_RUN })!;
const AUDIT_REF = "verif-ref-after-the-firing";
const LATER_SCHEDULE_REF = encodeScheduleRunRef({ runId: LATER_RUN })!;

/** The turn a chat dispatch really writes: the run's own `agent_run` call and
 *  the durable pointer that names which run it started. */
function dispatchTurn(
  dispatches: ReadonlyArray<{ call: string; run: string }>,
): Record<string, unknown> {
  return {
    format: "assistant-turn-v1",
    role: "assistant",
    content: "",
    parts: dispatches.map((d) => ({ type: "tool_call", id: d.call, name: "agent_run" })),
    dataParts: dispatches.map((d) => ({
      kind: "agent_run",
      toolCallId: d.call,
      runId: d.run,
    })),
    dataPartSlots: dispatches.map(() => null),
  };
}

/** ONE moment opening, driven through the outbox's whole decision. Returns the
 *  turn content the writer would have stored, or the SAME content when the
 *  writer decided to write nothing. */
function openMoment(
  content: Record<string, unknown>,
  entry: { runId: string; cardKind: string; cardRef: string },
): Record<string, unknown> {
  const injection = injectionForTurn(
    entry as never,
    { id: "turn-1", content } as never,
  );
  return injection === null ? content : injection.content;
}

/** The views the projection put on one producing step. */
function viewsAtSlot(
  projected: ReturnType<typeof projectDurableAssistantTurn>,
  call: string,
): Array<Record<string, unknown>> {
  const part = (projected?.parts ?? []).find(
    (p) => (p as { kind?: string; id?: string }).id === call,
  ) as { views?: Array<Record<string, unknown>> } | undefined;
  return part?.views ?? [];
}

describe("the spent schedule and the run that came after it", () => {
  it(
    "keeps the settled schedule part in the turn when the SAME run's next " +
      "moment opens -- the later view is appended to the slot, never folded " +
      "over the settled one",
    () => {
      // The photographed walk: the one-off fires, and the run moves on to its
      // own next moment. Both openings are driven through the outbox.
      let content = dispatchTurn([{ call: FIRED_CALL, run: FIRED_RUN }]);
      content = openMoment(content, {
        runId: FIRED_RUN,
        cardKind: "trigger_schedule_proposal",
        cardRef: SCHEDULE_REF,
      });
      content = openMoment(content, {
        runId: FIRED_RUN,
        cardKind: "verification_summary",
        cardRef: AUDIT_REF,
      });

      const projected = projectDurableAssistantTurn("turn-1", content);
      const views = viewsAtSlot(projected, FIRED_CALL);

      // BOTH readings are on the run's own step, in the order the moments
      // opened. The settled schedule is first because it settled first.
      expect(views.map((v) => v.viewType)).toEqual([
        "trigger_schedule_proposal",
        "verification_summary",
      ]);
      expect(views[0].ref).toBe(SCHEDULE_REF);
      // Nothing was folded over: the settled part is byte-for-byte what the
      // outbox wrote, and the later moment took a place of its own.
      expect(views[0]).toEqual({
        viewType: "trigger_schedule_proposal",
        schemaVersion: 1,
        ref: SCHEDULE_REF,
      });
    },
  );

  it("gives a LATER run's screens their own slot, and leaves the fired part at its own", () => {
    // A second run started from the trigger, dispatched in the same turn. Its
    // pointer names its own call, so the outbox writes its card at that call
    // and cannot reach the slot the fired card's part named.
    let content = dispatchTurn([
      { call: FIRED_CALL, run: FIRED_RUN },
      { call: LATER_CALL, run: LATER_RUN },
    ]);
    content = openMoment(content, {
      runId: FIRED_RUN,
      cardKind: "trigger_schedule_proposal",
      cardRef: SCHEDULE_REF,
    });
    content = openMoment(content, {
      runId: LATER_RUN,
      cardKind: "trigger_schedule_proposal",
      cardRef: LATER_SCHEDULE_REF,
    });

    const projected = projectDurableAssistantTurn("turn-1", content);

    expect(viewsAtSlot(projected, FIRED_CALL).map((v) => v.ref)).toEqual([SCHEDULE_REF]);
    expect(viewsAtSlot(projected, LATER_CALL).map((v) => v.ref)).toEqual([
      LATER_SCHEDULE_REF,
    ]);
    // And neither reading was promoted to the turn level, where it would draw a
    // second time beside the step that produced it.
    expect(projected?.dataParts ?? []).toEqual([]);
  });

  it("carries the settled part through a RELOAD, exactly as it was written", () => {
    // The reload road: the stored content is all there is, and the projection
    // is the whole of what rebuilds the turn.
    let content = dispatchTurn([{ call: FIRED_CALL, run: FIRED_RUN }]);
    content = openMoment(content, {
      runId: FIRED_RUN,
      cardKind: "trigger_schedule_proposal",
      cardRef: SCHEDULE_REF,
    });
    const reloaded = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;

    const projected = projectDurableAssistantTurn("turn-1", reloaded);
    expect(viewsAtSlot(projected, FIRED_CALL)).toEqual([
      { viewType: "trigger_schedule_proposal", schemaVersion: 1, ref: SCHEDULE_REF },
    ]);
  });
});
