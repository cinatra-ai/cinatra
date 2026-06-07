// ---------------------------------------------------------------------------
// @cinatra-ai/agent-ui-protocol — public surface (tier-neutral)
//
// NO import "server-only" — only type exports and value constants.
// Server-only exports (AgUiAdapter class, publishAgUiEvent) live in server.ts.
// ---------------------------------------------------------------------------

export type { AgentUIAdapter } from "./adapter";

export type {
  AgUiEvent,
  AgUiEventType,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  StateSnapshotEvent,
  InterruptEvent,
  ResumeEvent,
  DataPartEvent,
} from "./events";

export { AG_UI_EVENT_TYPES } from "./events";

export { channelFor } from "./channel";

// ---------------------------------------------------------------------------
// A2UI v0.9 — type exports (tier-neutral, safe on client)
// ---------------------------------------------------------------------------

export type {
  A2UiMessage,
  A2UiMessageType,
  CreateSurfaceMessage,
  UpdateComponentsMessage,
  UpdateDataModelMessage,
  DeleteSurfaceMessage,
  ComponentDefinition,
} from "./a2ui-messages";

export { A2UI_MESSAGE_TYPES } from "./a2ui-messages";

// ---------------------------------------------------------------------------
// Gmail sender field whitelist (tier-neutral)
// Consumed by both the client renderer and the server-only schema enricher.
// ---------------------------------------------------------------------------
export {
  GMAIL_SENDER_FIELD_WHITELIST,
  normalizeGmailSenderFieldName,
} from "./gmail-sender-field-whitelist";
