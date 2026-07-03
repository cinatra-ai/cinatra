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

// ---------------------------------------------------------------------------
// Streaming-embed trimming + live progress/status helpers (cinatra#918)
// ---------------------------------------------------------------------------
// Moved unchanged from chat-page.tsx. These are needed on BOTH sides of the
// lazy message-view boundary (the stream event appliers compute liveStatus
// with them; the view renders status lines with them), so they live in this
// eager, dependency-light module — NOT in markdown-render.ts, which pulls
// marked/katex and must stay behind the lazy boundary. Typed structurally so
// this module keeps zero imports.

/** Minimal structural view of a tool call for label/status formatting. */
export type ToolCallLike = {
  name: string;
  serverLabel?: string;
};

/** Minimal structural view of a UI message for live-status derivation. */
export type StreamStatusMessage = {
  content: string;
  liveStatus?: string;
  parts?: AssistantMessagePart[];
  thoughtGroups?: Array<{
    id: string;
    thinkingSeconds?: number;
    toolCalls: Array<ToolCallLike & { status: "running" | "completed" | "failed" }>;
  }>;
};

/**
 * While an assistant message is streaming, the tail of the content may contain
 * an incomplete embed that hasn't been closed yet (e.g. `[chart:{"type":"bar"...`
 * with no closing `}]`). renderMarkdown would pass this raw text through to
 * the markdown renderer, causing a flash of JSON code.
 *
 * This trims any trailing incomplete embed prefix so the markdown renderer
 * never sees partial special tokens. Only used on the live streaming message.
 */
export function trimIncompleteEmbeds(text: string): string {
  // Each embed starts with one of these prefixes.
  const PREFIXES = ["[chart:", "[widget:", "[confirm-", "```mermaid"];
  let result = text;
  for (const prefix of PREFIXES) {
    const idx = result.lastIndexOf(prefix);
    if (idx === -1) continue;
    // Check whether the embed has been fully closed after this prefix.
    const tail = result.slice(idx);
    const isClosed =
      prefix === "```mermaid"
        ? tail.includes("```", prefix.length)     // fenced block needs closing ```
        : prefix === "[chart:"
          ? (() => {
              // Use the same brace-depth logic as detectCharts.
              const jsonStart = prefix.length;
              if (tail[jsonStart] !== "{") return true; // not a JSON chart, let it pass
              let depth = 0;
              for (let i = jsonStart; i < tail.length; i++) {
                if (tail[i] === "{") depth++;
                else if (tail[i] === "}") {
                  depth--;
                  if (depth === 0) return tail[i + 1] === "]";
                }
              }
              return false;
            })()
          : tail.includes("]");                    // widget/confirm just need closing ]
    if (!isClosed) {
      result = result.slice(0, idx);
    }
  }
  return result;
}

export function formatToolName(name: string) {
  const parts = name.split(".");
  if (parts.length < 2) {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Show "resource · action" (e.g., "Campaigns · List", "Gmail · Aliases list").
  const action = parts.pop()!;
  const resource = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
  const label = `${resource} · ${action}`.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return label;
}

export function formatToolCallLabel(tc: ToolCallLike) {
  if (tc.serverLabel && tc.serverLabel !== "cinatra") {
    const server = tc.serverLabel
      .replace(/^external-/, "")
      .replace(/-connector$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const action = tc.name
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `${server} · ${action}`;
  }

  return formatToolName(tc.name);
}

export function formatToolProgressStatus(tc: ToolCallLike) {
  const name = tc.name.toLowerCase();
  const label = formatToolCallLabel(tc);

  if (name === "agent_source_list") return "Loading agent sources";
  if (name === "agent_source_read") return "Reading agent source";
  if (name === "agent_source_write") return "Writing agent source";
  if (name === "agent_source_write_files") return "Writing agent package files";
  if (name === "agent_source_validate") return "Validating agent source";
  if (name === "agent_source_compile") return "Compiling agent source";
  if (name === "agent_source_publish") return "Publishing agent source";
  if (name.includes("web_search")) return "Searching the web";
  if (name.includes("extensions_search")) return "Searching extensions";
  if (name.includes("agent_run_messages_list")) return "Checking agent messages";
  if (name.includes("agent_run_get")) return "Checking agent run";
  if (name.includes("agent_run")) return "Starting agent run";
  if (name.includes("search")) return `Searching ${label}`;
  if (name.includes("list") || name.includes("get") || name.includes("read") || name.includes("fetch")) {
    return `Reading ${label}`;
  }

  return `Using ${label}`;
}

export function hasVisibleStreamingText(content: string) {
  return trimIncompleteEmbeds(content).replace(/\s+/g, "").length > 0;
}

export function getLatestAssistantPart(message: StreamStatusMessage) {
  const parts = message.parts;
  if (!parts || parts.length === 0) return null;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.kind === "text" && !hasVisibleStreamingText(part.content)) {
      continue;
    }
    return part;
  }

  return null;
}

export function getLiveProgressStatus(message: StreamStatusMessage) {
  if (message.liveStatus) return message.liveStatus;

  const latestPart = getLatestAssistantPart(message);
  if (latestPart?.kind === "tool_call" && latestPart.status === "running") {
    return formatToolProgressStatus(latestPart);
  }

  const group = message.thoughtGroups?.[message.thoughtGroups.length - 1];
  const runningTool = group?.toolCalls.findLast((tc) => tc.status === "running");

  if (runningTool) {
    return formatToolProgressStatus(runningTool);
  }

  if (group?.toolCalls.some((tc) => tc.status === "completed")) {
    return "Reviewing tool results";
  }

  if (hasVisibleStreamingText(message.content)) {
    return "Working on the next step";
  }

  return "Thinking";
}

export function shouldShowLiveProgressStatus(message: StreamStatusMessage) {
  if (message.liveStatus) return true;

  const latestPart = getLatestAssistantPart(message);
  if (latestPart) return latestPart.kind === "tool_call";
  return !hasVisibleStreamingText(message.content);
}
