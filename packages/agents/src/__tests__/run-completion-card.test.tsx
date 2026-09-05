// @vitest-environment jsdom
/**
 * RunCompletionCard — the terminal `completed` surface (cinatra#2482).
 *
 * The issue's acceptance criterion for Defect 2 is that after Continue the user
 * sees the run progressing, OR its produced output (e.g. a link to the
 * materialized artifact), OR — for a run that terminated with no output — a
 * clear terminal state explaining what happened and the next action. This suite
 * locks the second and third arms as they actually render:
 *
 *   1. produced outputs are LINKED to the artifact detail route;
 *   2. transcript-only / step-only completion points at where the output is,
 *      differently per host panel, and never claims "no output";
 *   3. a genuinely empty run says so explicitly and carries "Start new run";
 *   4. the next action is omitted (not mounted broken) without an agentId;
 *   5. the evidence read happens at MOUNT — a run that completes under the
 *      user's eyes is judged on fresh evidence, not an SSR snapshot;
 *   6. a failed evidence read degrades to the conservative branch, never to a
 *      false "this run produced nothing".
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run src/__tests__/run-completion-card.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// StartNewRunButton now lives in the SAME module as the card (the route-graph
// ratchet fold), so it can no longer be stubbed out from under it — the REAL
// button renders and this suite asserts on its real label. Its own wiring is
// mocked instead: the router it pushes through and the run-actions module both
// sides of the fold now share.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

type EvidenceResult =
  | { ok: true; outputs: { id: string; type: string; title: string }[]; hasTranscript: boolean; hasStepResults: boolean }
  | { ok: false; error: string };

const readRunOutputEvidenceMock = vi.fn(
  async (args: { runId: string }): Promise<EvidenceResult> => {
    void args;
    return { ok: true, outputs: [], hasTranscript: false, hasStepResults: false };
  },
);
vi.mock("../run-actions", () => ({
  readRunOutputEvidence: (args: { runId: string }) => readRunOutputEvidenceMock(args),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunCompletionCard (cinatra#2482)", () => {
  it("links every produced output to the artifact detail route", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{
          outputs: [
            { id: "obj-1", type: "blog_post", title: "How to ship" },
            { id: "obj-2", type: "blog_idea", title: "Shipping ideas" },
          ],
          hasTranscript: false,
          hasStepResults: false,
        }}
      />,
    );

    const first = screen.getByRole("link", { name: "How to ship" });
    expect(first.getAttribute("href")).toBe("/artifacts/obj-1");
    const second = screen.getByRole("link", { name: "Shipping ideas" });
    expect(second.getAttribute("href")).toBe("/artifacts/obj-2");
    expect(screen.queryByText(/run complete/i)).not.toBeNull();
    // Not the dead-end state.
    expect(document.querySelector('[data-run-completion="no-output"]')).toBeNull();
  });

  it("points at the transcript when the only evidence is messages", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: true, hasStepResults: false }}
      />,
    );

    expect(screen.queryByText(/its output is in the run transcript below/i)).not.toBeNull();
    expect(screen.queryByText(/produced no output/i)).toBeNull();
  });

  it("points at the step rail when the host panel keeps output behind the steps", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="steps"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: true }}
      />,
    );

    expect(
      screen.queryByText(/select a completed step to review it/i),
    ).not.toBeNull();
  });

  // coderabbit finding, cinatra#2519: outputHint="steps" says "select a
  // completed step to review it" — true only when the host actually rendered
  // a step rail. OrchestratorStepperPanel passes "no-steps" instead when
  // stepperSteps is empty (see orchestrator-stepper-panel-completed-terminal
  // .test.tsx for the host-level coverage of that branch selection).
  it("does not point at a step rail under outputHint=no-steps", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="no-steps"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: true }}
      />,
    );

    expect(
      screen.queryByText(/select a completed step to review it/i),
    ).toBeNull();
    expect(
      screen.queryByText(/no step list here to select from/i),
    ).not.toBeNull();
    expect(screen.queryByText(/produced no output/i)).toBeNull();
  });

  it("states the terminal empty outcome explicitly and offers the next action", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="steps"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: false }}
      />,
    );

    expect(document.querySelector('[data-run-completion="no-output"]')).not.toBeNull();
    expect(screen.queryByText(/run finished without output/i)).not.toBeNull();
    expect(
      screen.queryByText(/produced no output — nothing was returned and nothing was saved/i),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /start new run/i })).not.toBeNull();
  });

  it("omits the next action rather than mounting it broken when no agentId is known", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: false }}
      />,
    );

    expect(screen.queryByText(/run finished without output/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /start new run/i })).toBeNull();
  });

  it("reads evidence at mount so a run that finishes under the user's eyes is judged fresh", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [{ id: "obj-live", type: "blog_post", title: "Just written" }],
      hasTranscript: false,
      hasStepResults: false,
    });
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="steps"
      />,
    );

    await waitFor(() =>
      expect(readRunOutputEvidenceMock).toHaveBeenCalledWith({ runId: "run-2482" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Just written" })).not.toBeNull(),
    );
  });

  it("degrades to the conservative branch when the evidence read fails", async () => {
    readRunOutputEvidenceMock.mockRejectedValueOnce(new Error("boom"));
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
      />,
    );

    await waitFor(() =>
      expect(readRunOutputEvidenceMock).toHaveBeenCalledWith({ runId: "run-2482" }),
    );
    // Never a false "produced nothing".
    expect(document.querySelector('[data-run-completion="no-output"]')).toBeNull();
    expect(document.querySelector('[data-run-completion="with-output"]')).not.toBeNull();
    // CONFIRMATION-ROUND FINDING: nor a false "look below". The host panel
    // suppresses its "No messages yet." line under this card, so the old
    // conservative copy pointed the user at blank space — permanently, since a
    // failed read never resolves.
    await waitFor(() =>
      expect(screen.queryByText(/could not be loaded here/i)).not.toBeNull(),
    );
    expect(screen.queryByText(/its output is in the run transcript below/i)).toBeNull();
  });

  // CONFIRMATION-ROUND FINDING. Rows were written but none is an openable
  // artifact: the card must neither claim the run produced nothing nor point at
  // a transcript it has no evidence for.
  it("stays neutral when the run saved rows that cannot be linked", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-2482"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{
          outputs: [],
          hasTranscript: false,
          hasStepResults: false,
          unlinkableOutputs: true,
        }}
      />,
    );

    expect(document.querySelector('[data-run-completion="no-output"]')).toBeNull();
    expect(screen.queryByText(/nothing was returned and nothing was saved/i)).toBeNull();
    expect(screen.queryByText(/its output is in the run transcript below/i)).toBeNull();
    expect(screen.queryByText(/could not be loaded here/i)).not.toBeNull();
  });

  // Codex round-A finding. A card reused for a different run must never show
  // the previous run's outputs while the new read is in flight — that is a
  // wrong-run output claim, the same class of lie as a false "no output".
  it("never shows a previous run's outputs when the runId changes", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({
      ok: true,
      outputs: [{ id: "obj-first", type: "blog_post", title: "First run output" }],
      hasTranscript: false,
      hasStepResults: false,
    });
    const { RunCompletionCard } = await import("../run-completion-affordances");
    const { rerender } = render(
      <RunCompletionCard runId="run-first" agentId="cinatra-ai/a" outputHint="steps" />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "First run output" })).not.toBeNull(),
    );

    // Second run's read never resolves — the card must be empty-handed, not
    // still holding run-first's link.
    readRunOutputEvidenceMock.mockImplementationOnce(
      () => new Promise(() => {}) as Promise<EvidenceResult>,
    );
    rerender(
      <RunCompletionCard runId="run-second" agentId="cinatra-ai/a" outputHint="steps" />,
    );

    expect(screen.queryByRole("link", { name: "First run output" })).toBeNull();
    // Unresolved ⇒ conservative branch, never a false "produced nothing".
    expect(document.querySelector('[data-run-completion="no-output"]')).toBeNull();
  });

  it("synchronizes when initialEvidence itself changes", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    const { rerender } = render(
      <RunCompletionCard
        runId="run-2482"
        outputHint="steps"
        initialEvidence={{
          outputs: [{ id: "obj-a", type: "blog_post", title: "Output A" }],
          hasTranscript: false,
          hasStepResults: false,
        }}
      />,
    );
    expect(screen.queryByRole("link", { name: "Output A" })).not.toBeNull();

    rerender(
      <RunCompletionCard
        runId="run-2482"
        outputHint="steps"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: false }}
      />,
    );
    expect(screen.queryByRole("link", { name: "Output A" })).toBeNull();
    expect(document.querySelector('[data-run-completion="no-output"]')).not.toBeNull();
  });

  it("degrades to the conservative branch when the read is refused", async () => {
    readRunOutputEvidenceMock.mockResolvedValueOnce({ ok: false, error: "run not found" });
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard runId="run-2482" outputHint="transcript" />,
    );

    await waitFor(() =>
      expect(readRunOutputEvidenceMock).toHaveBeenCalledWith({ runId: "run-2482" }),
    );
    expect(document.querySelector('[data-run-completion="no-output"]')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// THE HOST'S OWN FACT, AS A FLOOR (cinatra#3002, fix leg 4)
// ---------------------------------------------------------------------------
//
// A host that is ALREADY drawing this run's produced output beneath the card
// knows something the card's asynchronous read has not learned yet. It states
// it with `transcriptCarriesOutput`, and the card takes it as a floor: it can
// only ADD the transcript fact. These pins hold both halves of that — what it
// fixes, and what it must NOT quietly widen into.
describe("RunCompletionCard — transcriptCarriesOutput (cinatra#3002)", () => {
  it("names the transcript while the read is still in flight", async () => {
    readRunOutputEvidenceMock.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        transcriptCarriesOutput
      />,
    );

    expect(
      screen.queryByText(/its output is in the run transcript below/i),
    ).not.toBeNull();
    expect(screen.queryByText(/could not be loaded here/i)).toBeNull();
  });

  it("keeps the conservative sentence when the host claims nothing", async () => {
    readRunOutputEvidenceMock.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
      />,
    );

    expect(screen.queryByText(/could not be loaded here/i)).not.toBeNull();
    expect(
      screen.queryByText(/its output is in the run transcript below/i),
    ).toBeNull();
  });

  it("never turns a run that produced nothing into one that did", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        initialEvidence={{ outputs: [], hasTranscript: false, hasStepResults: false }}
      />,
    );

    // The host is not claiming rows here, so the empty reading stands whole.
    expect(document.querySelector('[data-run-completion="no-output"]')).not.toBeNull();
  });

  it("leaves a linked output's own reading alone", async () => {
    const { RunCompletionCard } = await import("../run-completion-affordances");
    render(
      <RunCompletionCard
        runId="run-3002"
        agentId="cinatra-ai/blog-draft-writer-agent"
        outputHint="transcript"
        transcriptCarriesOutput
        initialEvidence={{
          outputs: [{ id: "obj-draft", type: "blog_post", title: "The draft" }],
          hasTranscript: false,
          hasStepResults: false,
        }}
      />,
    );

    // A saved output is the stronger reading and still wins over the floor.
    expect(screen.queryByText(/finished and saved its output/i)).not.toBeNull();
    expect(screen.queryByRole("link", { name: "The draft" })).not.toBeNull();
  });
});
