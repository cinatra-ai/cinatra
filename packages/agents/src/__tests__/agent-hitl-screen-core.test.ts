// The HITL screen's ONE authorized read (cinatra#2930, lifecycle-b W3).
//
// What is pinned here is the CONDITION — which run is asking, and which is not —
// because the card draws exactly what this answers and nothing else decides it:
//
//   · the condition is the RUN PANEL'S condition, a derivable gate with a
//     renderer, and NOT a second one. A card that additionally required the run
//     to have STATED the moment would withhold the screen from every run the
//     coordinator never got to state one for — a setup-loop pause, a run that
//     started before the record existed, a park whose moment write lost its CAS
//     — and those runs show no screen at all in a conversation, because the run
//     panel stands down there;
//   · the panel's EXCLUSION travels with it: a MARKED artifact-review gate parks
//     the run the same way and derives the same shape, and it is the REVIEW, not
//     this moment;
//   · every refusal collapses to the same silence, so a caller holding a run id
//     learns nothing about which runs exist.

import { describe, expect, it, vi } from "vitest";

const deriveRunHitlContext = vi.fn();
vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: (run: unknown) => deriveRunHitlContext(run),
}));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(async () => null),
}));

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";
import { agentHitlScreenStateForRun } from "../agent-hitl-screen-core";
import { WITHHELD_TERMINAL_KEY } from "../run-produced-review-hold";

type Run = Parameters<typeof agentHitlScreenStateForRun>[0];

const RUN = {
  id: "run-2930",
  lifecycleMoment: null,
  lifecycleCardKind: null,
  lifecycleCardRef: null,
} as unknown as Run;

const GATE = {
  xRenderer: "cinatra.schema-field:output",
  childRunId: null,
  reviewTaskId: "task-2930",
  inputSchema: { type: "object" },
  currentValues: {},
  fieldName: undefined,
};

describe("which run is asking", () => {
  it("answers ASKING for a run with a derivable gate, even with NO stated moment", async () => {
    deriveRunHitlContext.mockResolvedValue(GATE);
    const state = await agentHitlScreenStateForRun(RUN);
    expect(state.state).toBe("asking");
    // The stated moment is provenance, not the gate: absent, the screen still
    // draws and simply carries no reference.
    expect(state.state === "asking" && state.screenRef).toBeNull();
    expect(state.state === "asking" && state.gate.reviewTaskId).toBe("task-2930");
  });

  it("carries the stated moment's own reference when the coordinator recorded one", async () => {
    deriveRunHitlContext.mockResolvedValue(GATE);
    const state = await agentHitlScreenStateForRun({
      ...RUN,
      lifecycleMoment: "hitl",
      lifecycleCardKind: "agent_hitl_screen",
      lifecycleCardRef: "screen-ref-2930",
    } as unknown as Run);
    expect(state.state === "asking" && state.screenRef).toBe("screen-ref-2930");
  });

  it("refuses a MARKED artifact-review gate — that is the review, not this moment", async () => {
    deriveRunHitlContext.mockResolvedValue({
      ...GATE,
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
    });
    expect((await agentHitlScreenStateForRun(RUN)).state).toBe("none");
  });

  // -------------------------------------------------------------------------
  // THE PARK IS THE PANEL'S OTHER EXCLUSION (cinatra#3007).
  //
  // A run held for the review of what it PRODUCED waits in the same status while
  // still carrying the last question it was asked — a question the person
  // answered and the run moved past minutes ago. The interrupt log is where that
  // question lives and nothing there records that it was answered, so
  // `deriveRunHitlContext` keeps handing it back, with its renderer and its
  // current values, exactly as if it were live.
  //
  // The run panel drops it, off the run's own row. This reader did not — so the
  // conversation kept drawing the answered ask above the run's slot as STILL
  // ASKING, with a live forward control on it, for as long as the park lasted.
  // The third capture measured the screen still recording `asking` 66 to 84 s
  // after the run's review gate had been minted.
  // -------------------------------------------------------------------------

  /** The row of a run parked on the review of what it produced: the parked
   *  status AND the withheld terminal write, which is what the park IS. */
  const PARKED_ON_PRODUCED_REVIEW = {
    ...RUN,
    status: "pending_approval",
    stepResults: [
      { wayflow_response: { ok: true }, [WITHHELD_TERMINAL_KEY]: { status: "completed" } },
    ],
  } as unknown as Run;

  it("refuses a run PARKED on the review of what it produced — the ask it carries is answered", async () => {
    // The gate the derivation answers with is the ordinary setup question, not a
    // marked review gate: the exclusion above cannot reach it, and only the row
    // can say the run has moved past it.
    deriveRunHitlContext.mockResolvedValue(GATE);
    expect((await agentHitlScreenStateForRun(PARKED_ON_PRODUCED_REVIEW)).state).toBe("none");
  });

  it("keeps asking for a run parked in the same status WITHOUT the park's own marker", async () => {
    // The guard on the rule: `pending_approval` alone is not a park. A run
    // genuinely stopped on a question is in that status too, and it must keep
    // drawing its question.
    deriveRunHitlContext.mockResolvedValue(GATE);
    const asking = await agentHitlScreenStateForRun({
      ...RUN,
      status: "pending_approval",
      stepResults: [{ wayflow_response: { ok: true } }],
    } as unknown as Run);
    expect(asking.state).toBe("asking");
  });

  it("keeps asking for a run carrying the marker but NOT in the parked status", async () => {
    // The other half of the pair the park is read from: a row that has left the
    // parked status is not held by anything, whatever its payload still says.
    deriveRunHitlContext.mockResolvedValue(GATE);
    const asking = await agentHitlScreenStateForRun({
      ...PARKED_ON_PRODUCED_REVIEW,
      status: "running",
    } as unknown as Run);
    expect(asking.state).toBe("asking");
  });

  it("refuses a run with no derivable gate, and one whose gate names no renderer", async () => {
    deriveRunHitlContext.mockResolvedValue(null);
    expect((await agentHitlScreenStateForRun(RUN)).state).toBe("none");
    deriveRunHitlContext.mockResolvedValue({ ...GATE, xRenderer: "" });
    expect((await agentHitlScreenStateForRun(RUN)).state).toBe("none");
  });

  it("refuses a derivation that THREW, rather than letting it escape", async () => {
    deriveRunHitlContext.mockRejectedValue(new Error("the interrupt log is gone"));
    expect((await agentHitlScreenStateForRun(RUN)).state).toBe("none");
  });
});
