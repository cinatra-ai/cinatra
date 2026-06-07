"use client";

/**
 * Status panel for the matches tab.
 *
 * Shows the last batch run summary + status badge. When the batch is
 * in-flight (validating | in_progress | finalizing), polls the
 * admin-gated /api/admin/skills/match-status endpoint every 30s and
 * re-renders.
 *
 * Polling uses window.setInterval inside useEffect, guarded by the in-flight
 * predicate, cleared on dependency change or unmount.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
// Import the centralized OpenAI Batch API status sets so the panel and the
// BullMQ poller (jobs.ts) agree on which statuses are in-flight vs terminal.
// A divergent local set would silently treat a new OpenAI status as terminal
// here (panel stops polling) and non-terminal in jobs.ts (poller reschedules
// forever) — split-brain on schema drift.
//
// Defensive policy: any unknown status string from the API is treated as
// in-flight (we'd rather over-poll than silently freeze the UI on a stale
// status). The constants module enforces disjointness + completeness via
// the `batch-status` unit test.
import {
  BATCH_STATUS_IN_FLIGHT,
  BATCH_STATUS_TERMINAL,
} from "@cinatra-ai/skills/llm-matching/constants";

export type StatusPanelBatchRun = {
  batchId: string;
  status: string;
  pairCount: number;
  submittedAt: string; // ISO 8601
  completedAt: string | null;
  lastPolledAt: string | null;
  errorMessage: string | null;
  evaluatorVersion: string;
};

/**
 * Treat unknown statuses as in-flight (defensive — see comment above).
 * A status that's neither in the in-flight nor terminal set is assumed to be
 * a new OpenAI intermediate state we don't yet recognize; we keep polling
 * rather than silently freezing the UI.
 */
function isInFlight(status: string): boolean {
  if (BATCH_STATUS_IN_FLIGHT.has(status)) return true;
  if (BATCH_STATUS_TERMINAL.has(status)) return false;
  return true; // unknown → defensive in-flight
}

function badgeVariantFor(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (isInFlight(status)) return "default";
  if (status === "completed") return "secondary";
  if (status === "failed" || status === "expired" || status === "cancelled") return "destructive";
  return "outline";
}

export function MatchesStatusPanel({ initialLatest }: { initialLatest: StatusPanelBatchRun | null }) {
  const [latest, setLatest] = useState<StatusPanelBatchRun | null>(initialLatest);
  const inFlight = latest ? isInFlight(latest.status) : false;

  useEffect(() => {
    if (!inFlight) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/admin/skills/match-status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { latest: StatusPanelBatchRun | null };
        if (!cancelled) setLatest(data.latest);
      } catch {
        // ignore — next tick retries
      }
    };
    void tick();
    const handle = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [inFlight]);

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Last batch run</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {latest ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={badgeVariantFor(latest.status)}>{latest.status}</Badge>
              <span className="text-muted-foreground">{latest.pairCount} pairs</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Submitted {new Date(latest.submittedAt).toLocaleString()}
              {latest.completedAt ? ` · Completed ${new Date(latest.completedAt).toLocaleString()}` : null}
            </div>
            {latest.errorMessage ? (
              <div className="text-xs text-destructive">{latest.errorMessage}</div>
            ) : null}
            <div className="text-xs text-muted-foreground">Evaluator: {latest.evaluatorVersion}</div>
            {inFlight ? (
              <div className="text-xs text-muted-foreground">
                Polling every 30 seconds while the batch is in progress…
              </div>
            ) : null}
          </>
        ) : (
          <div className="text-muted-foreground">No batch runs yet.</div>
        )}
      </CardContent>
    </Card>
  );
}
