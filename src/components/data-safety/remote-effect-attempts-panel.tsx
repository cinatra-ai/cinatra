import "server-only";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { RetryRemoteEffectButton } from "@/components/data-safety/retry-remote-effect-button";
import type { RemoteEffectAttempt } from "@/lib/object-history";

// Connector restore lifecycle on the change-set detail
// page. Renders attempt status, count, last error, connector,
// target. platform_admin actors get a per-row Retry button. Pure presentation
// — the parent page computes the (read-filtered) attempts + admin flag.
export type RemoteEffectAttemptsPanelProps = {
  attempts: RemoteEffectAttempt[];
  isPlatformAdmin: boolean;
};

const ATTEMPT_PILL: Record<string, StatusPillStatus> = {
  pending: "queued",
  succeeded: "approved",
  failed: "failed",
};

export function RemoteEffectAttemptsPanel({
  attempts,
  isPlatformAdmin,
}: RemoteEffectAttemptsPanelProps) {
  if (attempts.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Connector attempts</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {attempts.map((a) => (
          <div key={a.id} className="soft-panel flex flex-col gap-2 p-3">
            <div className="flex items-center gap-2">
              <StatusPill status={ATTEMPT_PILL[a.status] ?? "idle"}>
                {a.status}
              </StatusPill>
              <span className="text-xs text-muted-foreground">
                {a.connectorName}
                {a.targetId ? ` · ${a.targetKind}/${a.targetId.slice(0, 12)}…` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                attempt {a.attemptCount}
              </span>
              {isPlatformAdmin && a.status !== "succeeded" ? (
                <span className="ml-auto">
                  <RetryRemoteEffectButton attemptId={a.id} />
                </span>
              ) : null}
            </div>
            {a.lastError ? (
              <p className="text-xs text-destructive">{a.lastError}</p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
