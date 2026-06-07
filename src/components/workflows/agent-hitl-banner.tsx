import Link from "next/link";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Surface `agent_hitl` events the engine bubbles for child agent runs in
// `pending_approval`. These are distinct from workflow-native approvals (which
// use workflow_approval rows + the inline approve/reject panel); here the agent
// ITSELF paused for human input on its own run, and the operator's path is the
// agent run dashboard, not the workflow approval gate. Banner is a read-only
// summary; deep-link to the run.

export type ActiveAgentHitlBannerItem = {
  id: string;
  taskKey: string | null;
  childRunId: string;
  childRunStatus: string;
  createdAtIso: string;
  runHref: string;
};

type Props = { events: ActiveAgentHitlBannerItem[] };

export function AgentHitlBanner({ events }: Props) {
  if (events.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Agent paused for review ({events.length})</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {events.map((e) => (
          <div
            key={e.id}
            className="soft-panel rounded-card flex items-center justify-between gap-4 p-4"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">
                  {e.taskKey ? `Task ${e.taskKey}` : "Task"}: child agent run is awaiting human input
                </span>
                <Badge variant="outline" className="text-xs">{e.childRunStatus}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Decide on the agent run; the workflow gate is satisfied separately.{" "}
                <span className="font-mono">{format(new Date(e.createdAtIso), "MMM d, HH:mm")}</span>
              </p>
            </div>
            <Link
              href={e.runHref}
              className="text-sm font-semibold text-primary hover:underline"
              data-testid={`agent-hitl-link-${e.id}`}
            >
              Review run →
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
