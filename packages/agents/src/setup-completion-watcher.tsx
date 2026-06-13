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
    if (!hasSeenInterrupt) return;
    if (streamResult.interruptContext !== null) return;
    if (streamResult.status === "pending_approval") return;

    fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((data: { inputParams?: Record<string, unknown> }) => {
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
  }, [streamResult.interruptContext, streamResult.status, hasSeenInterrupt, runId, requiredFields, agentId, instanceId, router, noRedirect]);

  // Polling-based navigation (fallback — covers agUiEnabled=false and any missed SSE events).
  useEffect(() => {
    if (hasFiredRef.current) return;
    const interval = window.setInterval(() => {
      if (hasFiredRef.current) { window.clearInterval(interval); return; }
      fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data: { status?: string; inputParams?: Record<string, unknown> }) => {
          const terminal = ["completed", "failed", "stopped"].includes(data.status ?? "");
          if (!terminal) return;
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
    />
  );
}
