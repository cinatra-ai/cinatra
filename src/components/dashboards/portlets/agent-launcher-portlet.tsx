"use client";

// Agent-launcher portlet. Starts an agent run for the configured agent
// (agentRef/agentPackage). Prefill inputs flow from upstream selection (the kind
// accepts arbitrary inputs); the user can edit the JSON before launching. The
// run is execute-gated server-side by the agent_run handler.
import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { launchAgentAction } from "@/lib/dashboards/portlet-actions";
import type { PortletComponentProps } from "./types";

export function AgentLauncherPortlet({ config, inputs, onOutput }: PortletComponentProps) {
  const agentRef = typeof config.agentRef === "string" ? config.agentRef : undefined;
  const agentPackage = typeof config.agentPackage === "string" ? config.agentPackage : undefined;
  // Seed the editable JSON from any resolved prefill inputs.
  const [params, setParams] = useState<string>(() => {
    const seed = Object.fromEntries(
      Object.entries(inputs).filter(([, v]) => v !== undefined && v !== null),
    );
    return Object.keys(seed).length > 0 ? JSON.stringify(seed, null, 2) : "{}";
  });
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!agentRef && !agentPackage) {
    return <p className="text-sm text-muted-foreground">Misconfigured: no agentRef/agentPackage.</p>;
  }

  function handleLaunch() {
    setError(null);
    setRunId(null);
    // Validate JSON client-side for a friendly error; the server re-validates.
    if (params.trim()) {
      try {
        JSON.parse(params);
      } catch {
        setError("Inputs must be valid JSON.");
        return;
      }
    }
    start(async () => {
      const res = await launchAgentAction({ agentRef, agentPackage, inputParams: params });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setRunId(res.runId);
      onOutput({ runId: res.runId });
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={params}
        onChange={(e) => setParams(e.target.value)}
        rows={5}
        aria-label="Agent input parameters (JSON)"
        className="font-mono text-xs"
      />
      <div className="flex items-center justify-between gap-3">
        <Button type="button" onClick={handleLaunch} disabled={pending}>
          {pending ? "Starting…" : "Run agent"}
        </Button>
        {runId ? (
          <Link href={`/agents/runs/${runId}`} className="text-sm text-primary underline">
            View run
          </Link>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
