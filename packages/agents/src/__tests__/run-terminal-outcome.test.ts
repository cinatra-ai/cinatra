/**
 * Terminal-run outcome resolution (cinatra#2482).
 *
 * The immediate-trigger flow used to dead-end: "Run right after setup" →
 * Continue → the run view rendered Step 1 as `completed` with no output, no
 * next step and no affordance. `resolveRunTerminalOutcome` is the decision that
 * removes the dead end — it names which of the issue's three acceptance states
 * a run is in. These tests lock the rules that matter:
 *
 *   1. only `completed` is this module's business — `failed`/`stopped` keep
 *      their own dedicated cards, and a live run keeps the spinner;
 *   2. produced OUTPUT OBJECTS win over everything (they get linked);
 *   3. transcript / step-results count as output too (rendered elsewhere in the
 *      panel) — they must never be reported as "produced nothing";
 *   4. only a genuinely empty terminal run reports `completed-no-output`;
 *   5. UNRESOLVED evidence is conservative — a card that has not finished its
 *      read must never claim the run produced nothing.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run src/__tests__/run-terminal-outcome.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  deriveProducedOutputTitle,
  resolveRunTerminalOutcome,
  type RunOutputEvidence,
} from "../run-terminal-outcome";

const EMPTY: RunOutputEvidence = {
  outputs: [],
  hasTranscript: false,
  hasStepResults: false,
};

describe("resolveRunTerminalOutcome", () => {
  it.each([
    "pending_input",
    "pending_trigger",
    "armed",
    "queued",
    "running",
    "pending_approval",
    "waiting_trigger",
  ])("leaves a non-terminal run (%s) alone", (status) => {
    expect(resolveRunTerminalOutcome({ status, evidence: EMPTY })).toEqual({
      kind: "not-terminal",
    });
  });

  it.each(["failed", "stopped"])(
    "leaves %s to its own dedicated card — never double-renders a completion card",
    (status) => {
      expect(resolveRunTerminalOutcome({ status, evidence: EMPTY })).toEqual({
        kind: "not-terminal",
      });
    },
  );

  it("links produced output objects when the run saved any", () => {
    const outputs = [
      { id: "obj-1", type: "blog_post", title: "A draft" },
      { id: "obj-2", type: "blog_idea", title: "An idea" },
    ];
    expect(
      resolveRunTerminalOutcome({
        status: "completed",
        evidence: { outputs, hasTranscript: false, hasStepResults: false },
      }),
    ).toEqual({ kind: "completed-with-output", outputs, outputRenderedBelow: false });
  });

  it("prefers the linked outputs even when a transcript also exists", () => {
    const outputs = [{ id: "obj-1", type: "blog_post", title: "A draft" }];
    const outcome = resolveRunTerminalOutcome({
      status: "completed",
      evidence: { outputs, hasTranscript: true, hasStepResults: true },
    });
    expect(outcome).toEqual({
      kind: "completed-with-output",
      outputs,
      outputRenderedBelow: false,
    });
  });

  it("counts a transcript as output — the panel renders it elsewhere", () => {
    expect(
      resolveRunTerminalOutcome({
        status: "completed",
        evidence: { outputs: [], hasTranscript: true, hasStepResults: false },
      }),
    ).toEqual({ kind: "completed-with-output", outputs: [], outputRenderedBelow: true });
  });

  it("counts step results as output", () => {
    expect(
      resolveRunTerminalOutcome({
        status: "completed",
        evidence: { outputs: [], hasTranscript: false, hasStepResults: true },
      }),
    ).toEqual({ kind: "completed-with-output", outputs: [], outputRenderedBelow: true });
  });

  it("reports completed-no-output ONLY for a genuinely empty terminal run", () => {
    expect(resolveRunTerminalOutcome({ status: "completed", evidence: EMPTY })).toEqual({
      kind: "completed-no-output",
    });
  });

  it("is conservative while evidence is unresolved — never a false 'produced nothing'", () => {
    expect(resolveRunTerminalOutcome({ status: "completed", evidence: null })).toEqual({
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: true,
    });
  });

  // Codex round-2 finding. A BROKEN output read used to be swallowed into an
  // empty list, so an infrastructure failure was reported to the user as the
  // confident claim "this run produced no output" — the same lie, arriving by
  // a different route. "Could not look" must never read as "nothing there".
  it("does not claim 'no output' when the output read was unavailable", () => {
    expect(
      resolveRunTerminalOutcome({
        status: "completed",
        evidence: {
          outputs: [],
          hasTranscript: false,
          hasStepResults: false,
          outputsUnavailable: true,
        },
      }),
    ).toEqual({ kind: "completed-with-output", outputs: [], outputRenderedBelow: true });
  });

  it("still reports no output when the read SUCCEEDED and found nothing", () => {
    expect(
      resolveRunTerminalOutcome({
        status: "completed",
        evidence: {
          outputs: [],
          hasTranscript: false,
          hasStepResults: false,
          outputsUnavailable: false,
        },
      }),
    ).toEqual({ kind: "completed-no-output" });
  });
});

describe("deriveProducedOutputTitle", () => {
  it.each(["title", "name", "headline", "subject"])(
    "uses data.%s when present",
    (key) => {
      expect(
        deriveProducedOutputTitle({
          data: { [key]: "  How to ship  " },
          type: "blog_post",
          id: "obj-abcdef123456",
        }),
      ).toBe("How to ship");
    },
  );

  it("prefers title over the other keys", () => {
    expect(
      deriveProducedOutputTitle({
        data: { title: "First", name: "Second" },
        type: "blog_post",
        id: "obj-1",
      }),
    ).toBe("First");
  });

  it("falls back to type + short id when data carries no usable label", () => {
    expect(
      deriveProducedOutputTitle({
        data: { title: "   " },
        type: "blog_post",
        id: "obj-abcdef123456",
      }),
    ).toBe("blog_post obj-abcd");
  });

  it("never blanks out on a non-object data payload", () => {
    for (const data of [null, undefined, 42, "text", []]) {
      expect(
        deriveProducedOutputTitle({ data, type: "blog_post", id: "short" }),
      ).toBe("blog_post short");
    }
  });
});
