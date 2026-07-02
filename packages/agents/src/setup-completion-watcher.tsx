"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AgenticRunPanel } from "./agentic-run-panel";
import type { SerializedAgentRunMessage } from "./agentic-run-panel";
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
   * DB-persisted streamed text, forwarded to AgenticRunPanel so an executed
   * external run's output renders even after its AG-UI event log expired
   * (parity with RunScreen). Empty/undefined for internal runs.
   */
  initialStreamedText?: string;
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
  initialStreamedText,
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
  }, [streamResult.interruptContext, streamResult.status, hasSeenInterrupt, runId, requiredFields, agentId, instanceId, router, noRedirect, runHasExecuted]);

  // Polling-based navigation (fallback — covers agUiEnabled=false and any missed SSE events).
  useEffect(() => {
    if (hasFiredRef.current) return;
    // Terminal executed run: nothing to watch — the poll's `completed` check
    // would misread execution success as setup success and bounce the user to
    // the dead-end scheduler 800ms after the mount guard spared them
    // (cinatra#831). Skip the interval entirely.
    if (runHasExecuted) return;
    const interval = window.setInterval(() => {
      if (hasFiredRef.current) { window.clearInterval(interval); return; }
      fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data: { status?: string; inputParams?: Record<string, unknown> }) => {
          // Only redirect on genuine setup-success. `failed`/`stopped` are NOT
          // setup completion — redirecting on them navigates the user away from
          // a failed run and discards the visible error (cinatra#580).
          if (data.status !== "completed") return;
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
      runId={runId}
      initialStatus={initialStatus}
      initialError={initialError}
      initialMessages={initialMessages}
      agUiEnabled={agUiEnabled}
      agentPackageName={agentPackageName}
      traceId={traceId}
      taskId={taskId}
      inputParams={initialInputParams ?? undefined}
      initialStreamedText={initialStreamedText}
    />
  );
}
