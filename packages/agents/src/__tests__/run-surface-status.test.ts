/**
 * Shared run-surface status/HITL-context reducers (cinatra#853).
 *
 * Pins the poll/SSE "resolve effective status" reduction previously inlined
 * in agentic-run-panel.tsx: SSE wins when the stream is enabled AND has
 * delivered a value; the just-submitted suppression hides the stale gate
 * until a DIFFERENT renderer arrives.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/run-surface-status.test.ts
 */
import { describe, it, expect } from "vitest";

import {
  applyJustSubmittedSuppression,
  classifyRunWaitInterrupt,
  isSetupInterruptTaskId,
  mapInterruptToHitlContext,
  resolveStreamFirst,
  runStatusBadgeLabel,
  statusBadgeVariant,
  AWAITING_INPUT_BADGE_LABEL,
  type HitlGateContext,
} from "../run-surface-status";

describe("resolveStreamFirst", () => {
  it("SSE wins when enabled and delivered", () => {
    expect(resolveStreamFirst(true, "running", "queued")).toBe("running");
  });
  it("falls back to poll when the stream has not delivered", () => {
    expect(resolveStreamFirst<string>(true, null, "queued")).toBe("queued");
  });
  it("ignores the stream entirely when disabled", () => {
    expect(resolveStreamFirst(false, "running", "queued")).toBe("queued");
  });
  it("works for nullable error channels", () => {
    expect(resolveStreamFirst<string | null>(true, "boom", null)).toBe("boom");
    expect(resolveStreamFirst<string | null>(false, "boom", null)).toBeNull();
  });
});

describe("statusBadgeVariant", () => {
  it("maps the shared statuses identically for both surfaces", () => {
    expect(statusBadgeVariant("completed")).toBe("default");
    expect(statusBadgeVariant("failed")).toBe("destructive");
    expect(statusBadgeVariant("pending_approval")).toBe("outline");
    expect(statusBadgeVariant("running")).toBe("secondary");
    expect(statusBadgeVariant("queued")).toBe("secondary");
    expect(statusBadgeVariant("pending_input")).toBe("secondary");
    expect(statusBadgeVariant("stopped")).toBe("secondary");
  });
  it("maps the trigger-run statuses (AgenticRunPanel surface)", () => {
    expect(statusBadgeVariant("pending_trigger")).toBe("outline");
    expect(statusBadgeVariant("armed")).toBe("secondary");
  });
});

// ---------------------------------------------------------------------------
// Human-wait presentation discriminator (input pause vs genuine review gate).
//
// The point of these cases: BOTH inputs below are runs on `pending_approval`,
// so the status and the `RunHumanWaitReason` enum are identical for both. Only
// the SEMANTIC signal carried by the interrupt itself separates them.
// ---------------------------------------------------------------------------

/** The setup-field INPUT pause: synthetic `setup-<runId>` identity + fieldName. */
const SETUP_INPUT_INTERRUPT: HitlGateContext = {
  xRenderer: "@cinatra-ai/agent-builder:schema-field",
  childRunId: null,
  reviewTaskId: "setup-run-42",
  inputSchema: { type: "object", properties: { idea: { type: "string" } } },
  currentValues: {},
  fieldName: "idea",
};

/** A GENUINE review gate: a real (non-`setup-`) task identity, no fieldName. */
const REVIEW_GATE_INTERRUPT: HitlGateContext = {
  xRenderer: "@cinatra-ai/x:review",
  childRunId: null,
  reviewTaskId: "9f1c2f0e-6f1a-4a1b-9f2e-0c3d4e5f6a7b",
  inputSchema: { type: "object" },
  currentValues: { draft: "…" },
};

describe("classifyRunWaitInterrupt", () => {
  it("classifies a setup-field interrupt as an INPUT pause, a review gate as an APPROVAL", () => {
    expect(classifyRunWaitInterrupt(SETUP_INPUT_INTERRUPT)).toBe("input");
    expect(classifyRunWaitInterrupt(REVIEW_GATE_INTERRUPT)).toBe("approval");
  });

  it("reads the synthetic setup task identity even with no fieldName (poll fallback)", () => {
    // deriveRunHitlContext's setup fallback emits `setup-<runId>` with no
    // fieldName — it must still classify as input.
    expect(classifyRunWaitInterrupt({ reviewTaskId: "setup-run-42" })).toBe("input");
    expect(isSetupInterruptTaskId("setup-run-42")).toBe(true);
    expect(isSetupInterruptTaskId("wayflow-task-7")).toBe(false);
    expect(isSetupInterruptTaskId(null)).toBe(false);
  });

  it("reads the setup payload kind (fieldName) even when the task id is opaque", () => {
    expect(classifyRunWaitInterrupt({ reviewTaskId: "rt-1", fieldName: "idea" })).toBe("input");
  });

  it("fails CLOSED to approval — an absent, empty or fieldName-less interrupt keeps the old copy", () => {
    expect(classifyRunWaitInterrupt(null)).toBe("approval");
    expect(classifyRunWaitInterrupt(undefined)).toBe("approval");
    expect(classifyRunWaitInterrupt({})).toBe("approval");
    expect(classifyRunWaitInterrupt({ reviewTaskId: "rt-1", fieldName: "  " })).toBe("approval");
    // A WayFlow gate's synthetic identity is NOT a setup identity.
    expect(classifyRunWaitInterrupt({ reviewTaskId: "wayflow-task-7" })).toBe("approval");
  });

  // -------------------------------------------------------------------------
  // THE READER (cinatra#2928): the run states its moment, so this stops guessing
  // -------------------------------------------------------------------------

  it("reads the moment the RUN states, in preference to the shape of the pause", () => {
    // The two heuristics and the recorded fact DISAGREE on purpose here, which
    // is the only way to show which one is being read. An agent that paused to
    // ask for input on an opaque WayFlow-shaped task id used to read as an
    // approval gate — the exact mislabelling the moment triple ends.
    expect(
      classifyRunWaitInterrupt({ reviewTaskId: "wayflow-task-7", lifecycleMoment: "hitl" }),
    ).toBe("input");
    // …and the other direction: a setup-shaped identity on a run that states it
    // is at a REVIEW is a review.
    expect(
      classifyRunWaitInterrupt({
        reviewTaskId: "setup-run-42",
        fieldName: "idea",
        lifecycleMoment: "review",
      }),
    ).toBe("approval");
  });

  it("falls back to the heuristics when the run states no moment", () => {
    // Every run created before the column existed reads null, and the SSE path
    // holds an interrupt without holding the row. The fallback is the previous
    // behaviour, byte for byte.
    for (const moment of [null, undefined]) {
      expect(classifyRunWaitInterrupt({ reviewTaskId: "setup-run-42", lifecycleMoment: moment })).toBe(
        "input",
      );
      expect(
        classifyRunWaitInterrupt({ reviewTaskId: "wayflow-task-7", lifecycleMoment: moment }),
      ).toBe("approval");
    }
  });

  it("says nothing about a moment that is not an interrupt at all", () => {
    // A run parked for the skills question or its schedule is not waiting at an
    // interrupt, so this classifier has no answer for it and keeps its
    // fail-closed one rather than inventing a reading.
    for (const moment of ["recommendation", "schedule", "audit", "something_new"]) {
      expect(classifyRunWaitInterrupt({ lifecycleMoment: moment }), moment).toBe("approval");
    }
  });
});

describe("runStatusBadgeLabel — run-card badge copy fixtures", () => {
  it("a setup-field INPUT pause reads 'Awaiting input', never 'pending approval'", () => {
    const label = runStatusBadgeLabel("pending_approval", SETUP_INPUT_INTERRUPT);
    expect(label).toBe(AWAITING_INPUT_BADGE_LABEL);
    expect(label).toBe("Awaiting input");
    expect(label.toLowerCase()).not.toContain("approval");
  });

  it("a genuine review gate keeps the unchanged approval copy", () => {
    expect(runStatusBadgeLabel("pending_approval", REVIEW_GATE_INTERRUPT)).toBe("pending approval");
    // No interrupt in hand → unchanged copy (fail-closed).
    expect(runStatusBadgeLabel("pending_approval", null)).toBe("pending approval");
  });

  it("leaves every other status' label byte-identical to the previous humanization", () => {
    for (const status of [
      "queued",
      "running",
      "completed",
      "failed",
      "stopped",
      "pending_input",
      "pending_trigger",
      "armed",
    ]) {
      expect(runStatusBadgeLabel(status, SETUP_INPUT_INTERRUPT)).toBe(
        status.replace(/_/g, " "),
      );
    }
  });
});

describe("mapInterruptToHitlContext", () => {
  it("maps the SSE interrupt shape onto the panel gate shape (childRunId null, fieldName propagated)", () => {
    const mapped = mapInterruptToHitlContext({
      xRenderer: "@cinatra-ai/x:output",
      reviewTaskId: "rt-1",
      schema: { type: "object" },
      values: { a: 1 },
      fieldName: "postTitle",
    });
    expect(mapped).toEqual({
      xRenderer: "@cinatra-ai/x:output",
      childRunId: null,
      reviewTaskId: "rt-1",
      inputSchema: { type: "object" },
      currentValues: { a: 1 },
      fieldName: "postTitle",
    });
  });
  it("returns null for null", () => {
    expect(mapInterruptToHitlContext(null)).toBeNull();
  });
});

describe("applyJustSubmittedSuppression", () => {
  const gate: HitlGateContext = {
    xRenderer: "@cinatra-ai/x:output",
    childRunId: null,
    reviewTaskId: "rt-1",
    inputSchema: {},
    currentValues: {},
  };

  it("suppresses the just-submitted renderer's stale gate", () => {
    expect(applyJustSubmittedSuppression(gate, "@cinatra-ai/x:output")).toEqual({
      context: null,
      clearSuppression: false,
    });
  });

  it("lets a DIFFERENT renderer through and signals the caller to clear", () => {
    expect(applyJustSubmittedSuppression(gate, "@cinatra-ai/x:other")).toEqual({
      context: gate,
      clearSuppression: true,
    });
  });

  it("passes through unsuppressed contexts and null contexts", () => {
    expect(applyJustSubmittedSuppression(gate, null)).toEqual({
      context: gate,
      clearSuppression: false,
    });
    expect(applyJustSubmittedSuppression(null, "@cinatra-ai/x:output")).toEqual({
      context: null,
      clearSuppression: false,
    });
  });
});
