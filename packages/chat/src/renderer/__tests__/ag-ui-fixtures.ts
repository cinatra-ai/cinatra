// ---------------------------------------------------------------------------
// AG-UI event fixtures for the reducer test matrix (cinatra#1311).
// Small typed builders + named event streams covering happy-path, tool rounds,
// interleaving, partial/streaming, error, and replay/snapshot scenarios.
// ---------------------------------------------------------------------------

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

const THREAD = "thread-1";
const RUN = "run-1";

export const runStarted = (runId = RUN, threadId = THREAD): AgUiEvent => ({
  type: "RUN_STARTED",
  threadId,
  runId,
});

export const runFinished = (runId = RUN, threadId = THREAD): AgUiEvent => ({
  type: "RUN_FINISHED",
  threadId,
  runId,
  status: "completed",
});

export const runError = (message: string, runId = RUN, threadId = THREAD): AgUiEvent => ({
  type: "RUN_ERROR",
  threadId,
  runId,
  message,
});

export const textStart = (messageId: string): AgUiEvent => ({
  type: "TEXT_MESSAGE_START",
  messageId,
});

export const textDelta = (messageId: string, delta: string): AgUiEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId,
  delta,
});

export const textEnd = (messageId: string): AgUiEvent => ({
  type: "TEXT_MESSAGE_END",
  messageId,
});

export const toolStart = (toolCallId: string, toolCallName: string): AgUiEvent => ({
  type: "TOOL_CALL_START",
  toolCallId,
  toolCallName,
});

export const toolEnd = (toolCallId: string): AgUiEvent => ({
  type: "TOOL_CALL_END",
  toolCallId,
});

export const interrupt = (over: Partial<Extract<AgUiEvent, { type: "INTERRUPT" }>> = {}): AgUiEvent => ({
  type: "INTERRUPT",
  threadId: THREAD,
  runId: RUN,
  schema: { type: "object", properties: { confirm: { type: "boolean" } } },
  xRenderer: "@cinatra-ai/email-agent:send-confirmation",
  values: {},
  reviewTaskId: "rt-1",
  ...over,
});

export const resume = (): AgUiEvent => ({
  type: "RESUME",
  threadId: THREAD,
  runId: RUN,
  reviewTaskId: "rt-1",
});

export const dataPart = (
  data: Record<string, unknown>,
  partIndex?: number,
): AgUiEvent => ({
  type: "DATA_PART",
  data,
  ...(partIndex !== undefined ? { partIndex } : {}),
});

export const agentRunDataPart = (toolCallId: string, runId: string, partIndex?: number): AgUiEvent =>
  dataPart({ kind: "agent_run", toolCallId, runId }, partIndex);

export const citationsDataPart = (
  citations: Array<{ index?: number; title?: string; url: string }>,
  partIndex?: number,
): AgUiEvent => dataPart({ kind: "citations", citations }, partIndex);

// ── Named streams ────────────────────────────────────────────────────────────

/** Plain text turn: start → 2 deltas → end → finished. */
export const HAPPY_TEXT: AgUiEvent[] = [
  runStarted(),
  textStart("m1"),
  textDelta("m1", "Hello"),
  textDelta("m1", " world"),
  textEnd("m1"),
  runFinished(),
];

/** One tool round then a text answer (round separator expected). */
export const TOOL_THEN_TEXT: AgUiEvent[] = [
  runStarted(),
  textStart("m1"),
  textDelta("m1", "Let me check."),
  textEnd("m1"),
  toolStart("t1", "gmail.messages.list"),
  toolEnd("t1"),
  textStart("m2"),
  textDelta("m2", "You have 3 messages."),
  textEnd("m2"),
  runFinished(),
];

/** Agent-run tool with the runId pinned via DATA_PART (never TOOL_CALL_END). */
export const AGENT_RUN: AgUiEvent[] = [
  runStarted(),
  toolStart("t1", "agent_run"),
  toolEnd("t1"),
  agentRunDataPart("t1", "agent-run-99", 0),
  textStart("m1"),
  textDelta("m1", "Started the agent."),
  textEnd("m1"),
  runFinished(),
];

/** Citations arrive as a DATA_PART. */
export const WITH_CITATIONS: AgUiEvent[] = [
  runStarted(),
  textStart("m1"),
  textDelta("m1", "See sources."),
  textEnd("m1"),
  citationsDataPart(
    [
      { title: "A", url: "https://a.example/x" },
      { title: "B", url: "https://b.example/y" },
    ],
    0,
  ),
  runFinished(),
];

/** HITL interrupt then resume. */
export const HITL: AgUiEvent[] = [
  runStarted(),
  toolStart("t1", "agent_run"),
  toolEnd("t1"),
  interrupt(),
  resume(),
  textStart("m1"),
  textDelta("m1", "Done."),
  textEnd("m1"),
  runFinished(),
];

/** Error mid-stream (after a partial text delta, before end). */
export const ERROR_MIDSTREAM: AgUiEvent[] = [
  runStarted(),
  textStart("m1"),
  textDelta("m1", "Partial answer"),
  runError("The model call failed."),
];

/** A live stream stopped mid-embed (incomplete chart) — no TEXT_MESSAGE_END. */
export const PARTIAL_EMBED: AgUiEvent[] = [
  runStarted(),
  textStart("m1"),
  textDelta("m1", "Chart: "),
  textDelta("m1", '[chart:{"type":"bar"'),
];
