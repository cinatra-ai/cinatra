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
import {
  reviewRevisionMarker,
  reviewTypeLabel,
} from "@/lib/artifacts/review-surface-model";
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

// ---------------------------------------------------------------------------
// THE PRESENTATION AXIS (cinatra#2729 review round)
// ---------------------------------------------------------------------------
//
// A finished run's produced artifact appears in a CONVERSATION as part of the
// review lifecycle, and the core already ships what that looks like: the
// lifecycle card renders its target through `ReviewTargetPanel` — the shell the
// review page has always used, and the one `ReviewGateCard` mounts verbatim on
// every first-party host ("it reuses the shipped review components, it does not
// restyle them"). Drawn as a generic panel card instead, the same artifact reads
// as a different species of object in the same thread.
//
// So the chat mount asks for the `review-lifecycle` presentation: the target
// shell (`overflow-hidden rounded-control border border-line bg-surface-strong`),
// the header band with the artifact's title and its type pill, the mono identity
// line, and the `p-4` body slot. The class vocabulary and the
// `review-target` conformance anchor are the core's, copied from
// `ReviewTargetPanel`, not invented here — `run-completion-review-shell.test.ts`
// reads that component and fails if the two ever drift.
//
// `panel` is the pre-existing rendering and stays the default, so the run-detail
// surface is byte-identical to what it shipped.
export type RunCompletionPresentation = "panel" | "review-lifecycle";

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
  /** See {@link RunCompletionPresentation}. Defaults to the shipped panel. */
  presentation?: RunCompletionPresentation;
};

/**
 * The core review-target shell, verbatim from `ReviewTargetPanel` (the review
 * page's own component, which `ReviewGateCard` renders through its island on
 * every first-party host). Kept as named constants so the drift test can
 * compare them to that component's source, string for string.
 */
export const REVIEW_TARGET_SHELL_CLASS =
  "overflow-hidden rounded-control border border-line bg-surface-strong";
export const REVIEW_TARGET_HEADER_CLASS = "border-b border-line px-4 py-3";
export const REVIEW_TARGET_TITLE_CLASS =
  "font-sans text-sm font-bold text-foreground";
export const REVIEW_TARGET_TYPE_PILL_CLASS =
  "inline-flex items-center rounded-full border border-blue/30 bg-blue/10 px-2 py-0.5 text-xs font-semibold text-blue";
export const REVIEW_TARGET_IDENTITY_CLASS =
  "mt-1 font-mono text-badge-xs tracking-tight text-muted-foreground";
export const REVIEW_TARGET_BODY_CLASS = "p-4";

/**
 * ONE produced artifact, drawn as the review lifecycle draws a target.
 * Display-only by construction: a finished run has no open gate, so there is no
 * decision floor under it — the reader opens the artifact to review it.
 */
function ProducedArtifactTarget({
  output,
}: {
  output: { id: string; type: string; title: string };
}) {
  const marker = reviewRevisionMarker(output.id);
  return (
    <div
      data-conformance-id="review-target"
      data-run-output-target={output.id}
      className={REVIEW_TARGET_SHELL_CLASS}
    >
      <div className={REVIEW_TARGET_HEADER_CLASS}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={REVIEW_TARGET_TITLE_CLASS}>{output.title}</span>
          <span className={REVIEW_TARGET_TYPE_PILL_CLASS}>
            {reviewTypeLabel(output.type)}
          </span>
        </div>
        <p className={REVIEW_TARGET_IDENTITY_CLASS} title={marker.full}>
          {marker.short}
        </p>
      </div>
      <div className={REVIEW_TARGET_BODY_CLASS}>
        <p className="text-xs text-muted-foreground">
          This run produced it. Open it to review the draft.
        </p>
        {/* The canonical target's own action shape: a link-variant button with
            a plain verb (the review floor's Preview / Download). The title is
            already the header — repeating it here would say the same thing
            twice in one card. */}
        <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
          <Link
            href={`/artifacts/${encodeURIComponent(output.id)}`}
            data-run-output-link={output.id}
          >
            Open
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The terminal state in the SAME shell when there is no artifact to draw —
 * a run that produced nothing, or output we could not resolve. The shell is
 * the lifecycle's, so a conversation never switches card species mid-thread.
 */
function CompletionStatementTarget({
  title,
  description,
  producedNothing,
}: {
  title: string;
  description: string;
  producedNothing: boolean;
}) {
  return (
    <div
      data-conformance-id="review-target"
      data-run-completion={producedNothing ? "no-output" : "with-output"}
      className={REVIEW_TARGET_SHELL_CLASS}
    >
      <div className={REVIEW_TARGET_HEADER_CLASS}>
        <span className={REVIEW_TARGET_TITLE_CLASS}>{title}</span>
      </div>
      <div className={REVIEW_TARGET_BODY_CLASS}>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function RunCompletionCard({
  runId,
  agentId,
  outputHint,
  initialEvidence,
  presentation = "panel",
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

  // THE REVIEW-LIFECYCLE PRESENTATION (the conversation surface). Each produced
  // artifact is drawn the way the lifecycle draws a review target; with none to
  // draw, the same shell carries the terminal statement. "Start new run" is not
  // part of this presentation — the callers that ask for it are the ones that
  // withhold the slug anyway, and a review target has never carried a run
  // control.
  if (presentation === "review-lifecycle") {
    if (linkedOutputs.length > 0) {
      return (
        <div className="flex w-full flex-col gap-3" data-run-outputs="">
          {linkedOutputs.map((output) => (
            <ProducedArtifactTarget key={output.id} output={output} />
          ))}
        </div>
      );
    }
    return (
      <CompletionStatementTarget
        title={producedNothing ? "Run finished without output" : "Run complete"}
        description={description}
        producedNothing={producedNothing}
      />
    );
  }

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
