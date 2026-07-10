"use client";

// ---------------------------------------------------------------------------
// Tool-call chip (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Presentational chip for one `UiToolCall` produced by the AG-UI reducer.
// Token-driven (no per-surface CSS) so it inherits the host's palette. Mirrors
// the bespoke chat tool-chip: a running spinner-dot + progress label, a
// completed check + result label, a failed cross. The label derives from the
// tool NAME (+ serverLabel) via the shared `formatToolCallLabel` — AG-UI's
// TOOL_CALL_END carries no label, so there is nothing else to show.

import {
  formatToolCallLabel,
  formatToolProgressStatus,
  type ToolCallLike,
} from "../../assistant-parts";
import type { UiToolCall } from "../../types";

const DOT_BY_STATUS: Record<UiToolCall["status"], string> = {
  running: "bg-amber-500 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
};

export function ToolCallChip({ toolCall }: { toolCall: UiToolCall }) {
  const like: ToolCallLike = {
    name: toolCall.name,
    serverLabel: toolCall.serverLabel,
  };
  const label =
    toolCall.status === "running"
      ? formatToolProgressStatus(like)
      : (toolCall.resultLabel ?? formatToolCallLabel(like));
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-1 text-xs text-muted-foreground"
      data-tool-call-id={toolCall.id}
      data-tool-status={toolCall.status}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_BY_STATUS[toolCall.status]}`}
      />
      <span className="text-foreground">{label}</span>
    </span>
  );
}
