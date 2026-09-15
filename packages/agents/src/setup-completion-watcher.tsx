"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AgenticRunPanel } from "./agentic-run-panel";
import type { SerializedAgentRunMessage } from "./agentic-run-panel";
import type { HitlGateContext } from "./run-surface-status";
import { useAgUiRunStream } from "./use-ag-ui-run-stream";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./agent-builder-ids";

type SetupCompletionWatcherProps = {
  runId: string;
  agentId: string;
  instanceId: string;
  agUiEnabled?: boolean | null;
  initialStatus: string;
  initialError: string | null;
  initialMessages: SerializedAgentRunMessage[];
  requiredFields: string[];
  initialInputParams?: Record<string, unknown> | null;
  agentPackageName?: string;
  traceId?: string | null;
  taskId?: string;
  /** Suppress /trigger redirect — for orchestrator agents that auto-run after setup. */
  noRedirect?: boolean;
  /**
   * True when the run has already fully EXECUTED (terminal `completed` with
   * execution evidence — step results, persisted messages, or streamed text).
   * `status === "completed"` alone is ambiguous: it also describes genuine
   * setup-success awaiting trigger configuration, which is what the /trigger
   * redirect exists for. An executed run redirected to /trigger strands the
   * user on a dead-end scheduler and makes its output unreachable — the base
   * run URL (Setup tab) is the only nav path to the output view (cinatra#831).
   * Computed server-side in instance-screens.tsx where the full run row is
   * available. Suppresses every redirect path (mount, SSE, polling).
   */
  runHasExecuted?: boolean;
  /**
   * True when this run already has an `agent_run_triggers` row (cinatra#2482).
   *
   * The /trigger redirect below exists to carry a run that finished SETUP into
   * the trigger step. Once a trigger EXISTS that step is done, so redirecting
   * back into it is a loop — and for the default "Run right after setup"
   * (immediate) trigger it is the exact loop this issue reports: Continue
   * persists the immediate trigger and routes to the run view, whose watcher
   * immediately bounces back to /trigger, where Continue is the only control.
   * `runHasExecuted` does not catch it: a run that produced no messages, no
   * step results and no streamed text reads as "not executed" no matter how
   * terminal it is.
   *
   * Suppresses every redirect path (mount, SSE, polling), exactly like
   * `runHasExecuted`.
   */
  triggerConfigured?: boolean;
  /**
   * DB-persisted streamed text, forwarded to AgenticRunPanel so an executed
   * external run's output renders even after its AG-UI event log expired
   * (parity with RunScreen). Empty/undefined for internal runs.
   */
  /**
   * May this person type in the run's prompt window (cinatra#2933)? Resolved on
   * the server from the RUN's access and forwarded to the panel unchanged.
   */
  canRespondInWindow?: boolean;
  /**
   * The run's template id (cinatra#2933, lifecycle-b W5b).
   *
   * This watcher is the run page's ONLY production mount of AgenticRunPanel
   * outside the chat, and the panel draws the run's prompt window only for a
   * caller that names the template: the window's turns POST to
   * /api/agents/builder/[templateId]/hitl-assist, and that route asks the RUN
   * whether this person may answer (`canRespondInRunWindow(runId, templateId)`).
   * Without the id there is no bound run to ask about, so the panel draws no
   * box at all -- which is what the run page did.
   *
   * The screen that mounts this watcher already holds the run's template row
   * and hands `template.id` to each of the other windows it mounts. It is
   * forwarded here unchanged, exactly like `canRespondInWindow`: no fallback,
   * no id invented on the client. Absent still means no window, which keeps
   * every caller that has no template byte-identical.
   */
  templateId?: string;
  initialStreamedText?: string;
  /**
   * Server-derived gate context for the first paint (see AgenticRunPanel's
   * `initialHitlContext`). The screen that mounts this watcher already holds
   * the run row and its template, so it can derive the open gate before the
   * page is served — the reader then sees the run's own form on arrival,
   * whichever entry path brought them here.
   */
  initialHitlContext?: HitlGateContext | null;
  /** cinatra#2997 — the run's review slot, read server-side by the screen that
   *  mounts this watcher and threaded straight through to the panel, so the run
   *  page's FIRST paint of a run that already has a review draws that review. */
  initialReviewGate?: { ref: string | null; awaiting: boolean } | null;
  /**
   * WAS THIS RUN'S SKILL SET DECIDED ON THE RECOMMENDATION CARD?
   *
   * Forwarded to the panel unchanged, exactly like `canRespondInWindow` and
   * `initialReviewGate`: no fallback and no second read. The panel draws no
   * recommendation card of its own any more (cinatra#3047) — the run page's rail
   * step is the row's one place — so the screen that owns that step answers this
   * for it, from the run's own park row.
   */
  recommendationDecided?: boolean;
  /** cinatra#3068 — the page's rail carries the run's input step, so the panel
   *  draws no "Agentic Run Progress" heading over the form. Forwarded through
   *  unchanged; see `AgenticRunPanel`'s own prop. */
  inputStepInRail?: boolean;
  /**
   * Forwarded to the panel unchanged, exactly like `inputStepInRail`: whether
   * the run page's two-column frame is drawn beside this column, so the gate's
   * own card is the whole page and no section plate is stacked around it
   * (cinatra#3047 fix leg 8).
   */
  railDrawsTheFrame?: boolean;
  /**
   * Forwarded to the panel unchanged: the two naming segments the run screen
   * resolved for the rail beside this column (cinatra#3080, fix leg 8). See
   * `AgenticRunPanel`'s own props.
   */
  reviewGateAgentLabel?: string | null;
  reviewGateStep?: { index: number; total: number } | null;
};

export function SetupCompletionWatcher({
  runId,
  agentId,
  instanceId,
  agUiEnabled,
  initialStatus,
  initialError,
  initialMessages,
  requiredFields,
  initialInputParams,
  agentPackageName,
  traceId,
  taskId,
  noRedirect = false,
  runHasExecuted = false,
  triggerConfigured = false,
  initialStreamedText,
  inputStepInRail = false,
  railDrawsTheFrame = false,
  canRespondInWindow,
  templateId,
  initialHitlContext,
  initialReviewGate,
  recommendationDecided,
  reviewGateAgentLabel,
  reviewGateStep,
}: SetupCompletionWatcherProps) {
  const router = useRouter();
  const hasFiredRef = useRef(false);
  const [hasSeenInterrupt, setHasSeenInterrupt] = useState(false);

  // Mount-time check: if all required fields are already in inputParams and the
  // run is past the setup phase, navigate to Trigger immediately. Handles the
  // case where the page loads after setup completed (no live stream events).
  useEffect(() => {
    if (hasFiredRef.current) return;
    const isPending = initialStatus === "pending_input" || initialStatus === "pending_approval";
    if (isPending) return;
    // A run that is already `failed`/`stopped` on load must stay on the run page
    // so its error stays visible — redirecting away would mask the failure
    // (cinatra#580). Non-failure post-setup states (completed and legitimate
    // in-flight `queued`/`running`) still advance to /trigger.
    if (initialStatus === "failed" || initialStatus === "stopped") return;
    // A run that already fully EXECUTED must stay on the run page so its
    // output stays reachable — the trigger scheduler is a dead end for it
    // (cinatra#831). Only setup-success `completed` (no execution evidence)
    // may still advance to /trigger.
    if (runHasExecuted) return;
    // cinatra#2482: the trigger step is already done — bouncing back into it is
    // the immediate-trigger loop.
    if (triggerConfigured) return;
    const params = initialInputParams ?? {};
    const allFilled = requiredFields.every((f) =>
      Object.prototype.hasOwnProperty.call(params, f),
    );
    if (allFilled && !noRedirect) {
      hasFiredRef.current = true;
      router.push(`/agents/${agentId}/${encodeURIComponent(instanceId)}/trigger`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  const streamResult = useAgUiRunStream(runId, {
    enabled: agUiEnabled === true,
    initialStatus,
  });

  useEffect(() => {
    // Only track setup-phase interrupts — mid-run HITL interrupts (e.g. recipients,
    // drafts, send) must not trigger the /trigger redirect.
    if (streamResult.interruptContext?.xRenderer === GROUPED_SETUP_FORM_RENDERER_ID) {
      setHasSeenInterrupt(true);
    }
  }, [streamResult.interruptContext]);

  // SSE-based navigation (fast path — fires when agUiEnabled=true and stream delivers events).
  useEffect(() => {
    if (hasFiredRef.current) return;
    // An executed run's replayed INTERRUPT/RESUME frames must not re-trigger
    // the redirect decision (cinatra#831) — the run is terminal; there is no
    // setup completion left to watch.
    if (runHasExecuted) return;
    if (triggerConfigured) return;
    if (!hasSeenInterrupt) return;
    if (streamResult.interruptContext !== null) return;
    if (streamResult.status === "pending_approval") return;

    fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((data: { status?: string; inputParams?: Record<string, unknown> }) => {
        // A run that failed/stopped after the setup interrupt cleared must stay
        // on the run page so its error stays visible — never redirect away from
        // a failure here (cinatra#580). Non-terminal post-setup states
        // (queued/running) and `completed` still advance to /trigger.
        if (data.status === "failed" || data.status === "stopped") return;
        const params = data.inputParams ?? {};
        const allFilled = requiredFields.every((f) =>
          Object.prototype.hasOwnProperty.call(params, f),
        );
        if (allFilled && !hasFiredRef.current && !noRedirect) {
          hasFiredRef.current = true;
          router.push(`/agents/${agentId}/${encodeURIComponent(instanceId)}/trigger`);
        }
      })
      .catch(() => {});
  }, [streamResult.interruptContext, streamResult.status, hasSeenInterrupt, runId, requiredFields, agentId, instanceId, router, noRedirect, runHasExecuted, triggerConfigured]);

  // Polling-based navigation (fallback — covers agUiEnabled=false and any missed SSE events).
  useEffect(() => {
    if (hasFiredRef.current) return;
    // Terminal executed run: nothing to watch — the poll's `completed` check
    // would misread execution success as setup success and bounce the user to
    // the dead-end scheduler 800ms after the mount guard spared them
    // (cinatra#831). Skip the interval entirely.
    if (runHasExecuted) return;
    if (triggerConfigured) return;
    const interval = window.setInterval(() => {
      if (hasFiredRef.current) { window.clearInterval(interval); return; }
      fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data: { status?: string; inputParams?: Record<string, unknown> }) => {
          // Only redirect on genuine setup-success. `failed`/`stopped` are NOT
          // setup completion — redirecting on them navigates the user away from
          // a failed run and discards the visible error (cinatra#580).
          //
          // cinatra#2523: `pending_trigger` is now the state a setup-success run
          // ends in — setup done, awaiting the trigger choice — so it is the
          // primary hand-off signal here. `completed` stays accepted: it is still
          // what a run that executed straight through reads as, and the mount/SSE
          // paths above have always advanced on it.
          if (data.status !== "completed" && data.status !== "pending_trigger") return;
          const params = data.inputParams ?? {};
          const allFilled = requiredFields.every((f) =>
            Object.prototype.hasOwnProperty.call(params, f),
          );
          if (allFilled && !hasFiredRef.current && !noRedirect) {
            hasFiredRef.current = true;
            window.clearInterval(interval);
            router.push(`/agents/${agentId}/${encodeURIComponent(instanceId)}/trigger`);
          }
        })
        .catch(() => {});
    }, 800);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable refs only — intentionally runs once

  return (
    <AgenticRunPanel
      canRespondInWindow={canRespondInWindow}
      templateId={templateId}
      runId={runId}
      initialStatus={initialStatus}
      initialError={initialError}
      initialMessages={initialMessages}
      agUiEnabled={agUiEnabled}
      agentId={agentId}
      agentPackageName={agentPackageName}
      traceId={traceId}
      taskId={taskId}
      inputParams={initialInputParams ?? undefined}
      initialStreamedText={initialStreamedText}
      initialHitlContext={initialHitlContext}
      initialReviewGate={initialReviewGate}
      recommendationDecided={recommendationDecided}
      inputStepInRail={inputStepInRail}
      railDrawsTheFrame={railDrawsTheFrame}
      reviewGateAgentLabel={reviewGateAgentLabel}
      reviewGateStep={reviewGateStep}
    />
  );
}
