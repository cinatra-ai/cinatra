// ---------------------------------------------------------------------------
// AG-UI event fixtures for the reducer test matrix (cinatra#1311).
// ---------------------------------------------------------------------------
// Hand-authored AG-UI event logs exercising happy-path, event-ordering,
// partial/streaming, error, and replay/resume cases. Kept plain (no wire codec)
// so the reducer's fold is tested against the S1 event union directly.

import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

export const THREAD_ID = "thread-1";
export const RUN_ID = "run-1";
export const MSG_ID = "msg-1";

/** A well-ordered turn: greeting text, one tool round, closing text. */
export const HAPPY_PATH: AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
  { type: "TEXT_MESSAGE_START", messageId: MSG_ID },
  { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "Let me check" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: " that." },
  { type: "TOOL_CALL_START", toolCallId: "tc-1", toolCallName: "web_search" },
  { type: "TOOL_CALL_END", toolCallId: "tc-1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "Here is the answer." },
  { type: "TEXT_MESSAGE_END", messageId: MSG_ID },
  { type: "RUN_FINISHED", threadId: THREAD_ID, runId: RUN_ID, status: "completed" },
];

/** An agent_run tool whose runId arrives as a DATA_PART (never on TOOL_CALL_END). */
export const AGENT_RUN_PIN: AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
  { type: "TOOL_CALL_START", toolCallId: "tc-run", toolCallName: "agent_run" },
  { type: "TOOL_CALL_END", toolCallId: "tc-run" },
  { type: "DATA_PART", data: { toolCallId: "tc-run", runId: "child-run-9" } },
];

/** Two DATA_PART citation payloads with an overlapping url (dedupe by url). */
export const CITATIONS: AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
  { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "See sources." },
  {
    type: "DATA_PART",
    data: {
      citations: [
        { index: 1, title: "A", url: "https://a.example" },
        { index: 2, title: "B", url: "https://b.example" },
      ],
    },
  },
  {
    type: "DATA_PART",
    data: {
      citations: [
        { index: 2, title: "B-dupe", url: "https://b.example" },
        { index: 3, title: "C", url: "https://c.example" },
      ],
    },
  },
];

/** A RUN_ERROR mid-stream after some text. */
export const ERROR_MIDSTREAM: AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
  { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "Working" },
  {
    type: "RUN_ERROR",
    threadId: THREAD_ID,
    runId: RUN_ID,
    message: '{"error":{"message":"upstream exploded"}}',
  },
];

/** An INTERRUPT then a matching RESUME. */
export const HITL: AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
  {
    type: "INTERRUPT",
    threadId: THREAD_ID,
    runId: RUN_ID,
    xRenderer: "@cinatra-ai/email-delivery-agent:send-confirmation",
    reviewTaskId: "rt-1",
    schema: {
      type: "object",
      required: ["recipient"],
      properties: {
        recipient: { type: "string", title: "Recipient" },
        cc: { type: "string", title: "CC" },
      },
    },
    values: { recipient: "a@example.com" },
  },
];
