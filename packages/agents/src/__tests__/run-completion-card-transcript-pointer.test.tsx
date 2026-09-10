// @vitest-environment jsdom
/**
 * RunCompletionCard — the card may only name a place the reader can look
 * (cinatra#3002).
 *
 * `hasStepResults` and `hasTranscript` are two independent facts that used to
 * reach ONE conclusion: either alone made the card say "This run finished. Its
 * output is in the run transcript below." A run executed on the agent runtime
 * records its answer in `step_results` only, so on the transcript host that
 * sentence pointed at an empty page.
 *
 * This suite pins the pointer to the evidence it actually rests on:
 *
 *   1. step results ALONE never produce the transcript sentence on the
 *      transcript host (the issue's acceptance criterion 2, verbatim: "when
 *      hasStepResults is true and hasTranscript is false, the card does not say
 *      the output is in the transcript below");
 *   2. a real transcript still gets the transcript sentence;
 *   3. the step-rail host is untouched — there, step results ARE what the rail
 *      shows, and its sentence points at the rail;
 *   4. a run that recorded nothing still draws the card's own no-output
 *      reading, word for word, and is never confused with the case above.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-completion-card-transcript-pointer.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock("../run-actions", () => ({
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
}));

/** The card's own no-output reading, quoted. */
const NO_OUTPUT_READING =
  "This run reached the end of its steps but produced no output — nothing was returned and nothing was saved. Start a new run to try again.";
/** The transcript pointer — legal only when a transcript exists. */
const TRANSCRIPT_POINTER = /its output is in the run transcript below/i;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunCompletionCard — the pointer follows the evidence (cinatra#3002)", () => {
  it("never claims a transcript when the only evidence is a step result", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: true }}
      />,
    );

    expect(screen.queryByText(TRANSCRIPT_POINTER)).toBeNull();
    // …and it does not swing to the other false claim either: the run DID
    // record something.
    expect(screen.queryByText(NO_OUTPUT_READING)).toBeNull();
    expect(document.querySelector('[data-run-completion="with-output"]')).not.toBeNull();
    expect(screen.queryByText(/its output was recorded during the run/i)).not.toBeNull();
  });

  it("keeps the transcript sentence when there IS a transcript", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: true, hasStepResults: true }}
      />,
    );

    expect(screen.queryByText(TRANSCRIPT_POINTER)).not.toBeNull();
  });

  it("leaves the step-rail host's own sentence alone", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="steps"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: true }}
      />,
    );

    expect(screen.queryByText(/select a completed step to review it/i)).not.toBeNull();
    expect(screen.queryByText(TRANSCRIPT_POINTER)).toBeNull();
  });

  it("draws the no-output reading, word for word, for a run that recorded nothing", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: false }}
      />,
    );

    expect(screen.queryByText(NO_OUTPUT_READING)).not.toBeNull();
    expect(document.querySelector('[data-run-completion="no-output"]')).not.toBeNull();
  });
});
