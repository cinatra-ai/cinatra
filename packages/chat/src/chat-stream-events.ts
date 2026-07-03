// ---------------------------------------------------------------------------
// Chat streaming seam (cinatra#918 — split out of chat-page.tsx).
// ---------------------------------------------------------------------------
// Pure SSE-event parsing + application logic extracted from streamResponse's
// event loop. Each ChatGPT-mode applier is the EXACT body of the former
// inline `setMessages` functional updater, parameterized on the assistant
// message id — pure functions of `prev`, safe under React's
// replay-the-updater semantics (StrictMode double-invoke, batching). The
// round-separator flag is consumed by the CALLER in event-loop scope and
// passed in as a boolean (never mutated inside an updater) — see the
// long-standing comment preserved at applyTextDeltaToMessages.
//
// Slack mode buffers whole turns and reveals them atomically; the same event
// contract is applied to a SlackStreamBuffers struct instead of React state.
//
// The `parts` trace transitions delegate to the tested pure helpers in
// ./assistant-parts (applyTextDelta / applyToolCallEvent /
// applyToolResultEvent) exactly as the inline code did.

import {
  applyTextDelta,
  applyToolCallEvent,
  applyToolResultEvent,
  formatToolProgressStatus,
  hasVisibleStreamingText,
} from "./assistant-parts";
import type { UiCitation, UiMessage, UiThoughtGroup } from "./types";

// ---------------------------------------------------------------------------
// SSE block parsing
// ---------------------------------------------------------------------------

export type SseEvent = { evt: string; data: Record<string, unknown> };

/**
 * Parse one `\n\n`-delimited SSE block of the `event: <name>\ndata: <json>`
 * shape used by /api/chat. Returns null for non-matching blocks and blocks
 * whose data payload is not valid JSON (both were silently skipped inline).
 */
export function parseSseEventBlock(block: string): SseEvent | null {
  const m = block.match(/^event: (\w+)\ndata: ([\s\S]+)$/);
  if (!m) return null;
  const [, evt, raw] = m;
  try {
    return { evt, data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payload normalization helpers
// ---------------------------------------------------------------------------

export function extractErrorMessage(raw: string): string {
  // Try to parse JSON error responses from OpenAI or the API route.
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.error && typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON — use as-is.
  }

  const trimmed = raw.trim();
  if (!trimmed) return "Something went wrong. Please try again.";

  // If it looks like a raw HTTP error body, simplify it.
  if (trimmed.length > 300) {
    return "The request failed. Please try again in a moment.";
  }

  return trimmed;
}

/**
 * When the resolved tool is agent_run, parse the `result` JSON (the server
 * emits JSON.stringify({runId, status})) and return the runId so the caller
 * can pin it on the matching tool_call part (the renderer then mounts
 * <InlineAgentRunCard runId={...} /> inline). Defensive: any parse failure is
 * silent (undefined) — chat dispatch still renders the regular status line.
 */
export function extractAgentRunId(toolName: string, result: unknown): string | undefined {
  if (toolName !== "agent_run" || typeof result !== "string") return undefined;
  try {
    const parsed = JSON.parse(result) as { runId?: unknown };
    if (typeof parsed.runId === "string" && parsed.runId.length > 0) {
      return parsed.runId;
    }
  } catch {
    // No-op.
  }
  return undefined;
}

/** Normalize a raw `citations` event payload into the UiCitation shape. */
export function normalizeCitations(raw: unknown): UiCitation[] {
  const incoming = Array.isArray(raw) ? (raw as unknown[]) : [];
  return incoming
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map((c, i) => ({
      index: typeof c.index === "number" && isFinite(c.index) ? c.index : i + 1,
      title: typeof c.title === "string" ? c.title : "",
      url: typeof c.url === "string" ? c.url : "",
    }))
    .filter((c) => c.url.length > 0);
}

/** Merge + dedupe citations by url, preserving first-seen order. */
export function mergeCitations(existing: UiCitation[], incoming: UiCitation[]): UiCitation[] {
  const merged = [...existing, ...incoming];
  const seen = new Set<string>();
  return merged.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// ChatGPT-mode appliers — pure (prev) => next message-list transforms
// ---------------------------------------------------------------------------

/**
 * Apply a `text` delta to the streaming assistant message.
 *
 * `consumeRoundSeparator` is read-and-cleared by the caller HERE (event loop
 * scope), not inside the updater. React may invoke functional state updaters
 * multiple times (StrictMode dev double-invoke; automatic batching can replay
 * them) — mutating an outer-scope variable inside the updater is unsafe.
 * Consuming the flag in the SSE handler (which runs exactly once per event)
 * makes this applier a pure function of `prev`.
 */
export function applyTextDeltaToMessages(
  prev: UiMessage[],
  assistantId: string,
  delta: string,
  consumeRoundSeparator: boolean,
): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    const existing = msg.content;
    // A paragraph break is inserted when text resumes after a
    // tool-use round (signalled by thinking_end). Never insert
    // spaces between normal streaming chunks — providers split
    // tokens arbitrarily and adding spaces breaks markdown
    // formatting like **bold**.
    const separator =
      consumeRoundSeparator && existing.length > 0 && !/\s$/.test(existing)
        ? "\n\n"
        : "";
    const deltaWithSeparator = separator + delta;
    // Maintain the ordered `parts` trace via the pure helper so
    // behaviour matches the tested contract (assistant-parts.ts).
    const nextParts = applyTextDelta(msg.parts ?? [], deltaWithSeparator);
    const latestTextPart = nextParts.findLast((part) => part.kind === "text");
    const liveStatus = latestTextPart && hasVisibleStreamingText(latestTextPart.content)
      ? undefined
      : msg.liveStatus;
    return { ...msg, content: existing + deltaWithSeparator, parts: nextParts, liveStatus };
  });
}

export function applyThinkingStartToMessages(prev: UiMessage[], assistantId: string): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    if (msg.thoughtGroups && msg.thoughtGroups.length > 0) {
      return { ...msg, liveStatus: "Thinking" };
    }
    return { ...msg, thoughtGroups: [{ id: "main", toolCalls: [] }], liveStatus: "Thinking" };
  });
}

export function applyThinkingEndToMessages(
  prev: UiMessage[],
  assistantId: string,
  seconds: number,
): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    const group = msg.thoughtGroups?.[0];
    if (!group) return msg;
    return { ...msg, thoughtGroups: [{ ...group, thinkingSeconds: (group.thinkingSeconds ?? 0) + seconds }] };
  });
}

export function applyToolCallToMessages(
  prev: UiMessage[],
  assistantId: string,
  event: { id: string; name: string; serverLabel?: string },
): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    const group = msg.thoughtGroups?.[0] ?? { id: "main", toolCalls: [] };
    // Dedupe by id (defensive — server retry safety).
    if (group.toolCalls.some((tc) => tc.id === event.id)) return msg;
    // Maintain `parts` via the pure helper. Same dedupe contract
    // is enforced inside the helper.
    const nextParts = applyToolCallEvent(msg.parts ?? [], {
      id: event.id,
      name: event.name,
      serverLabel: event.serverLabel,
    });
    return {
      ...msg,
      thoughtGroups: [{ ...group, toolCalls: [...group.toolCalls, { id: event.id, name: event.name, status: "running" as const, serverLabel: event.serverLabel }] }],
      parts: nextParts,
      liveStatus: formatToolProgressStatus({ name: event.name, serverLabel: event.serverLabel }),
    };
  });
}

export function applyToolResultToMessages(
  prev: UiMessage[],
  assistantId: string,
  event: { id: string; resultLabel: string; serverLabel?: string; runId?: string },
): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    const group = msg.thoughtGroups?.[0];
    if (!group) return msg;
    // Apply via pure helper so behaviour matches the tested
    // contract (preserves existing serverLabel when the event
    // omits one; no-op when no matching tool_call exists).
    const nextParts = msg.parts
      ? applyToolResultEvent(msg.parts, {
          id: event.id,
          resultLabel: event.resultLabel,
          serverLabel: event.serverLabel,
          runId: event.runId,
        })
      : undefined;
    return {
      ...msg,
      thoughtGroups: [{
        ...group,
        toolCalls: group.toolCalls.map((tc) =>
          tc.id === event.id
            ? {
                ...tc,
                status: "completed" as const,
                resultLabel: event.resultLabel,
                // Preserve serverLabel when the event doesn't
                // supply one — matches the tested helper contract.
                serverLabel: event.serverLabel ?? tc.serverLabel,
              }
            : tc,
        ),
      }],
      ...(nextParts ? { parts: nextParts } : {}),
      liveStatus: "Reviewing tool results",
    };
  });
}

export function applyCitationsToMessages(
  prev: UiMessage[],
  assistantId: string,
  normalized: UiCitation[],
): UiMessage[] {
  return prev.map((msg) => {
    if (msg.id !== assistantId) return msg;
    return { ...msg, citations: mergeCitations(msg.citations ?? [], normalized) };
  });
}

export function applyErrorToMessages(
  prev: UiMessage[],
  assistantId: string,
  rawError: string,
): UiMessage[] {
  return prev.map((msg) =>
    msg.id === assistantId ? { ...msg, error: extractErrorMessage(rawError), errorRaw: rawError } : msg,
  );
}

// ---------------------------------------------------------------------------
// Slack-mode buffers — whole-turn accumulation, revealed atomically
// ---------------------------------------------------------------------------

export type SlackStreamBuffers = {
  text: string;
  thoughtGroups: UiThoughtGroup[];
  citations: UiCitation[];
  error: string;
};

export function createSlackBuffers(): SlackStreamBuffers {
  return { text: "", thoughtGroups: [], citations: [], error: "" };
}

export function appendSlackTextDelta(
  buf: SlackStreamBuffers,
  delta: string,
  consumeRoundSeparator: boolean,
): void {
  if (!delta) return;
  const separator =
    consumeRoundSeparator && buf.text.length > 0 && !/\s$/.test(buf.text)
      ? "\n\n"
      : "";
  buf.text += separator + delta;
}

export function applySlackThinkingStart(buf: SlackStreamBuffers): void {
  if (buf.thoughtGroups.length === 0) {
    buf.thoughtGroups.push({ id: "main", toolCalls: [] });
  }
}

export function applySlackThinkingEnd(buf: SlackStreamBuffers, seconds: number): void {
  const lastGroup = buf.thoughtGroups[buf.thoughtGroups.length - 1];
  if (lastGroup) {
    lastGroup.thinkingSeconds = (lastGroup.thinkingSeconds ?? 0) + seconds;
  }
}

export function applySlackToolCall(
  buf: SlackStreamBuffers,
  event: { id: string; name: string; serverLabel?: string },
): void {
  const lastGroup = buf.thoughtGroups[buf.thoughtGroups.length - 1] ?? { id: "main", toolCalls: [] };
  if (buf.thoughtGroups.length === 0) buf.thoughtGroups.push(lastGroup);
  if (!lastGroup.toolCalls.some((tc) => tc.id === event.id)) {
    lastGroup.toolCalls.push({ id: event.id, name: event.name, status: "running" as const, serverLabel: event.serverLabel });
  }
}

export function applySlackToolResult(
  buf: SlackStreamBuffers,
  event: { id: string; resultLabel: string; serverLabel?: string },
): void {
  const lastGroup = buf.thoughtGroups[buf.thoughtGroups.length - 1];
  if (!lastGroup) return;
  const tc = lastGroup.toolCalls.find((t) => t.id === event.id);
  if (!tc) return;
  tc.status = "completed";
  tc.resultLabel = event.resultLabel;
  // Preserve serverLabel when the event omits one — matches
  // the tested `applyToolResultEvent` helper contract and the
  // ChatGPT-mode branch above. Without this, external
  // connector badges (e.g. "WordPress · …") get relabelled
  // to generic "Tool · …" on completion in Slack mode.
  if (event.serverLabel !== undefined) tc.serverLabel = event.serverLabel;
}

export function applySlackCitations(buf: SlackStreamBuffers, normalized: UiCitation[]): void {
  buf.citations = mergeCitations(buf.citations, normalized);
}
