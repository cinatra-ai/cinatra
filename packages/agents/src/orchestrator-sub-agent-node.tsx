"use client";

/**
 * SubAgentNode presentational client component.
 *
 * Renders a single sub-agent entry in the orchestrator run dashboard.
 * Props extend SubAgentNodeData from the classifier.
 *
 * Design constraints:
 *  - Shadcn only: Badge, Button — no raw button or anchor HTML tags.
 *  - Semantic tokens only — no hardcoded colors.
 *  - scheduledAt is ignored until scheduling is supported.
 *  - Relative imports only — do NOT import via @cinatra/agent-builder alias.
 */

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Circle,
  CircleDot,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type { SubAgentNodeData, SubAgentDisplayStatus } from "./orchestrator-readiness";

// ---------------------------------------------------------------------------
// Status icon lookup — keyed by displayStatus
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

const STATUS_ICONS: Record<
  SubAgentDisplayStatus,
  React.ComponentType<IconProps>
> = {
  "not-installed": Circle,
  "setup-not-started": Circle,
  "configured-pending-run": CircleDot,
  running: Loader2,
  "pending-hitl": CircleDot,
  completed: CheckCircle2,
  failed: XCircle,
};

function statusIconClass(displayStatus: SubAgentDisplayStatus): string {
  switch (displayStatus) {
    case "completed":
      return "size-4 text-foreground";
    case "running":
    case "pending-hitl":
      return "size-4 text-foreground animate-spin";
    case "failed":
      return "size-4 text-destructive";
    default:
      // not-installed, setup-not-started, configured-pending-run
      return "size-4 text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// SubAgentNodeProps
// ---------------------------------------------------------------------------

export type SubAgentNodeProps = SubAgentNodeData & {
  agentId: string;
  instanceId: string;
};

// ---------------------------------------------------------------------------
// SubAgentNode
// ---------------------------------------------------------------------------

export function SubAgentNode({
  displayName,
  childRunId,
  displayStatus,
  readinessHint,
  agentId,
  instanceId,
}: SubAgentNodeProps) {
  const Icon = STATUS_ICONS[displayStatus];
  const iconClass = statusIconClass(displayStatus);

  // Sub-agents have no standalone workspace — all configuration and results
  // live inside the orchestrator's own Setup/Run tabs.
  const isConfigureMode = childRunId === null;
  const label = isConfigureMode ? "Setup" : "Run";

  // Configure → orchestrator Setup tab; Open → orchestrator Run tab
  const href = isConfigureMode
    ? `/agents/${agentId}/${encodeURIComponent(instanceId)}`
    : `/agents/${agentId}/${encodeURIComponent(instanceId)}/run`;

  return (
    <div className="soft-panel rounded-card flex items-center gap-3 px-4 py-3">
      {/* Status icon */}
      <Icon className={iconClass} aria-hidden="true" />

      {/* Name + hint */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
        {readinessHint && (
          <p className="truncate text-xs text-muted-foreground">{readinessHint}</p>
        )}
      </div>

      {/* Status badge */}
      <Badge variant="outline">{displayStatus}</Badge>

      <Button asChild variant="ghost" size="sm">
        <Link href={href}>{label}</Link>
      </Button>
    </div>
  );
}
