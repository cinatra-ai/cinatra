"use client";
/**
 * Run-completion affordances — what a run offers once it has nothing left to do
 * (cinatra#2412 `StartNewRunButton`, cinatra#2482 `RunCompletionCard`).
 *
 * The two used to live in separate modules (`start-new-run-button.tsx` and
 * `run-completion-card.tsx`). They are merged here because the route-graph
 * ratchet locks the reachable first-party module count of five routes that
 * already carry this component through the run panels, and the card is the only
 * caller that composes the button beyond the failure block: the card IS the
 * terminal state, the button IS its next action. One module, one concern.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/lib/cinatra-toast";
import { createAndTriggerRun, readRunOutputEvidence } from "./run-actions";
import {
  resolveRunTerminalOutcome,
  type RunOutputEvidence,
} from "./run-status";

export type StartNewRunButtonProps = {
  agentId: string;
};

export function StartNewRunButton({ agentId }: StartNewRunButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      const result = await createAndTriggerRun({ templateSlug: agentId });
      if (result.ok) {
        router.push(`/agents/${agentId}/${encodeURIComponent(result.runId)}`);
      } else {
        toast.error(result.error ?? "Could not create a new run.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={handleClick} disabled={isPending}>
        {isPending ? "Starting…" : "Start new run"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunCompletionCard — the terminal `completed` state of a run (cinatra#2482)
// ---------------------------------------------------------------------------
//
// Before this card, a `completed` run rendered NOTHING actionable on the
// canonical run view. The immediate-trigger flow ("Run right after setup" →
// Continue) therefore dead-ended: the stepper showed every step complete (a
// `completed` run marks them all so), the right pane was empty, and there was
// no output, no explanation and no next action.
//
// The card answers the issue's three acceptance states for a run that is no
// longer progressing:
//
//   - it produced outputs   → link each one (the artifact detail route)
//   - its output is inline  → say where, so an empty right pane is not read as
//                             "nothing happened"
//   - it produced nothing   → say THAT plainly, and offer the next action
//
// Evidence is read at mount (`readRunOutputEvidence`) rather than threaded from
// the server render, because a run usually completes while the user is watching
// — an SSR snapshot taken while it was `queued` would report "no output" for a
// run that went on to produce some.
// ---------------------------------------------------------------------------

/**
 * Where the host panel renders a completed run's own output, so the card can
 * point at it truthfully instead of guessing:
 *   - `transcript` — AgenticRunPanel renders the message thread below the card.
 *   - `steps`      — OrchestratorStepperPanel keeps it behind the step rail
 *                    (click a completed step to replay it).
 *   - `no-steps`   — same step-result evidence as `steps`, but the host has no
 *                    step rail to point at (`stepperSteps.length === 0`, e.g.
 *                    an immediate-trigger run with no declared steps). Naming
 *                    a "select a completed step" affordance that doesn't exist
 *                    on the page is a dead pointer — coderabbit finding on
 *                    cinatra#2519 (orchestrator-stepper-panel.tsx:1819).
 */
export type RunOutputHint = "transcript" | "steps" | "no-steps";

export type RunCompletionCardProps = {
  runId: string;
  /**
   * Template slug, used by "Start new run". Omitted by callers that don't have
   * one (chat surfaces) — the button is then left out rather than mounted
   * broken, matching the failed-run recovery affordance's rule.
   */
  agentId?: string;
  outputHint: RunOutputHint;
  /**
   * Test seam: pre-resolved evidence. When provided (including as `null`) the
   * card renders it directly and performs no read.
   */
  initialEvidence?: RunOutputEvidence | null;
};

export function RunCompletionCard({
  runId,
  agentId,
  outputHint,
  initialEvidence,
}: RunCompletionCardProps) {
  // Evidence is stored WITH the run it was read for, and the effective value is
  // derived during render. Keying it this way means a card reused for a
  // different `runId` (or handed different `initialEvidence`) never shows the
  // previous run's outputs while the new read is in flight — and it needs no
  // synchronous setState inside an effect to stay correct.
  const [resolved, setResolved] = useState<{
    runId: string;
    evidence: RunOutputEvidence | null;
  }>({ runId, evidence: initialEvidence ?? null });

  useEffect(() => {
    if (initialEvidence !== undefined) return;
    let cancelled = false;
    readRunOutputEvidence({ runId })
      .then((result) => {
        if (cancelled || !result.ok) return;
        setResolved({
          runId,
          evidence: {
            outputs: result.outputs,
            hasTranscript: result.hasTranscript,
            hasStepResults: result.hasStepResults,
            outputsUnavailable: result.outputsUnavailable,
            unlinkableOutputs: result.unlinkableOutputs,
          },
        });
      })
      .catch(() => {
        // Fail soft — unresolved evidence takes the conservative
        // "output may exist" branch, never a false "produced nothing".
      });
    return () => {
      cancelled = true;
    };
  }, [runId, initialEvidence]);

  const evidence =
    initialEvidence !== undefined
      ? initialEvidence
      : resolved.runId === runId
        ? resolved.evidence
        : null;

  const outcome = resolveRunTerminalOutcome({ status: "completed", evidence });
  if (outcome.kind === "not-terminal") return null;

  const producedNothing = outcome.kind === "completed-no-output";
  const linkedOutputs =
    outcome.kind === "completed-with-output" ? outcome.outputs : [];
  // We could not establish what the run left behind (read in flight, read
  // failed, or only unlinkable rows came back). The card must stay silent about
  // WHERE the output is — pointing at a transcript that is not there is the
  // same species of false claim as "produced nothing".
  const evidenceIndeterminate =
    outcome.kind === "completed-with-output" && outcome.evidenceIndeterminate;

  const description = producedNothing
    ? "This run reached the end of its steps but produced no output — nothing was returned and nothing was saved. Start a new run to try again."
    : linkedOutputs.length > 0
      ? "This run finished and saved its output."
      : evidenceIndeterminate
        ? "This run finished. Its output could not be loaded here — reload the page to try again."
        : outputHint === "transcript"
          ? "This run finished. Its output is in the run transcript below."
          : outputHint === "steps"
            ? "This run finished. Its output is recorded on the run's steps — select a completed step to review it."
            : "This run finished. Its output was recorded during the run, but there is no step list here to select from.";

  return (
    <Card data-run-completion={producedNothing ? "no-output" : "with-output"}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-foreground">
          {producedNothing ? "Run finished without output" : "Run complete"}
        </CardTitle>
        <CardDescription className="text-sm leading-6 text-muted-foreground">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-6 pt-0">
        {linkedOutputs.length > 0 && (
          <ul className="flex flex-col gap-2" data-run-outputs="">
            {linkedOutputs.map((output) => (
              <li key={output.id}>
                <Link
                  href={`/artifacts/${encodeURIComponent(output.id)}`}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  data-run-output-link={output.id}
                >
                  {output.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {/* Row wrapper: CardContent is a column flex, so an unwrapped button
            stretches to the full card width. */}
        {agentId ? (
          <div className="flex flex-wrap items-center gap-2">
            <StartNewRunButton agentId={agentId} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
