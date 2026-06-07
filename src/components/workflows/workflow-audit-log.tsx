import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// workflow_event audit log surface.
// Read-only. The engine writes events (dispatched / succeeded / failed /
// retry_scheduled / dead_lettered / recovered / skipped / agent_hitl /
// workflow_completed / workflow_failed / etc.); this just surfaces them so
// operators can see what happened without dropping to SQL. Bounded by the
// page-side query limit (default 50).

export type WorkflowAuditLogItem = {
  id: string;
  kind: string;
  taskKey: string | null;
  source: string | null;
  actorId: string | null;
  createdAtIso: string;
};

type Props = { events: WorkflowAuditLogItem[] };

export function WorkflowAuditLog({ events }: Props) {
  if (events.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Activity ({events.length})</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-0">
        <ul className="flex flex-col divide-y divide-line">
          {events.map((e) => (
            <li
              key={e.id}
              data-testid={`audit-event-${e.id}`}
              className="grid grid-cols-[minmax(8rem,10rem)_minmax(6rem,8rem)_1fr_auto] items-center gap-4 px-4 py-2"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {format(new Date(e.createdAtIso), "MMM d, HH:mm:ss")}
              </span>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {e.kind}
              </Badge>
              <span className="truncate text-sm text-foreground">
                {e.taskKey ? `task ${e.taskKey}` : "workflow"}
                {e.source && (
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">via {e.source}</span>
                )}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {e.actorId ?? ""}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
