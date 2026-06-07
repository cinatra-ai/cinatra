"use client";

/**
 * OrchestratorRunPanel client component.
 *
 * Renders a CSS-grid list of sub-agent nodes and polls the orchestrator's
 * status every 3 s via revalidateOrchestratorStatusAction.
 *
 * Polling invariant: the interval is cleared when `status` enters
 * TERMINAL_STATUSES (completed | failed | stopped). TERMINAL_STATUSES is
 * imported RELATIVELY from ./orchestrator-execution — never via the package
 * alias @cinatra/agent-builder (that would create a self-import cycle).
 *
 * Cancel button: disabled when status is terminal; invokes
 * cancelOrchestratorAction(orchestratorRunId) on click. On failure the server
 * action returns { ok: false, error } and we display it inline.
 */

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SubAgentNodeData } from "./orchestrator-readiness";
import { SubAgentNode } from "./orchestrator-sub-agent-node";
import {
  cancelOrchestratorAction,
  revalidateOrchestratorStatusAction,
} from "./orchestrator-actions";

// Inlined to avoid importing ./orchestrator-execution (server-only chain: store →
// background-jobs → bullmq → worker_threads) into the client bundle.
// Must stay in sync with TERMINAL_STATUSES in orchestrator-execution.ts.
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type OrchestratorRunPanelProps = {
  orchestratorRunId: string;
  orchestratorStatus: string;
  nodes: SubAgentNodeData[];
  agentId: string;
  instanceId: string;
};

// ---------------------------------------------------------------------------
// Child status overlay — used to coerce node displayStatus from fresh data
// returned by the polling action (until the parent RSC re-renders via
// revalidatePath after cancel or a terminal transition).
// ---------------------------------------------------------------------------

type ChildStatusEntry = {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
};

function deriveNodeDisplayStatus(
  node: SubAgentNodeData,
  childEntry: ChildStatusEntry | undefined,
): SubAgentNodeData["displayStatus"] {
  if (!childEntry) return node.displayStatus;
  const s = childEntry.status;
  if (s === "completed") return "completed";
  if (s === "failed" || s === "stopped") return "failed";
  if (s === "pending_approval") return "pending-hitl";
  if (s === "running" || s === "queued" || s === "pending_input") return "running";
  return node.displayStatus;
}

// ---------------------------------------------------------------------------
// OrchestratorRunPanel
// ---------------------------------------------------------------------------

export function OrchestratorRunPanel({
  orchestratorRunId,
  orchestratorStatus,
  nodes,
  agentId,
  instanceId,
}: OrchestratorRunPanelProps) {
  const [status, setStatus] = useState(orchestratorStatus);
  const [childrenStatuses, setChildrenStatuses] = useState<
    Record<string, ChildStatusEntry>
  >({});
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Polling effect — stopped when status is terminal.
  // `status` is NOT in the dep array — checking terminality inside the callback
  // avoids restarting the interval on every status change.
  useEffect(() => {
    // Skip polling if already terminal at mount time — no interval needed.
    if (TERMINAL_STATUSES.has(orchestratorStatus)) return;

    const id = window.setInterval(() => {
      startTransition(async () => {
        const next = await revalidateOrchestratorStatusAction(orchestratorRunId);
        if (!next) return;
        if (TERMINAL_STATUSES.has(next.status)) {
          window.clearInterval(id);
        }
        setStatus(next.status);
        setChildrenStatuses(
          Object.fromEntries(next.children.map((c) => [c.id, c])),
        );
      });
    }, 3000);

    return () => window.clearInterval(id);
    // orchestratorStatus intentionally excluded from deps to avoid restarting
    // the interval on every status transition; it is only read once at mount
    // for the terminal guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestratorRunId]);

  const isTerminal = TERMINAL_STATUSES.has(status);

  function handleCancel() {
    setCancelError(null);
    startTransition(async () => {
      const res = await cancelOrchestratorAction(orchestratorRunId);
      if (!res.ok) {
        setCancelError(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-foreground">
          Sub-agents
        </CardTitle>
        <CardAction>
          <Button
            variant="destructive"
            size="sm"
            disabled={isTerminal || isPending}
            onClick={handleCancel}
          >
            Cancel run
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Separator />

        {/* Sub-agent grid */}
        <div className="grid grid-cols-1 gap-3">
          {nodes.map((node) => {
            const childEntry = node.childRunId
              ? childrenStatuses[node.childRunId]
              : undefined;
            const overlayStatus = deriveNodeDisplayStatus(node, childEntry);
            return (
              <SubAgentNode
                key={node.packageName}
                {...node}
                displayStatus={overlayStatus}
                agentId={agentId}
                instanceId={instanceId}
              />
            );
          })}
        </div>

        {/* Cancel error */}
        {cancelError && (
          <p className="text-sm text-destructive">{cancelError}</p>
        )}
      </CardContent>
    </Card>
  );
}
