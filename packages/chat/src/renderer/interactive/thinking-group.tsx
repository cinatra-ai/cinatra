"use client";

// ---------------------------------------------------------------------------
// Thinking group (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Renders one `UiThoughtGroup`: the "Thought for Ns" header (when the run
// recorded thinking time) plus the group's tool-call chips. Mirrors the bespoke
// chat thinking-group chrome. Empty groups (no tools, no thinking time) render
// nothing.

import type { UiThoughtGroup } from "../../types";
import { ToolCallChip } from "./tool-call-chip";

export function ThinkingGroup({ group }: { group: UiThoughtGroup }) {
  const seconds = group.thinkingSeconds ?? 0;
  const hasTools = group.toolCalls.length > 0;
  if (seconds <= 0 && !hasTools) return null;
  return (
    <div className="my-2 flex flex-col gap-1.5" data-thought-group-id={group.id}>
      {seconds > 0 && (
        <div className="text-xs text-muted-foreground">
          Thought for {seconds}s
        </div>
      )}
      {hasTools && (
        <div className="flex flex-wrap gap-1.5">
          {group.toolCalls.map((tc) => (
            <ToolCallChip key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
