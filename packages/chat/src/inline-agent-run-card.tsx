"use client";

/**
 * Inline AgenticRunPanel wrapper for the chat thread.
 *
 * When the chat dispatches an agent via the hard pre-router
 * (src/app/api/chat/explicit-dispatch-server.ts), the synthetic `tool_result`
 * event carries the runId. ChatPage tracks active run ids in a map and renders
 * <InlineAgentRunCard runId={...}> beneath the assistant message — surfacing
 * the SAME AgenticRunPanel that the /agents/<v>/<s>/<runId> detail page uses.
 *
 * Why this wrapper exists rather than rendering AgenticRunPanel directly:
 *
 *   AgenticRunPanel's props include `initialStatus`, `initialMessages`,
 *   `inputParams`, `templateId`, `agentPackageName`, `agUiEnabled`, `taskId`,
 *   `traceId` — all SSR-loaded directly from the DB on the run-detail page.
 *   The chat thread doesn't have those at render time; it only knows the
 *   runId from the tool_result event. This component performs the one-shot
 *   GET /api/agents/runs/<runId> needed to seed those props, then mounts
 *   AgenticRunPanel with the loaded values. AgenticRunPanel itself owns all
 *   subsequent polling + SSE + HITL drive logic (Continue button, fieldName
 *   wrapping, stale-gate suppression, grouped setup handling).
 *
 * The chat thread renders AgenticRunPanel directly so its inline HITL behavior
 * matches the run-detail page, including fieldName-wrapping, the Continue
 * button, stale-gate suppression, and grouped setup handling.
 */

import { useEffect, useState } from "react";
import {
  AgenticRunPanel,
  type SerializedAgentRunMessage,
  type ChatGateDescriptor,
} from "@cinatra-ai/agents/client-entry";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentCreationProgress } from "./use-agent-creation-progress";

/**
 * Append-only creation-progress timeline.
 * Rendered ABOVE <AgenticRunPanel>. Empty list → chrome NOT rendered.
 */
function CreationProgressTimeline({ runId }: { runId: string }) {
  const rows = useAgentCreationProgress(runId);
  if (rows.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none mb-2">
      <CardHeader>
        <CardTitle className="text-sm text-foreground">
          Creation progress
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="soft-panel rounded-panel flex flex-col gap-1 p-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-baseline gap-2 text-sm text-foreground"
            >
              <span className="font-medium">{row.title}</span>
              {row.body ? (
                <span className="text-muted-foreground">{row.body}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

type SeedData = {
  status: string;
  error: string | null;
  inputParams: Record<string, unknown>;
  templateId: string;
  agentPackageName: string | null;
  agUiEnabled: boolean | null;
  taskId: string | null;
  traceId: string | null;
  messages: SerializedAgentRunMessage[];
};

type LoadFailureReason = "not-found" | "forbidden" | "transient";

function classifyStatus(status: number): LoadFailureReason {
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "forbidden";
  return "transient";
}

export function InlineAgentRunCard({
  runId,
  onActiveGateChange,
}: {
  runId: string;
  /**
   * Forwarded to AgenticRunPanel so the chat thread can drive an open HITL gate
   * via the prompt window. Fires with a stable descriptor on gate identity
   * change, or null (same runId) when the gate closes.
   */
  onActiveGateChange?: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
}) {
  const [seed, setSeed] = useState<SeedData | null>(null);
  const [loadError, setLoadError] = useState<LoadFailureReason | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset state when runId changes — defensive hygiene even though chat
    // typically mounts a fresh component per runId.
    setSeed(null);
    setLoadError(null);

    // The hard pre-router awaits `invokePrimitive("agent_run", ...)` before
    // emitting the synthetic SSE tool_result, so the run row is already in
    // the DB by the time this component mounts. Retry only on the off chance
    // of a transient read race: 2 attempts with 250ms/750ms backoff.
    const RETRY_DELAYS_MS = [250, 750];
    let attempt = 0;

    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          const reason = classifyStatus(res.status);
          if (reason !== "forbidden" && attempt < RETRY_DELAYS_MS.length) {
            const delay = RETRY_DELAYS_MS[attempt];
            attempt += 1;
            setTimeout(() => {
              if (!cancelled) void load();
            }, delay);
            return;
          }
          setLoadError(reason);
          return;
        }
        const body = (await res.json()) as SeedData;
        if (cancelled) return;
        setSeed(body);
      } catch {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          attempt += 1;
          setTimeout(() => {
            if (!cancelled) void load();
          }, delay);
          return;
        }
        setLoadError("transient");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loadError) {
    const message =
      loadError === "not-found"
        ? `Agent run ${runId.slice(0, 8)} is not available yet.`
        : loadError === "forbidden"
          ? "You do not have access to this agent run."
          : `Could not load agent run ${runId.slice(0, 8)} — please try again.`;
    return (
      <div className="soft-panel rounded-panel p-3 my-2 text-sm text-muted-foreground">
        {message}
      </div>
    );
  }

  if (!seed) {
    return (
      <div className="soft-panel rounded-panel p-3 my-2 text-sm text-muted-foreground">
        Loading agent run…
      </div>
    );
  }

  return (
    <div className="my-2">
      <CreationProgressTimeline runId={runId} />
      <AgenticRunPanel
        runId={runId}
        taskId={seed.taskId ?? undefined}
        initialStatus={seed.status}
        initialError={seed.error}
        initialMessages={seed.messages}
        agUiEnabled={seed.agUiEnabled ?? undefined}
        agentPackageName={seed.agentPackageName ?? undefined}
        traceId={seed.traceId ?? undefined}
        inputParams={seed.inputParams}
        templateId={seed.templateId}
        onActiveGateChange={onActiveGateChange}
      />
    </div>
  );
}
