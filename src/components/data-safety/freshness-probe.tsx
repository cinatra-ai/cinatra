"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { freshnessCheckAction } from "@/components/data-safety/freshness-actions";
import type { ChangeSetFreshnessResult } from "@/lib/object-history";

// "Check remote freshness" probe on the change-set detail
// page. Rendered only when the change-set has CMS-tagged
// events. Surfaces the 5-state verdict per event via <StatusPill>.
export type FreshnessProbeProps = { changeSetId: string };

const FRESHNESS_PILL: Record<string, StatusPillStatus> = {
  fresh: "approved",
  changed: "needs-review",
  missing: "failed",
  unknown: "hold",
  unsupported: "idle",
};

function pillFor(state: string): StatusPillStatus {
  return FRESHNESS_PILL[state] ?? "idle";
}

export function FreshnessProbe({ changeSetId }: FreshnessProbeProps) {
  const [pending, startTransition] = useTransition();
  const [results, setResults] = useState<ChangeSetFreshnessResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onCheck() {
    setError(null);
    startTransition(async () => {
      const result = await freshnessCheckAction({ changeSetId });
      if (result.ok) {
        setResults(result.data ?? []);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="outline" size="sm" onClick={onCheck} disabled={pending}>
          <RefreshCw data-icon="inline-start" />
          {pending ? "Checking…" : "Check remote freshness"}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="status">
          {error}
        </p>
      ) : null}
      {results ? (
        results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No CMS-tagged events to probe (or none you can read).
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((r) => (
              <li
                key={r.eventId}
                className="soft-panel flex items-center gap-2 p-3"
              >
                <StatusPill status={pillFor(r.freshness.state)}>
                  {r.freshness.state}
                </StatusPill>
                <span className="font-mono text-xs text-muted-foreground">
                  {r.objectId.slice(0, 24)}…
                </span>
                {r.freshness.state === "unknown" && r.freshness.reason ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.freshness.reason}
                  </span>
                ) : null}
                {r.freshness.state === "changed" &&
                r.freshness.changedFields?.length ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    changed: {r.freshness.changedFields.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
