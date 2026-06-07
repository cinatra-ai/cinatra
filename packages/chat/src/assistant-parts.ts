/**
 * Pure helpers for maintaining the chronological `parts` trace on an
 * assistant message during a streaming chat turn. Extracted so the
 * transition logic (when to append-vs-extend a text part, dedupe
 * tool_call by id, mutate tool_result in place, etc.) can be unit
 * tested without driving the whole React component.
 *
 * Each helper takes the current parts array and an event payload, and
 * returns the next parts array. Pure / immutable.
 */

export type AssistantTextPart = { kind: "text"; content: string };

export type AssistantToolCallPart = {
  kind: "tool_call";
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  resultLabel?: string;
  serverLabel?: string;
  /**
   * When the tool is `agent_run`, the server parses the tool_result
   * `result` JSON `{ runId, status }` and pins `runId` here so the chat
   * renderer can mount <InlineAgentRunCard runId={...} /> inline beneath
   * the assistant message. Always undefined for non-agent_run tools.
   */
  runId?: string;
};

export type AssistantMessagePart = AssistantTextPart | AssistantToolCallPart;

/**
 * Apply a text delta. If the tail of `parts` is already a text part,
 * extend it; otherwise push a new text part. Caller is responsible for
 * computing the round separator (paragraph break after a tool-use round)
 * and passing it as part of `delta` — the helper just appends verbatim.
 */
export function applyTextDelta(
  parts: AssistantMessagePart[],
  delta: string,
): AssistantMessagePart[] {
  if (!delta) return parts;
  const tail = parts[parts.length - 1];
  if (tail && tail.kind === "text") {
    const next = [...parts];
    next[next.length - 1] = { kind: "text", content: tail.content + delta };
    return next;
  }
  return [...parts, { kind: "text", content: delta }];
}

/**
 * Apply a `tool_call` event. Dedupes by id — the same tool call can
 * arrive twice if the server retries; the second arrival is a no-op.
 */
export function applyToolCallEvent(
  parts: AssistantMessagePart[],
  event: {
    id: string;
    name: string;
    serverLabel?: string;
  },
): AssistantMessagePart[] {
  if (parts.some((p) => p.kind === "tool_call" && p.id === event.id)) {
    return parts;
  }
  return [
    ...parts,
    {
      kind: "tool_call",
      id: event.id,
      name: event.name,
      status: "running",
      serverLabel: event.serverLabel,
    },
  ];
}

/**
 * Apply a `tool_result` event. Mutates the matching tool_call part in
 * place (immutably — returns a new array). Defensive: if there's no
 * matching tool_call (e.g. tool_result arrived without a prior
 * tool_call), the parts array is returned unchanged.
 */
export function applyToolResultEvent(
  parts: AssistantMessagePart[],
  event: {
    id: string;
    status?: "completed" | "failed";
    resultLabel?: string;
    serverLabel?: string;
    /**
     * agent_run runId extracted from the tool_result event. When present,
     * attached to the matching tool_call part so the chat thread renderer
     * can mount <InlineAgentRunCard runId={...} /> inline.
     */
    runId?: string;
  },
): AssistantMessagePart[] {
  let matched = false;
  const next = parts.map((p) => {
    if (p.kind === "tool_call" && p.id === event.id) {
      matched = true;
      return {
        ...p,
        status: event.status ?? ("completed" as const),
        resultLabel: event.resultLabel,
        serverLabel: event.serverLabel ?? p.serverLabel,
        // Only set runId when event carries one — never wipe an existing
        // runId on a follow-up tool_result (e.g. status correction).
        ...(event.runId ? { runId: event.runId } : {}),
      };
    }
    return p;
  });
  // If no match, return the original reference so React diffing skips
  // the message — avoids spurious re-renders on stray tool_result events.
  return matched ? next : parts;
}

/**
 * Best-effort hydration of an old message (persisted with only `content`
 * and `thoughtGroups`) into a parts array. Used when the renderer wants
 * a unified shape for both old and new messages. Mirrors the legacy
 * visual order (badges above markdown) rather than guessing chronology
 * we don't have. Returns `null` if there's nothing to hydrate — callers
 * should fall back to legacy rendering in that case.
 */
export function hydrateLegacyParts(input: {
  content: string;
  thoughtGroups?: ReadonlyArray<{
    toolCalls: ReadonlyArray<{
      id: string;
      name: string;
      status: "running" | "completed" | "failed";
      resultLabel?: string;
      serverLabel?: string;
    }>;
  }>;
}): AssistantMessagePart[] | null {
  const tools = (input.thoughtGroups ?? []).flatMap((g) => g.toolCalls);
  const hasContent = input.content.trim().length > 0;
  if (tools.length === 0 && !hasContent) return null;
  const parts: AssistantMessagePart[] = [];
  for (const tc of tools) {
    parts.push({
      kind: "tool_call",
      id: tc.id,
      name: tc.name,
      status: tc.status,
      resultLabel: tc.resultLabel,
      serverLabel: tc.serverLabel,
    });
  }
  if (hasContent) {
    parts.push({ kind: "text", content: input.content });
  }
  return parts;
}
