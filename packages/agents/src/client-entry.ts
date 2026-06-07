/**
 * Client-side entry point for @cinatra/agent-builder.
 * Safe to import in "use client" components — does NOT pull in server-only modules.
 */
export { ensureDefaultFieldRenderersRegistered } from "./register-default-renderers";

// Schema-driven field rendering — used by the inline AgenticRunPanel (both
// the run-detail page and the chat thread's InlineAgentRunCard wrapper).
export { SchemaFieldRenderer } from "./schema-field-renderer";
export { fieldRendererRegistry, RENDERER_NAMESPACE_RE } from "./field-renderer-registry";
export type {
  FieldRendererContext,
  FieldRendererProps,
  FieldRendererEntry,
  FieldRendererCondition,
  RendererMode,
  GmailSendAsAliasOption,
} from "./field-renderer-registry";

// AG-UI SSE subscription hook — consumed by the InlineAgentRunCard wrapper in
// the chat thread (and by AgenticRunPanel itself) to surface INTERRUPT events.
export { useAgUiRunStream } from "./use-ag-ui-run-stream";
export type {
  AgUiRunStreamOptions,
  InterruptContext,
  AgUiRunStreamResult,
} from "./use-ag-ui-run-stream";

// DispatchRenderer + PresentationHint are re-exported so the chat package can
// import the results-summary renderer without reaching into internal paths.
// Source path is ./result-renderers (the barrel at src/result-renderers/index.tsx).
// Both are "use client"-safe; result-renderers/index.tsx starts with "use client".
export { DispatchRenderer } from "./result-renderers";
export type { PresentationHint } from "./result-renderers";

// AgenticRunPanel is re-exported so the main chat thread
// (packages/chat/src/inline-agent-run-card.tsx) can render the same run-detail
// surface inline beneath an `agent_run` tool_result.
export { AgenticRunPanel } from "./agentic-run-panel";
// SerializedAgentRunMessage shape is also needed by the inline wrapper to
// type the GET /api/agents/runs/<runId> response without `as never` casts.
export type { SerializedAgentRunMessage } from "./agentic-run-panel";
// Chat prompt-window HITL gate descriptor types.
export type { ChatGateDescriptor, ChatGateField } from "./agentic-run-panel";
