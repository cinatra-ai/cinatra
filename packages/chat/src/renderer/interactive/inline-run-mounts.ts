// ---------------------------------------------------------------------------
// Inline agent-run mount points (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// PURE selector: given the reducer's assistant `UiMessage`, return the ordered,
// de-duplicated list of agent-run mounts — each a `{ toolCallId, runId }` where
// a `tool_call` part had a runId pinned (by a DATA_PART, see the reducer). The
// host mounts one `<InlineAgentRunCard runId={...} />` (exported from
// `@cinatra-ai/chat`) per mount, beneath the assistant message — exactly as the
// bespoke chat thread does. This selector is the reusable, testable seam; the
// heavy AgenticRunPanel wrapper stays out of this light module so embedding it
// never pulls the run-panel bundle.

import type { UiMessage } from "../../types";

export type InlineRunMount = {
  toolCallId: string;
  runId: string;
};

/** Ordered, de-duplicated agent-run mounts pinned on the message's parts. */
export function resolveInlineRunMounts(message: UiMessage): InlineRunMount[] {
  const parts = message.parts;
  if (!parts || parts.length === 0) return [];
  const seen = new Set<string>();
  const mounts: InlineRunMount[] = [];
  for (const part of parts) {
    if (part.kind !== "tool_call") continue;
    if (typeof part.runId !== "string" || part.runId.length === 0) continue;
    if (seen.has(part.runId)) continue;
    seen.add(part.runId);
    mounts.push({ toolCallId: part.id, runId: part.runId });
  }
  return mounts;
}
