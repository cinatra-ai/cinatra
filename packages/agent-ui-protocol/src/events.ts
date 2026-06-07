// ---------------------------------------------------------------------------
// AG-UI event types for @cinatra-ai/agent-ui-protocol
// Plain TypeScript types — no zod import, no server-only constraint.
// ---------------------------------------------------------------------------

export const AG_UI_EVENT_TYPES = [
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "STATE_SNAPSHOT",
  "INTERRUPT",
  "RESUME",
  "DATA_PART", // local extension for structured JSON payloads from A2A data parts
] as const;

export type AgUiEventType = (typeof AG_UI_EVENT_TYPES)[number];

type BaseAgUiEvent = {
  timestamp?: number;
};

export type RunStartedEvent = BaseAgUiEvent & {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
};

export type RunFinishedEvent = BaseAgUiEvent & {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  status?: "completed" | "stopped";
};

export type RunErrorEvent = BaseAgUiEvent & {
  type: "RUN_ERROR";
  threadId: string;
  runId: string;
  message: string;
};

export type TextMessageStartEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_START";
  messageId: string;
};

export type TextMessageContentEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
};

export type TextMessageEndEvent = BaseAgUiEvent & {
  type: "TEXT_MESSAGE_END";
  messageId: string;
};

export type ToolCallStartEvent = BaseAgUiEvent & {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
};

export type ToolCallEndEvent = BaseAgUiEvent & {
  type: "TOOL_CALL_END";
  toolCallId: string;
};

export type StateSnapshotEvent = BaseAgUiEvent & {
  type: "STATE_SNAPSHOT";
  snapshot: unknown;
};

export type InterruptEvent = BaseAgUiEvent & {
  type: "INTERRUPT";
  threadId: string;
  runId: string;
  /** JSON Schema describing the input the renderer needs. */
  schema: Record<string, unknown>;
  /** Namespaced renderer ID, e.g. "@cinatra-ai/email-delivery-agent:send-confirmation". */
  xRenderer: string;
  /**
   * Current field values pre-populated for the renderer. Empty object when none.
   *
   * May optionally include a ``presentation`` key whose value is a
   * ``PresentationHint``-shaped object (discriminated union: ``contacts_table`` |
   * ``card_list`` | ``text_sections`` | ``tool_call_summary``; see
   * ``packages/agent-builder/src/result-renderers``). When present, the A2UI
   * adapter and the frontend HITL renderer both route through
   * ``translateHintToA2UiMessages`` / ``DispatchRenderer`` instead of the
   * per-xRenderer dispatch table. Consumers narrow locally with
   * ``(values as { presentation?: PresentationHint }).presentation`` and also
   * verify ``typeof presentation.type === "string"`` to reject arrays and
   * shape-less objects.
   *
   * NOTE: ``PresentationHint`` is intentionally NOT imported here — this module
   * is plain-types (no zod, no server-only, no cross-package type dependency).
   * Keeping the field as ``Record<string, unknown>`` preserves that constraint.
   */
  values: Record<string, unknown>;
  /** Opaque identifier the client passes back on RESUME to route approveReviewTask. */
  reviewTaskId: string;
  /**
   * Setup-field name the interrupt is gated on. When present, the UI approval
   * flow forwards it back to `approveReviewTaskInternal` as the `fieldName`
   * argument so the langgraph path can merge into `agent_runs.inputParams`
   * WITHOUT re-reading `planned_action.provenance`. Optional — absent for legacy
   * paths.
   */
  fieldName?: string;
};

export type ResumeEvent = BaseAgUiEvent & {
  type: "RESUME";
  threadId: string;
  runId: string;
  /** reviewTaskId from the paired INTERRUPT event. Optional — not required by the client reducer. */
  reviewTaskId?: string;
};

/**
 * Local extension carrying a single structured JSON payload emitted when an
 * external A2A artifact-update contains a `{ kind: "data", data }` part.
 * Mirrors the INTERRUPT/RESUME pattern: this is NOT in the upstream AG-UI spec
 * (which uses CUSTOM for arbitrary payloads) but is the established Cinatra
 * extension idiom. Consumers narrow `data` with `typeof === "object" &&
 * !Array.isArray` before using.
 */
export type DataPartEvent = BaseAgUiEvent & {
  type: "DATA_PART";
  /** Structured JSON payload from an A2A artifact part with `kind: "data"`. */
  data: Record<string, unknown>;
  /** Zero-based index of the part within its source artifact. Optional — the bridge emits it for ordering. */
  partIndex?: number;
};

export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | StateSnapshotEvent
  | InterruptEvent
  | ResumeEvent
  | DataPartEvent; // local DATA_PART extension
